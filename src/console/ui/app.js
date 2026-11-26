// Turnout console: polls /api/state, streams /api/traffic onto the map, and runs the two human-confirmed
// actions, plus the demo controls (simulated visitors, swing back / forward) that judge mode also runs. Every string
// from the server goes in through textContent.
import * as F from './format.js';
import { TrafficMap } from './map.js';
import { loadSignin, READONLY, setupMenu, setVersions, signinBox, viewLink } from './menu.js';
import * as M from './demo-model.js';
import { createTour } from './tour.js';
import { CONSOLE_STOPS, stopsFor } from './tour-stops.js';
import { setupTry } from './try.js';
import { setupMode } from './mode.js';

const POLL_MS = 5000;
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

// The per-boot token the server put in the page. Every /api/* call carries it; without it the server refuses.
const TOKEN = document.querySelector('meta[name="turnout-console"]')?.getAttribute('content') ?? '';
const TOKEN_HEADER = 'x-turnout-console';

// Server mode's public copy of this page (/judge/console) is read-only: its API lives under /judge/api/ (turnout-base)
// and answers reads only; every button that changes something is off there.
const BASE = document.querySelector('meta[name="turnout-base"]')?.getAttribute('content') ?? '';
if (READONLY) document.body.classList.add('is-readonly');

/** fetch() for the console API, with the token header added. */
function api(path, init = {}) {
  return fetch(BASE + path, { ...init, headers: { ...(init.headers ?? {}), [TOKEN_HEADER]: TOKEN } });
}

/** Small element builder; strings become text nodes, never HTML. */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'vars') for (const [name, value] of Object.entries(v)) node.style.setProperty(name, value);
    else if (k.startsWith('data-') || k.startsWith('aria-') || k === 'role' || k === 'scope' || k === 'for') node.setAttribute(k, v === true ? '' : String(v));
    else node[k] = v;
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtTime = (ms) => (Number.isFinite(ms) ? timeFmt.format(ms) : '—');
const fmtDateTime = (ms) => (Number.isFinite(ms) ? dateTimeFmt.format(ms) : '—');

const app = {
  state: null,
  lastOk: 0,
  error: null,
  choice: null, // the human's pick for Ship, when it differs from Flagsmith's
  busy: false,
  prevEvents: null,
  eventsDelta: 0,
  live: {}, // per-variant traffic since the last /api/state, so counters move between polls
  suggestions: new Map(), // goal suggestions from the live feed (format.js noteSuggestion)
  timer: 0,
  feed: 'pending',
  feedRetryAt: 0,
  choiceKeys: '',
};

// ---- traffic map ---------------------------------------------------------------------------------------------

const motion = matchMedia('(prefers-reduced-motion: reduce)');
const map = new TrafficMap($('map'), {
  reducedMotion: motion.matches,
  onSampling: (received, drawn) => {
    const text = F.samplingLabel(received, drawn);
    if ($('sampling').textContent !== text) $('sampling').textContent = text;
  },
});
motion.addEventListener('change', (e) => {
  map.setReducedMotion(e.matches);
  renderTrafficNote();
});

let countsQueued = false;
function queueCounts() {
  if (countsQueued) return;
  countsQueued = true;
  requestAnimationFrame(() => {
    countsQueued = false;
    renderCounts();
  });
}

function renderCounts() {
  const base = app.state?.traffic?.byVariant ?? {};
  const merged = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(app.live)])) {
    const a = base[key] ?? {};
    const b = app.live[key] ?? {};
    merged[key] = {
      requests: (a.requests ?? 0) + (b.requests ?? 0),
      pages: (a.pages ?? 0) + (b.pages ?? 0),
      conversions: (a.conversions ?? 0) + (b.conversions ?? 0),
    };
  }
  map.setCounts(merged);
}

function onTraffic(ev) {
  if (!ev || typeof ev.variant !== 'string') return;
  const c = (app.live[ev.variant] ??= { requests: 0, pages: 0, conversions: 0 });
  c.requests++;
  if (ev.document) c.pages++;
  if (ev.converted) c.conversions++;
  if (F.noteSuggestion(app.suggestions, ev)) queueSuggestions();
  map.spawn(ev);
  queueCounts();
}

let feedBackoff = 1000;
function connectFeed() {
  const source = new EventSource(`${BASE}/api/traffic?token=${encodeURIComponent(TOKEN)}`); // EventSource can't set headers
  source.onopen = () => {
    feedBackoff = 1000;
    app.feed = 'live';
    renderConnection();
  };
  source.onmessage = (m) => {
    try {
      onTraffic(JSON.parse(m.data));
    } catch {
      /* ignore malformed lines */
    }
  };
  source.onerror = () => {
    source.close();
    app.feed = 'retrying';
    app.feedRetryAt = Date.now() + feedBackoff;
    renderConnection();
    setTimeout(connectFeed, feedBackoff);
    feedBackoff = Math.min(feedBackoff * 2, 15000);
  };
}

function renderTrafficNote() {
  const notes = [];
  if (motion.matches) notes.push('Reduced motion: no moving dots; platforms flash as requests arrive.');
  if (app.state && !app.state.traffic) notes.push("Counters unavailable: the proxy's feed didn't answer.");
  $('traffic-note').textContent = notes.join(' ');
}

// ---- state ---------------------------------------------------------------------------------------------------

async function loadState() {
  try {
    const res = await api('/api/state', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    const body = await res.json().catch(() => null);
    if (res.status === 403) {
      const err = new Error('the console server restarted; reload this page');
      err.kind = 'token';
      throw err;
    }
    if (!res.ok || !body?.experiment) {
      const err = new Error(body?.error || `the console answered HTTP ${res.status}`);
      err.kind = 'flagsmith';
      throw err;
    }
    if (app.state?.events && body.events) {
      const d = body.events.accepted - app.state.events.accepted;
      app.eventsDelta = d > 0 ? d : 0;
    }
    app.state = body;
    app.lastOk = Date.now();
    app.error = null;
    app.live = {};
    render();
  } catch (err) {
    app.error = err;
    renderConnection();
    renderBanner();
    if (!app.state) {
      $('map').querySelector('.map-empty')?.replaceChildren("Can't load the experiment yet. Retrying every 5 s.");
      $('exp-name').textContent = 'Experiment unavailable';
      $('winner-headline').textContent = 'Waiting for Flagsmith…';
    }
  }
}

function schedule() {
  clearTimeout(app.timer);
  app.timer = setTimeout(async () => {
    await Promise.all([loadState(), demo.timer ? null : loadDemoJob()]); // a job started in judge mode shows here too
    schedule();
  }, POLL_MS);
}

async function refreshNow() {
  await loadState();
  schedule();
}

// ---- the first card: open your site, the goal, and requests that could become one -----------------------------
function renderSite(s) {
  const card = $('site');
  if (!s.site) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  if (s.site.simulated) {
    $('site-title').textContent = 'Simulated visitors';
    $('site-open').hidden = true;
    const goalLine = $('site-goal');
    goalLine.textContent = 'Pretend visitors, counted in a separate Flagsmith environment: never mixed with real ones.';
    $('site-flagsmith').href = s.site.dashboardUrl;
    return;
  }
  $('site-open').href = s.site.url;
  $('site-open').textContent = `Open your site: be a visitor (${s.site.url.replace(/^https?:\/\//, '')})`;
  $('site-flagsmith').href = s.site.dashboardUrl;
  const goal = $('site-goal');
  goal.textContent = '';
  if (s.site.goal) {
    goal.append('Goal: ');
    const b = document.createElement('strong');
    b.textContent = s.site.goal;
    goal.append(b, '. Page speed and server errors are guardrails.');
  } else {
    goal.append('No goal yet: each version is judged on ');
    const b = document.createElement('strong');
    b.textContent = 'page speed';
    goal.append(b, ', with server errors as the guardrail. Use your site, and requests that could count as success appear below.');
  }
  renderSuggestions(s);
}

let suggestTimer = 0;
function queueSuggestions() {
  if (suggestTimer) return;
  suggestTimer = setTimeout(() => {
    suggestTimer = 0;
    if (app.state) renderSuggestions(app.state);
  }, 1000);
}

function renderSuggestions(s) {
  const top = F.topSuggestions(app.suggestions, 5);
  const box = $('site-suggest');
  box.hidden = !s.site || top.length === 0;
  const list = $('suggest-list');
  list.replaceChildren(
    ...top.map((t) => {
      const li = document.createElement('li');
      const code = document.createElement('code');
      code.textContent = t.key;
      const count = document.createElement('span');
      count.className = 'suggest-count';
      count.textContent = `${F.formatInt(t.count)} seen`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-small';
      btn.textContent = 'Use as goal';
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(t.flag);
          btn.textContent = `Copied: ${t.flag}`;
        } catch {
          btn.textContent = `Add ${t.flag} to your compare command`;
        }
      });
      li.append(code, count, btn);
      return li;
    }),
  );
}

// ---- new comparison: the form writes the command -------------------------------------------------------------------
function setupNewForm() {
  const out = () => {
    const r = F.compareCommand({ a: $('new-a').value, b: $('new-b').value, more: $('new-more').value, goal: $('new-goal').value, split: $('new-split').value });
    $('new-error').hidden = !r.error || (!$('new-a').value && !$('new-b').value);
    $('new-error').textContent = r.error ?? '';
    $('new-command').textContent = r.command ?? 'turnout compare <current> <new>';
    $('new-copy').disabled = !r.command;
  };
  $('new-form').addEventListener('input', out);
  $('new-form').addEventListener('submit', (e) => e.preventDefault());
  $('new-copy').addEventListener('click', async () => {
    const text = $('new-command').textContent;
    try {
      await navigator.clipboard.writeText(text);
      $('new-copy').textContent = 'Copied';
    } catch {
      $('new-copy').textContent = 'Select and copy it';
    }
    setTimeout(() => ($('new-copy').textContent = 'Copy'), 2000);
  });
  out();
}
setupNewForm();

/** The goals seen so far, offered in the form's goal box (with the status that counts them). */
function renderGoalOptions() {
  const list = $('new-goals');
  const top = F.topSuggestions(app.suggestions, 8);
  const sig = JSON.stringify(top.map((t) => t.flag));
  if (list.dataset.sig === sig) return;
  list.dataset.sig = sig;
  list.replaceChildren(...top.map((t) => Object.assign(document.createElement('option'), { value: t.flag.replace(/^--goal "|"$/g, '') })));
}

function render() {
  const s = app.state;
  if (!s) return;
  renderSite(s);
  renderGoalOptions();
  renderHeader(s);
  renderMap(s);
  renderMapMode(s);
  renderResults(s);
  renderActions(s);
  renderSnapshots(s);
  renderSidings(s);
  renderSwingBack(s);
  renderConnection();
  renderBanner();
}

// ---- the traffic card: previews before traffic, the map once shoppers flow -------------------------------------
// Before a test has traffic the card shows each version, live (as judge mode does); once requests flow it shows the
// traffic map. The switch overrides that until the page reloads.
const mapView = { choice: null, framesKey: '' };
/** One version on its own: its own address (Try it), or the proxy's view link. Never counted either way. */
function previewOf(site, label) {
  return site?.previews?.[label] ?? viewLink(site?.url, label);
}
function renderMapMode(s) {
  const variants = s.experiment ? F.built(s, F.variantList(s.experiment)) : [];
  const flowing = Object.values(s.traffic?.byVariant ?? {}).some((v) => v.requests > 0) || flow.running;
  const auto = s.experiment?.status === 'running' && flowing ? 'traffic' : 'previews';
  const mode = s.site?.url && variants.length ? (mapView.choice ?? auto) : 'traffic';
  $('map-show-previews').setAttribute('aria-pressed', String(mode === 'previews'));
  $('map-show-traffic').setAttribute('aria-pressed', String(mode === 'traffic'));
  $('map').hidden = mode !== 'traffic';
  for (const node of document.querySelectorAll('#traffic .legend')) node.hidden = mode !== 'traffic';
  $('traffic-title').textContent = mode === 'traffic' ? 'Traffic map' : 'The versions';
  $('traffic-sub').hidden = mode !== 'traffic';
  const box = $('map-previews');
  box.hidden = mode !== 'previews';
  if (mode !== 'previews') return;
  const key = JSON.stringify([s.site?.url, variants.map((v) => v.label), F.shownKey()]);
  if (mapView.framesKey === key) return;
  mapView.framesKey = key;
  box.style.setProperty('--n', String(variants.length));
  box.replaceChildren(...variants.map((v, i) => h('a', { class: 'map-preview', href: previewOf(s.site, v.label), target: '_blank', rel: 'noopener', title: `Open ${F.shown(v.label)} on its own (never counted)`, vars: { '--c': v.color } },
    h('span', { class: 'map-preview-name' }, h('span', { class: 'you-chip', vars: { '--c': v.color } }, LETTERS[i] ?? '?'), F.shown(v.label), h('span', { class: 'v-key' }, v.isControl ? ' current' : ' new')),
    h('span', { class: 'map-preview-frame' }, h('iframe', { src: previewOf(s.site, v.label), title: `Preview of ${F.shown(v.label)}`, tabIndex: -1, onload: fitMapPreviews })))));
  requestAnimationFrame(fitMapPreviews);
}
// Each preview is a 1,000 px wide page scaled to its tile, as tall as the tile at that scale.
function fitMapPreviews() {
  for (const box of document.querySelectorAll('.map-preview-frame')) {
    const f = box.querySelector('iframe');
    if (!f || !box.clientWidth) continue;
    const scale = box.clientWidth / 1000;
    f.style.transform = `scale(${scale.toFixed(4)})`;
    f.style.height = `${Math.ceil(box.clientHeight / scale)}px`;
  }
}
if (typeof ResizeObserver === 'function') new ResizeObserver(fitMapPreviews).observe($('map-previews'));
$('map-show-previews').addEventListener('click', () => {
  mapView.choice = 'previews';
  if (app.state) renderMapMode(app.state);
});
$('map-show-traffic').addEventListener('click', () => {
  mapView.choice = 'traffic';
  if (app.state) renderMapMode(app.state);
});

function renderBanner() {
  const banner = $('banner');
  if (!app.error) {
    banner.hidden = true;
    banner.textContent = '';
    return;
  }
  const network = app.error.name === 'TypeError' || app.error.name === 'TimeoutError' || app.error.name === 'AbortError';
  const what = network
    ? "Can't reach the Turnout console server."
    : app.error.kind === 'token'
      ? 'The console server restarted. Reload this page to keep using it.'
      : `Flagsmith didn't answer (${app.error.message}).`;
  const since = app.lastOk ? ` Showing the last good state, from ${fmtTime(app.lastOk)}.` : '';
  banner.textContent = `${what}${since} Retrying every 5 s.`;
  banner.hidden = false;
}

function renderConnection() {
  const st = $('conn-state');
  const ok = !app.error && app.lastOk;
  st.dataset.state = app.error ? 'error' : ok ? 'ok' : 'pending';
  st.querySelector('.conn-text').textContent = app.error
    ? 'Flagsmith: unreachable'
    : ok
      ? `Flagsmith: updated ${F.formatAgo(app.lastOk)}`
      : 'Flagsmith: connecting…';

  const fd = $('conn-feed');
  fd.dataset.state = app.feed === 'live' ? 'ok' : app.feed === 'retrying' ? 'error' : 'pending';
  const wait = Math.max(0, Math.ceil((app.feedRetryAt - Date.now()) / 1000));
  fd.querySelector('.conn-text').textContent =
    app.feed === 'live' ? 'Live feed: connected' : app.feed === 'retrying' ? `Live feed: down, retry in ${wait} s` : 'Live feed: connecting…';
}

// ---- header --------------------------------------------------------------------------------------------------

function renderHeader(s) {
  const e = s.experiment;
  $('exp-name').textContent = F.shownText(e.name);
  const pill = $('exp-status');
  pill.textContent = F.statusLabel(e.status);
  pill.dataset.status = e.status;
  $('exp-hypothesis').textContent = F.shownText(e.hypothesis || '—');
  const started = F.parseTime(e.started_at);
  const ended = F.parseTime(e.ended_at);
  let when = Number.isFinite(started) ? `${fmtDateTime(started)} (${F.formatAgo(started)})` : 'not started';
  if (Number.isFinite(ended)) when += ` · ended ${fmtDateTime(ended)}`;
  $('exp-started').textContent = when;
  $('flag-name').textContent = e.feature?.name ?? '—';
  const r = F.routing(e, s.flag);
  $('flag-routing').textContent = r.summary + (r.flagEnabled === false ? ' (flag off: control)' : '');
  document.title = `${F.statusLabel(e.status)} · ${e.name} · Turnout`;
}

// ---- map -----------------------------------------------------------------------------------------------------

function renderMap(s) {
  const e = s.experiment;
  const variants = F.built(s, F.variantList(e));
  const r = F.routing(e, s.flag);
  map.setLayout(variants, r.shares, e.feature?.name ?? '');
  $('map').removeAttribute('aria-busy');
  renderCounts();
  $('traffic-window').textContent = String(s.traffic?.windowSeconds ?? 60);
  const badge = $('merged-badge');
  if (r.soleKey && variants.length > 1) {
    const v = variants.find((x) => x.key === r.soleKey);
    badge.textContent = `Tracks merged · everyone on ${F.shown(v?.label ?? r.soleKey)}`;
    badge.style.setProperty('--c', v?.color ?? 'currentColor');
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
  renderTrafficNote();
}

// ---- results -------------------------------------------------------------------------------------------------

function renderResults(s) {
  const e = s.experiment;
  const res = s.results;

  const asof = $('results-asof');
  const parts = [];
  if (!res) parts.push("Flagsmith hasn't computed results for this experiment yet.");
  else {
    const at = F.parseTime(res.as_of);
    parts.push(Number.isFinite(at) ? `Computed ${fmtTime(at)} (${F.formatAgo(at)})${res.is_final ? ', final' : ''}.` : 'Not computed yet.');
    const req = F.parseTime(res.refresh_requested_at);
    if (Number.isFinite(req) && (!Number.isFinite(at) || req > at)) parts.push(`Refresh requested ${F.formatAgo(req)}.`);
    const errAt = F.parseTime(res.last_error_at);
    if (Number.isFinite(errAt)) parts.push(`Flagsmith reported a computation error ${F.formatAgo(errAt)}.`);
  }
  asof.textContent = parts.join(' ');

  const w = F.winnerText(e, s.winner, { ledger: s.ledger, recommendation: s.recommendation });
  $('winner').dataset.tone = w.tone;
  // The headline takes the colour of the version it names (the one shipped, or the one to ship), never simply the
  // goal leader's: "Shipped: everyone gets shop:1.5" in shop:1.6's orange read as the wrong version.
  const winnerVariant = F.variantList(e).find((v) => (w.release ? v.label === w.release : v.key === w.variant)) ?? null;
  // Only a good result takes the release's colour; a lead that is still inconclusive stays neutral.
  if (w.tone === 'good' && winnerVariant) $('winner').style.setProperty('--c', winnerVariant.color);
  else $('winner').style.removeProperty('--c');
  $('winner-headline').textContent = w.headline;
  $('winner-detail').textContent = w.detail;

  const assessed = (e.metrics ?? []).map((m, i) => F.assessMetric(e, m, res, i));
  $('metrics').replaceChildren(assessed.length ? metricsTable(assessed) : h('p', { class: 'empty' }, 'This experiment has no metrics.'));

  $('srm').textContent = F.srmText(res);
  $('srm').hidden = /not computed/.test($('srm').textContent); // nothing to say yet: no line
  $('events').textContent = F.eventsText(s.events);
  const delta = $('events-delta');
  delta.textContent = s.events && app.eventsDelta > 0 ? `+${F.formatInt(app.eventsDelta)} in the last poll` : '';
  if (app.eventsDelta > 0 && !motion.matches) {
    delta.classList.remove('bump');
    void delta.offsetWidth;
    delta.classList.add('bump');
  }
}

// Flagsmith's results in one table: a row per metric, a column per release. Each treatment's cell carries Flagsmith's
// word on it (winning / losing / inconclusive) and its chance to win against control, exactly as returned.
const ROLE_NAME = { goal: 'Goal', secondary: 'Secondary', guardrail: 'Guardrail' };
function metricsTable(metrics) {
  const hasData = (key) => metrics.some((m) => m.rows.some((r) => r.key === key && r.n != null));
  const any = metrics[0].rows.some((r) => r.key !== 'control' && hasData(r.key));
  // Your app's console: only the versions you built (no empty C column in an A/B test).
  const kept = new Set(F.built(app.state, metrics[0].rows.map((r) => ({ ...r, isControl: r.key === 'control' }))).map((r) => r.key));
  const columns = metrics[0].rows.filter((r) => kept.has(r.key) && (r.key === 'control' || !any || hasData(r.key)));
  metrics = metrics.map((m) => ({ ...m, rows: m.rows.filter((r) => columns.some((c) => c.key === r.key)) }));
  return h(
    'table',
    { class: 'mx' },
    h('caption', { class: 'sr-only' }, "Flagsmith's results per metric and release"),
    h('thead', {}, h('tr', {},
      h('th', { scope: 'col' }, 'Metric'),
      columns.map((c) => h('th', { scope: 'col', vars: { '--c': c.color } }, h('span', { class: 'swatch', 'aria-hidden': 'true' }), h('span', { class: 'v-label' }, F.shown(c.label)), ' ', h('span', { class: 'v-key' }, c.key))))),
    h('tbody', {}, metrics.map((m) => h('tr', { 'data-role': m.role, 'data-state': m.state },
      h('th', { scope: 'row', title: m.name }, h('span', { class: 'mx-name' }, F.metricName(m.name)), h('span', { class: 'mx-meta' }, h('span', { class: `mx-role mx-role-${m.role}` }, ROLE_NAME[m.role] ?? m.role), ` · ${m.direction}`)),
      m.rows.map((r) => {
        const t = m.treatments.find((x) => x.key === r.key);
        const call = !t || m.state !== 'ready'
          ? null
          : t.collecting
            ? h('span', { class: 'mx-call' }, 'collecting')
            : h('span', { class: 'mx-call', 'data-tone': t.verdict.tone, title: `Lift ${F.formatLift(t.lift)} · credible interval ${F.formatInterval(t.ciLow, t.ciHigh)}` }, `${t.verdict.word} · ${F.formatChance(t.chance)}`);
        return h('td', { 'data-tone': t && !t.collecting && m.state === 'ready' ? t.verdict.tone : null },
          h('span', { class: 'mx-value' }, r.n == null ? '—' : r.display),
          r.n == null ? null : h('span', { class: 'mx-n' }, ` n ${F.formatInt(r.n)}`),
          call);
      }),
    ))),
    metrics.some((m) => m.state !== 'ready')
      ? h('tfoot', {}, h('tr', {}, h('td', { colSpan: columns.length + 1 },
          metrics.every((m) => m.state === 'collecting')
            ? "Collecting data: Flagsmith shows numbers once enough visitors have come through (at least 50 per release)."
            : metrics.filter((m) => m.state !== 'ready').map((m) => `${F.metricName(m.name)}: ${m.note || m.state}`).join(' · '))))
      : null,
  );
}

$('refresh-btn').addEventListener('click', async () => {
  const btn = /** @type {HTMLButtonElement} */ ($('refresh-btn'));
  const status = $('refresh-status');
  btn.disabled = true;
  status.dataset.tone = 'neutral';
  status.textContent = 'Asking Flagsmith to recompute…';
  try {
    const res = await api('/api/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) {
      status.dataset.tone = 'good';
      status.textContent = 'Refresh requested. Flagsmith recomputes in the background; new numbers appear here when it has.';
    } else if (body.heldBack) {
      status.dataset.tone = 'neutral';
      status.textContent = body.reason;
    } else {
      status.dataset.tone = 'bad';
      status.textContent = `Flagsmith refused the refresh: ${F.refreshReason(body.reason ?? body.error ?? `HTTP ${res.status}`)} (Flagsmith allows one refresh every 5 minutes.)`;
    }
  } catch {
    status.dataset.tone = 'bad';
    status.textContent = "Couldn't reach the console server to request a refresh.";
  } finally {
    btn.disabled = false;
    refreshNow();
  }
});

// ---- actions -------------------------------------------------------------------------------------------------

// The release Turnout suggests shipping: its recommendation when that is to ship (in an A/B/C test, the best release
// that is clearly better AND passes every safety check), else Flagsmith's best on the goal. Before this, the console
// pre-selected the best on the goal even when it failed a safety check, while judge mode shipped the safe one.
function suggestedKey(s) {
  if (!s || s.experiment?.status === 'completed') return null;
  const rec = s.recommendation;
  if (rec?.call === 'ship' && rec.variant) return rec.variant;
  return s.winner?.key ?? null;
}

function selectedKey() {
  return app.choice ?? suggestedKey(app.state);
}

function renderActions(s) {
  const e = s.experiment;
  const variants = F.built(s, F.variantList(e));
  const completed = e.status === 'completed';
  const winnerKey = suggestedKey(s);
  const recommended = s.recommendation?.call === 'ship' && s.recommendation.variant === winnerKey;

  const keys = variants.map((v) => `${v.key}=${v.label}`).join('|');
  if (keys + F.shownKey() !== app.choiceKeys) {
    app.choiceKeys = keys + F.shownKey();
    $('ship-choices').replaceChildren(
      ...variants.map((v) =>
        h(
          'label',
          { class: 'choice', vars: { '--c': v.color } },
          h('input', { type: 'radio', name: 'ship-variant', value: v.key }),
          h('span', { class: 'choice-swatch', 'aria-hidden': 'true' }),
          h('span', { class: 'choice-text' }, h('span', { class: 'choice-label' }, F.shown(v.label)), h('span', { class: 'choice-key' }, v.key)),
          h('span', { class: 'pick', hidden: true }, "Flagsmith's pick"),
        ),
      ),
    );
  }
  if (app.choice && !variants.some((v) => v.key === app.choice)) app.choice = null;
  const selected = selectedKey();
  for (const label of $('ship-choices').querySelectorAll('label')) {
    const input = /** @type {HTMLInputElement} */ (label.querySelector('input'));
    input.checked = input.value === selected;
    const pick = /** @type {HTMLElement} */ (label.querySelector('.pick'));
    pick.hidden = input.value !== winnerKey;
    pick.textContent = recommended ? 'Recommended' : "Flagsmith's pick";
  }
  // A decided test: its outcome instead of greyed-out buttons that can't do anything.
  let decided = document.getElementById('decided');
  if (!decided) {
    decided = h('p', { id: 'decided', class: 'decided-note', role: 'status' });
    $('ship-form').before(decided);
  }
  $('ship-form').hidden = completed;
  decided.hidden = !completed;
  if (completed) {
    const last = [...(s.ledger ?? [])].reverse().find((x) => x.experimentId === e.id && x.decision !== 'kept-running');
    const label = F.shown(variants.find((v) => v.key === last?.variant)?.label ?? last?.release ?? 'control');
    decided.textContent = last
      ? `${last.decision === 'shipped' ? `Shipped ${label} to everyone` : `Reverted: everyone gets ${label}`} on ${new Date(last.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}. The next test starts from Run a test.`
      : 'This test is decided: the flag is a plain flag again. The next test starts from Run a test.';
  }
  // A demo job holds the console's lock too: Ship and Revert wait for it. The public page decides nothing.
  const busy = app.busy || demoRunning() || READONLY;
  /** @type {HTMLFieldSetElement} */ ($('ship-fieldset')).disabled = completed || busy;

  const sel = variants.find((v) => v.key === selected);
  const ship = /** @type {HTMLButtonElement} */ ($('ship-btn'));
  ship.disabled = completed || !sel || busy;
  ship.textContent = sel ? `Ship ${F.shown(sel.label)}` : 'Ship winner';
  ship.style.setProperty('--c', sel?.color ?? 'var(--muted)');

  let note;
  if (READONLY) note = 'Read-only: on this public page the autopilot decides, by the same rules. Ship and Revert run from the console on the server.';
  else if (completed) note = 'Experiment completed: the flag is a plain flag again. Edit it in Flagsmith to change who gets what.';
  else if (!sel) note = 'Flagsmith shows no winner yet. Choose a release to ship it anyway, or wait for data.';
  else if (!s.winner) note = `Your choice: ${sel.key}. Flagsmith shows no winner yet.`;
  else if (recommended && sel.key === winnerKey && sel.key !== s.winner.key) note = `Pre-selected: ${sel.key} is clearly better than control and passes every safety check. ${s.winner.key} scores higher on the goal but fails a safety check.`;
  else if (sel.key !== s.winner.key) note = `Your choice: ${sel.key}. Flagsmith's results page shows ${s.winner.key} ahead (${F.formatChance(s.winner.chanceToWin)}).`;
  else if (F.verdict(s.winner.chanceToWin).word === 'winning') note = `Pre-selected: Flagsmith's results page shows ${sel.key} winning (${F.formatChance(s.winner.chanceToWin)}).`;
  else note = `Pre-selected: Flagsmith's pick, but inconclusive (${F.formatChance(s.winner.chanceToWin)}, below 95%). Shipping now is your call.`;
  $('ship-note').textContent = note;

  // Turnout's call, read off Flagsmith's interval: an interval crossing zero isn't a win.
  const rec = s.recommendation;
  $('recommendation-note').textContent = completed || !rec ? '' : `Turnout recommends: ${F.recommendationText(rec)}.`;
  const keep = /** @type {HTMLButtonElement} */ ($('keep-running-btn'));
  keep.disabled = completed || busy;
  keep.textContent = rec?.call === 'keep-running' ? 'Keep running (interval crosses zero)' : 'Keep running';
  keep.classList.toggle('btn-primary', !completed && rec?.call === 'keep-running');

  const revert = /** @type {HTMLButtonElement} */ ($('revert-btn'));
  revert.disabled = completed || busy || !e.experiment_rollout;
  const control = variants.find((v) => v.isControl);
  $('revert-note').textContent = completed
    ? 'Revert is not available: the experiment is completed. Edit the flag in Flagsmith instead.'
    : `Revert completes the experiment and drains the split: everyone gets control (${F.shown(control?.label ?? 'control')}).`;
  renderDemo();
}

$('ship-choices').addEventListener('change', (ev) => {
  const t = /** @type {HTMLInputElement} */ (ev.target);
  if (t.name !== 'ship-variant') return;
  app.choice = t.value === suggestedKey(app.state) ? null : t.value;
  if (app.state) renderActions(app.state);
});

$('ship-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const key = selectedKey();
  if (key && !$('ship-btn').hasAttribute('disabled')) openDialog('ship', key);
});

$('revert-btn').addEventListener('click', () => openDialog('revert', null));

// Keep running: no Flagsmith write; the ledger records Flagsmith's interval and the reason.
$('keep-running-btn').addEventListener('click', async () => {
  const e = app.state?.experiment;
  if (!e || app.busy) return;
  app.busy = true;
  renderActions(app.state);
  let text;
  let ok = false;
  try {
    const res = await api('/api/keep-running', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ experimentId: e.id }),
    });
    const body = await res.json().catch(() => ({}));
    ok = res.ok && body.ok === true;
    text = ok
      ? `Kept running: ${body.entry?.reason ?? 'recorded'}. Nothing changed in Flagsmith; recorded in the release ledger.`
      : body.error || `HTTP ${res.status}`;
  } catch {
    text = "Couldn't reach the console server.";
  }
  app.busy = false;
  $('action-status').dataset.tone = ok ? 'good' : 'bad';
  $('action-status').textContent = text;
  await refreshNow();
});

// ---- confirmation dialog -------------------------------------------------------------------------------------

const dialog = /** @type {HTMLDialogElement} */ ($('confirm-dialog'));
const confirmBtn = /** @type {HTMLButtonElement} */ ($('dialog-confirm'));
const cancelBtn = /** @type {HTMLButtonElement} */ ($('dialog-cancel'));
const acceptBox = /** @type {HTMLInputElement} */ ($('accept-guardrails'));
// { action, key, experimentId, plan, guardrails, running, trigger }
let pending = null;

/** Losing guardrails in red, with the "Ship anyway" box the confirm button waits for. */
function showGuardrails(job, guardrails) {
  job.guardrails = Array.isArray(guardrails) ? guardrails : [];
  const box = $('dialog-guardrails');
  acceptBox.checked = false;
  if (!job.guardrails.length) {
    box.hidden = true;
    $('guardrail-list').replaceChildren();
    return;
  }
  $('guardrail-list').replaceChildren(...job.guardrails.map((g) => h('li', {}, F.guardrailWarningText(job.key, g))));
  box.hidden = false;
}

function updateConfirm() {
  if (!pending || pending.running || !pending.plan) {
    confirmBtn.disabled = true;
    return;
  }
  confirmBtn.disabled = pending.guardrails.length > 0 && !acceptBox.checked;
}
acceptBox.addEventListener('change', updateConfirm);

async function openDialog(action, key) {
  const e = app.state?.experiment;
  if (!e) return;
  const label = key ? F.releaseLabel(e, key) : '';
  const controlLabel = F.releaseLabel(e, F.CONTROL);
  pending = { action, key, experimentId: e.id, plan: null, guardrails: [], running: false, trigger: document.activeElement };

  $('dialog-title').textContent = action === 'ship' ? `Ship ${label} (${key}) to everyone?` : `Revert to control (${controlLabel})?`;
  $('dialog-intro').textContent =
    action === 'ship'
      ? 'Turnout runs these steps against Flagsmith, in order. Each is read back afterwards, and skipped if Flagsmith already shows it done, so it is safe to re-run.'
      : `Turnout completes the experiment and drains the split: the flag's environment default becomes control (${controlLabel}) with every variant at 0%, so everyone gets it. A completed experiment can't be resumed; the decision goes in the release ledger.`;
  dialog.dataset.action = action;
  dialog.style.setProperty('--c', action === 'ship' ? (F.variantList(e).find((v) => v.key === key)?.color ?? 'var(--treatment)') : 'var(--control)');
  $('dialog-body').replaceChildren(h('p', { class: 'loading' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Fetching the plan…'));
  showGuardrails(pending, []);
  $('dialog-recommendation').hidden = true;
  $('dialog-result').textContent = '';
  $('dialog-result').dataset.tone = 'neutral';
  confirmBtn.hidden = false;
  confirmBtn.disabled = true;
  confirmBtn.textContent = action === 'ship' ? `Confirm: ship ${label}` : 'Confirm: revert to control';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.disabled = false;
  dialog.showModal();

  const mine = pending;
  try {
    const qs = new URLSearchParams({ action, experimentId: String(e.id), ...(action === 'ship' ? { winner: key } : {}) });
    const res = await api(`/api/plan?${qs}`, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (pending !== mine) return;
    if (!res.ok || !Array.isArray(body.steps)) throw new Error(body.error || `HTTP ${res.status}`);
    mine.plan = body.steps;
    $('dialog-body').replaceChildren(
      h(
        'ol',
        { class: 'steps' },
        body.steps.map((step) => h('li', {}, h('div', {}, h('p', { class: 'step-title' }, step.title), h('code', { class: 'step-call' }, step.call)))),
      ),
    );
    showGuardrails(mine, body.guardrails);
    const rec = body.recommendation;
    if (rec) {
      const interval = F.recommendationInterval(rec);
      $('dialog-recommendation').textContent =
        `${interval ? `Flagsmith's credible interval for ${rec.variant} on the goal: ${interval}` : 'Flagsmith has no interval on the goal yet'}` +
        `${rec.chanceToWin != null ? `, ${F.formatChance(rec.chanceToWin)} chance to win` : ''}. Turnout recommends: ${F.recommendationText(rec)}.` +
        (action === 'ship' && rec.call !== 'ship' ? ' Shipping now is your call, against the recommendation.' : '');
      $('dialog-recommendation').dataset.tone = rec.call === 'ship' ? 'good' : 'bad';
      $('dialog-recommendation').hidden = false;
    }
    updateConfirm();
  } catch (err) {
    if (pending !== mine) return;
    $('dialog-body').replaceChildren(h('p', { class: 'error-box' }, `Couldn't build the plan: ${err.message}`));
  }
}

confirmBtn.addEventListener('click', async () => {
  if (!pending || pending.running || !pending.plan) return;
  const job = pending;
  const accept = job.guardrails.length > 0 && acceptBox.checked;
  if (job.guardrails.length > 0 && !accept) return;
  job.running = true;
  app.busy = true;
  if (app.state) renderActions(app.state);
  confirmBtn.disabled = true;
  cancelBtn.disabled = true;
  acceptBox.disabled = true;
  dialog.setAttribute('aria-busy', 'true');
  const result = $('dialog-result');
  result.dataset.tone = 'neutral';
  result.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Running against Flagsmith…');

  const finish = () => {
    job.running = false;
    app.busy = false;
    acceptBox.disabled = false;
    dialog.removeAttribute('aria-busy');
    cancelBtn.disabled = false;
  };

  let summary;
  let ok = false;
  try {
    const url = job.action === 'ship' ? '/api/ship' : '/api/revert';
    const payload = {
      experimentId: job.experimentId,
      ...(job.action === 'ship' ? { winner: job.key } : {}),
      ...(accept ? { acceptLosingGuardrails: true } : {}),
    };
    const res = await api(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const body = await res.json().catch(() => ({}));

    // Flagsmith's results moved on since the plan: the variant now loses a guardrail. Nothing ran; ask again.
    if (res.status === 409 && Array.isArray(body.guardrails) && body.guardrails.length) {
      finish();
      showGuardrails(job, body.guardrails);
      result.dataset.tone = 'bad';
      result.textContent = 'Nothing was changed. Flagsmith now shows a losing guardrail; tick the box to ship anyway.';
      updateConfirm();
      if (app.state) renderActions(app.state);
      acceptBox.focus();
      return;
    }

    const steps = Array.isArray(body.steps) ? body.steps : [];
    ok = res.ok && body.ok === true;
    const notRun = ok ? [] : (job.plan ?? []).slice(steps.length);
    $('dialog-body').replaceChildren(
      h(
        'ol',
        { class: 'steps steps-result' },
        steps.map((step) =>
          h(
            'li',
            { 'data-status': step.status },
            h('span', { class: 'step-mark', 'aria-hidden': 'true' }, F.stepMark(step.status)),
            h(
              'div',
              {},
              h('p', { class: 'step-title' }, step.title, h('span', { class: 'sr-only' }, ` (${F.stepStatusText(step.status)})`)),
              step.status === 'done' ? h('code', { class: 'step-call' }, step.detail ?? '') : h('p', { class: 'step-skip' }, 'Already done in Flagsmith; skipped.'),
            ),
          ),
        ),
        notRun.map((step) =>
          h(
            'li',
            { 'data-status': 'not-run' },
            h('span', { class: 'step-mark', 'aria-hidden': 'true' }, '–'),
            h('div', {}, h('p', { class: 'step-title' }, step.title, h('span', { class: 'sr-only' }, ' (not run)')), h('p', { class: 'step-skip' }, 'Not run.')),
          ),
        ),
      ),
    );
    $('dialog-guardrails').hidden = true;
    const e = app.state?.experiment;
    if (ok) {
      const ran = `${steps.filter((x) => x.status === 'done').length} step(s) run, ${steps.filter((x) => x.status === 'skipped').length} already done.`;
      summary =
        job.action === 'ship'
          ? `Shipped ${F.releaseLabel(e, job.key)}: everyone gets it from the flag's environment default. ${ran}`
          : `Reverted: everyone now gets control (${F.releaseLabel(e, F.CONTROL)}). The experiment is completed. ${ran}`;
      summary += ' Recorded in the release ledger.';
      if (body.github && typeof body.github.url === 'string' && body.github.url) summary += ` GitHub Release updated: ${body.github.url}`;
      else if (body.github && body.github.error) summary += ` GitHub Release not updated: ${body.github.error}`;
    } else if (res.status === 409) {
      summary = body.error || 'Another action is still running. Try again in a moment.';
    } else {
      summary = `Stopped: ${body.error || `HTTP ${res.status}`}. Steps marked ✓ finished; running it again is safe.`;
    }
  } catch {
    summary = "Couldn't reach the console server. Check Flagsmith's audit log, then run it again: finished steps are skipped.";
  }
  result.dataset.tone = ok ? 'good' : 'bad';
  result.textContent = summary;
  $('action-status').dataset.tone = ok ? 'good' : 'bad';
  $('action-status').textContent = summary;
  if (ok) app.choice = null;

  finish();
  confirmBtn.hidden = true;
  cancelBtn.textContent = 'Close';
  cancelBtn.focus();
  await refreshNow();
});

dialog.addEventListener('cancel', (ev) => {
  if (pending?.running) ev.preventDefault();
});
dialog.addEventListener('close', () => {
  const trigger = pending?.trigger;
  pending = null;
  if (trigger instanceof HTMLElement && !trigger.hasAttribute('disabled')) trigger.focus();
  else $('actions-title').closest('section')?.querySelector('button:not([disabled])')?.focus();
});

// ---- sidings and swing-back ----------------------------------------------------------------------------------

function renderSidings(s) {
  const list = $('siding-list');
  if (!Array.isArray(s.history)) {
    list.replaceChildren(h('li', { class: 'empty' }, "Past experiments unavailable: Flagsmith's experiment list didn't answer."));
    return;
  }
  const past = F.sidings(s.history, s.experiment.id, s.ledger);
  if (!past.length) {
    list.replaceChildren(h('li', { class: 'empty' }, 'None yet. Each turnout release parks the previous experiment here.'));
    return;
  }
  const shown = past.slice(0, 6).map((p) => {
    const dates = [Number.isFinite(p.startedAt) ? fmtDateTime(p.startedAt) : 'not started', Number.isFinite(p.endedAt) ? fmtDateTime(p.endedAt) : null]
      .filter(Boolean)
      .join(' → ');
    return h(
      'li',
      {},
      h('span', { class: 'siding-name' }, p.name),
      h('span', { class: 'siding-status' }, p.statusLabel),
      h('span', { class: 'siding-dates' }, dates),
      p.decision ? h('span', { class: 'siding-decision' }, p.decision) : null,
    );
  });
  if (past.length > 6) shown.push(h('li', { class: 'empty' }, `and ${past.length - 6} older`));
  list.replaceChildren(...shown);
}

function renderSwingBack(s) {
  const text = F.swingBackText(s.experiment, s.ledger, s.serving);
  const el = $('swing-back');
  el.textContent = text ?? '';
  el.hidden = !text;
}

// ---- demo controls: simulated visitors and the swing ---------------------------------------------------------
// The same background jobs judge mode runs (POST /api/judge/run, polled on GET /api/judge/job). The console holds
// one lock for them and for Ship / Revert, so only one runs at a time, whichever page started it.

const DEMO_POLL_MS = 1000;
const demo = {
  available: null, // null: not asked yet; false: the console has no judge options (404), so the card stays hidden
  job: null, // the running job, else the most recent one
  mine: new Set(), // jobs this page started: only their outcome is reported here
  posting: false,
  message: null, // { tone, text }: why the last click didn't start a job
  timer: 0,
};
const demoRunning = () => demo.posting || demo.job?.status === 'running';

async function loadDemoJob() {
  if (demo.available === false) return;
  try {
    const res = await api('/api/judge/job', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (res.status === 404) {
      demo.available = false;
      renderDemo();
      return;
    }
    if (!res.ok) return;
    const body = await res.json().catch(() => null);
    demo.available = true;
    trackDemoJob(body?.job ?? null);
  } catch {
    /* the next poll asks again */
  }
}

function trackDemoJob(job) {
  const was = demo.job;
  demo.job = job;
  if (job?.status === 'running') {
    if (!demo.timer) demo.timer = setTimeout(pollDemoJob, DEMO_POLL_MS);
  } else if (was?.status === 'running' && job?.id === was.id) {
    void refreshNow(); // the job changed Flagsmith: read the new state
    void loadRunState();
  }
  renderDemo();
  if (app.state) renderActions(app.state);
}

async function pollDemoJob() {
  demo.timer = 0;
  await loadDemoJob();
}

async function runDemo(action, payload) {
  if (demoRunning() || app.busy) return;
  demo.posting = true;
  demo.message = null;
  renderDemo();
  try {
    const res = await api('/api/judge/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 202 && body.job) {
      demo.mine.add(body.job.id);
      demo.posting = false;
      trackDemoJob(body.job);
      return;
    }
    demo.message = {
      tone: 'bad',
      text: res.status === 403 ? 'The console server restarted. Reload this page to keep using it.' : `Nothing was started: ${body.error || `HTTP ${res.status}`}`,
    };
  } catch {
    demo.message = { tone: 'bad', text: "Couldn't reach the console server. Nothing was started." };
  } finally {
    demo.posting = false;
  }
  renderDemo();
}

function renderDemo() {
  const card = $('run');
  card.hidden = demo.available !== true || READONLY; // the public page: the autopilot runs the tests
  if (card.hidden) return;
  renderRun();
  const s = app.state;
  const e = s?.experiment;
  const blocked = demoRunning() || app.busy;

  const v = F.visitorsView(e);
  /** @type {HTMLButtonElement} */ ($('visitors-btn')).disabled = !v.enabled || blocked;
  $('visitors-note').textContent = v.note;

  const sw = F.swingView(e, s?.ledger, s?.serving);
  const back = /** @type {HTMLButtonElement} */ ($('swing-back-btn'));
  const forward = /** @type {HTMLButtonElement} */ ($('swing-forward-btn'));
  // A swing to the release everyone already gets does nothing: only the other direction is offered.
  back.disabled = !sw.enabled || blocked || (sw.back !== null && s?.serving === sw.back);
  forward.disabled = !sw.enabled || blocked || (sw.forward !== null && s?.serving === sw.forward);
  back.textContent = sw.back ? `Swing back to ${sw.back}` : 'Swing back';
  forward.textContent = sw.forward ? `Swing forward to ${sw.forward}` : 'Swing forward';
  back.dataset.suggested = String(sw.enabled && sw.suggested === 'back');
  forward.dataset.suggested = String(sw.enabled && sw.suggested === 'forward');
  $('swing-note').textContent = sw.note;

  const job = demo.job;
  const p = job?.status === 'running' && job.action === 'visitors' && job.progress?.total ? job.progress : null;
  const bar = /** @type {HTMLProgressElement} */ ($('demo-progress'));
  bar.hidden = !p;
  if (p) {
    bar.max = p.total;
    bar.value = p.done;
  }
  let text = '';
  let tone = 'neutral';
  if (job?.status === 'running') text = demo.mine.has(job.id) ? F.demoJobText(job) : `Judge mode is running a step: ${F.demoJobText(job)}`;
  else if (job && demo.mine.has(job.id)) {
    text = F.demoJobText(job);
    tone = job.status === 'failed' ? 'bad' : 'good';
  } else if (demo.message) ({ text, tone } = demo.message);
  // After the one-button run, its own summary (Flagsmith's verdict) stays, not the last job's "Done.".
  if (flow.note && !flow.running) ({ note: text, tone } = flow);
  const status = $('demo-status');
  status.dataset.tone = tone;
  if (status.textContent !== text) status.textContent = text;
}

$('visitors-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const input = /** @type {HTMLInputElement} */ ($('visitors-count'));
  const n = F.visitorCount(input.value);
  input.value = String(n);
  void runDemo('visitors', { visitors: n });
});
$('swing-back-btn').addEventListener('click', () => {
  if (app.state?.experiment) void runDemo('swing-back', { experimentId: app.state.experiment.id });
});
$('swing-forward-btn').addEventListener('click', () => {
  if (app.state?.experiment) void runDemo('swing-forward', { experimentId: app.state.experiment.id });
});

// ---- snapshots -----------------------------------------------------------------------------------------------

function renderSnapshots(s) {
  const list = $('snapshot-list');
  const files = Array.isArray(s.snapshots) ? s.snapshots : [];
  if (!files.length) {
    list.replaceChildren(h('li', { class: 'empty' }, 'None yet. Ship winner saves one before anything moves.'));
    return;
  }
  const items = files.slice(0, 8).map((name) => {
    const t = F.parseTime(F.snapshotTime(name));
    return h('li', {}, h('span', { class: 'snap-time' }, Number.isFinite(t) ? fmtDateTime(t) : ''), h('code', { class: 'snap-file' }, name));
  });
  if (files.length > 8) items.push(h('li', { class: 'empty' }, `and ${files.length - 8} older`));
  list.replaceChildren(...items);
}

// ---- you: where this browser lands in the experiment ------------------------------------------------------------
// The console asks the proxy with this browser's visitor cookie (/api/you); the proxy answers as it routes pages,
// without counting anything. Polled every few seconds while the page is visible.
const YOU_POLL_MS = 4000;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
// Your visits, per flag: two apps on the same port (the demo, then turnout compare) never mix their histories.
let JOURNEY_KEY = 'turnout-you-journey-console';
app.journey = [];
function loadJourney(flag) {
  const key = `turnout-you-journey-console:${flag}`;
  if (key === JOURNEY_KEY) return;
  JOURNEY_KEY = key;
  try {
    app.journey = JSON.parse(localStorage.getItem(JOURNEY_KEY) ?? '[]');
  } catch {
    app.journey = [];
  }
}
const RECEIPT_WORDS = {
  accepted: 'Flagsmith accepted it',
  rejected: 'Flagsmith rejected it',
  batch_rejected: 'Flagsmith rejected its batch',
  store_not_connected: "Flagsmith's event store isn't connected",
  not_delivered: "it didn't reach Flagsmith",
};
async function loadYou() {
  if (!document.hidden) {
    try {
      if (READONLY) {
        const res = await fetch('/__turnout/receipt', { cache: 'no-store', credentials: 'same-origin' });
        app.you = res.ok ? { visited: true, ...(await res.json()) } : res.status === 404 ? { visited: false } : null;
      } else {
        const res = await api('/api/you', { cache: 'no-store' });
        app.you = res.ok ? await res.json() : null;
      }
    } catch {
      app.you = null;
    }
    if (!READONLY && app.you?.visited && run.judge?.releases?.length) await loadPin();
    renderYou();
  }
  setTimeout(loadYou, YOU_POLL_MS);
}
function renderYou() {
  const box = $('you');
  const y = app.you;
  const e = app.state?.experiment;
  const variants = e ? F.built(app.state, F.variantList(e)) : [];
  const site = app.state?.site;
  setVersions(site?.url, variants.map((v) => v.label));
  // Every version in the experiment, each openable on its own through the proxy's view switch (never counted).
  const list = $('site-version-list');
  const vkey = JSON.stringify([site?.url, variants.map((v) => [v.key, v.label]), F.shownKey()]);
  if (list.dataset.key !== vkey) {
    list.dataset.key = vkey;
    $('site-versions').hidden = !site?.url || site.simulated || !variants.length;
    list.replaceChildren(...variants.map((v, n) => h('li', {},
      h('span', { class: 'you-chip', vars: { '--c': v.color } }, LETTERS[n] ?? '?'),
      h('a', { href: previewOf(site, v.label), target: '_blank', rel: 'noopener', title: `Open ${F.shown(v.label)} on its own` }, `${F.shown(v.label)} ↗`),
      h('span', { class: 'v-key' }, v.isControl ? 'control' : v.key))));
  }
  // The YOU pin on the map, and where this browser landed over time (before a test, in it, after the decision).
  const running = e?.status === 'running';
  const seen = Boolean(y?.visited && !y.viewing && y.release);
  map.setYou(seen ? (running && y.enrolled ? y.variant : variants.find((v) => v.label === y.release)?.key ?? null) : null);
  if (seen && app.state) {
    loadJourney(e?.feature?.name ?? 'flag'); // only once the experiment is known: before that every visit would read "what everyone gets"
    const at = variants.findIndex((v) => v.key === y.variant);
    const where = app.pinned && app.pinned === y.release
      ? 'pinned by an identity override (not counted)'
      : running && y.enrolled
      ? `in test #${e.id} as ${LETTERS[at] ?? y.variant}`
      : running ? `outside test #${e.id}` : e?.status === 'completed' ? `after test #${e.id}: everyone gets it` : 'what everyone gets';
    const next = M.addVisit(app.journey, { release: y.release, name: y.release, where, key: `${y.release}|${where}` });
    if (next !== app.journey) {
      app.journey = next;
      try {
        localStorage.setItem(JOURNEY_KEY, JSON.stringify(next));
      } catch {
        /* this page only */
      }
    }
  }
  if (app.state && e?.feature?.name) loadJourney(e.feature.name);
  const jl = $('journey-list');
  const jkey = JSON.stringify(app.journey);
  if (jl.dataset.key !== jkey) {
    jl.dataset.key = jkey;
    $('journey').hidden = !app.journey.length;
    jl.replaceChildren(...app.journey.map((v) => h('li', {}, h('strong', {}, v.name), ` ${v.where}`)));
  }
  const key = JSON.stringify([y, e?.id, e?.status, app.pinned, app.pinError, run.judge?.releases]);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  if (!y) return box.replaceChildren(h('p', { class: 'you-line' }, "Can't tell where you land right now."));
  if (!y.visited) {
    return box.replaceChildren(
      h('p', { class: 'you-line' }, h('strong', {}, 'You: not visited yet. '), 'Open your site from this browser: Turnout gives you a version, and this card says which.'),
    );
  }
  if (y.viewing) {
    return box.replaceChildren(
      h('p', { class: 'you-line' }, h('strong', {}, `You're looking at ${y.release}`), ' on its own (Versions menu): not counted as a visitor.'),
      h('a', { class: 'you-link', href: `${String(site?.url ?? '').replace(/\/$/, '')}/__turnout/view/off`, target: '_blank', rel: 'noopener' }, 'Back to the version Flagsmith gives you ↗'),
    );
  }
  const i = variants.findIndex((v) => v.key === y.variant);
  const letter = i >= 0 ? LETTERS[i] : null;
  // Counted only once this browser has loaded a page (a receipt for its events); a cookie alone isn't a visit.
  const where = y.enrolled && e?.status === 'running'
    ? y.receipt
      ? `: ${letter ?? y.variant} in test #${e.id}, counted.`
      : `: ${letter ?? y.variant} in test #${e.id}, counted from your first page.`
    : app.pinned && app.pinned === y.release
      ? ': pinned (not counted).'
      : e?.status === 'running'
        ? ': outside the test (not counted).'
        : ': what everyone gets now.';
  const lines = [
    h('p', { class: 'you-line' }, h('span', { class: 'you-chip', vars: { '--c': variants[i]?.color ?? 'var(--muted)' } }, letter ?? '•'), h('strong', {}, `You got ${y.release ?? 'no version'}`), where),
  ];
  // Pin this browser to one version (an identity override in Flagsmith), under "More".
  const pinBox = $('pin-box');
  pinBox.hidden = READONLY || !run.judge?.releases?.length;
  if (!pinBox.hidden) {
    pinBox.replaceChildren(
      h('h3', {}, 'Pin this browser'),
      h('div', { class: 'pin-row', title: 'An identity override in Flagsmith for your visitor id: this browser gets that version on every page, outside the test.' },
        ...run.judge.releases.map((r) => h('button', { class: 'btn btn-small pin-btn', type: 'button', 'aria-pressed': String(app.pinned === r), onclick: () => pinTo(r) }, r)),
        app.pinned ? h('button', { class: 'btn btn-small', type: 'button', onclick: () => pinTo(null) }, 'Unpin') : null),
      h('p', { class: 'you-sub' }, app.pinError || (app.pinned ? `Pinned to ${app.pinned} by an identity override in Flagsmith (outside the test).` : 'An identity override in Flagsmith: this browser gets that version on every page, outside the test.')));
  }
  if (y.error) lines.push(h('p', { class: 'you-sub' }, y.error));
  box.replaceChildren(...lines);
}

// ---- pin this browser to one version (a Flagsmith identity override for its visitor id) -------------------------
async function loadPin() {
  try {
    const res = await api('/api/pin', { cache: 'no-store' });
    const pinned = res.ok ? (await res.json()).pinned : null;
    if (pinned !== app.pinned) {
      app.pinned = pinned;
      $('you').dataset.key = '';
      renderYou();
    }
  } catch {
    /* tried again with the next visit check */
  }
}
async function pinTo(release) {
  try {
    const res = await api('/api/pin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ release }) });
    const out = await res.json().catch(() => ({}));
    app.pinned = res.ok ? out.pinned : app.pinned;
    app.pinError = res.ok ? '' : (out.error ?? `Pinning failed (HTTP ${res.status}).`);
  } catch {
    app.pinError = "Couldn't reach the console server.";
  }
  $('you').dataset.key = '';
  renderYou();
}

// ---- run a test: A/A, A/B, A/B/C… a preview first, then Start ---------------------------------------------------
// The same start job judge mode runs (POST /api/judge/run, action start). The releases and the running test's kind
// come from judge mode's state (/api/judge/state), read every few seconds while the card is on screen.
const RUN_COLORS = ['#2563eb', '#16a34a', '#d97706', '#7c3aed', '#db2777', '#0891b2'];
const run = { judge: null, plan: null, timer: 0 };
async function loadRunState() {
  clearTimeout(run.timer);
  if (demo.available !== false) {
    try {
      const res = await api('/api/judge/state', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (res.ok) run.judge = await res.json();
    } catch {
      /* the next read tries again */
    }
    renderRun();
  }
  run.timer = setTimeout(loadRunState, 6000);
}

function renderRun() {
  const card = $('run');
  const s = run.judge;
  if (card.hidden || !s) return;
  const current = s.experiment && s.experiment.status !== 'completed' ? M.kindOf(s) : null;
  const blocked = demoRunning() || app.busy;
  const options = M.kinds(s.releases);
  const box = $('kinds');
  const key = JSON.stringify([options.map((o) => o.arms), run.plan, current, blocked]);
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.replaceChildren(...options.map((o) => h('button', {
      class: 'kind', type: 'button', title: `${o.blurb} Click to preview it; Start runs it.`,
      'aria-pressed': String(o.arms === (run.plan ?? current)), 'data-running': o.arms === current ? 'true' : null, disabled: blocked,
      onclick: () => { run.plan = o.arms === current ? null : o.arms; renderRun(); },
    }, o.label)));
  }
  const chips = (versions) => versions.flatMap((v, i) => [
    i ? (i === versions.length - 1 ? ' against ' : ' and ') : '',
    h('span', { class: 'plan-chip', 'data-copy': String(v.letter === 'A′'), vars: { '--c': RUN_COLORS[Math.max(0, 'ABCDEF'.indexOf(v.letter[0]))] } }, v.letter),
    h('strong', {}, M.label(v.release)),
  ]).filter((x) => x !== '');
  const plan = $('run-plan');
  if (run.plan !== null) {
    const versions = M.plannedVersions(s.releases, run.plan);
    // The new versions first ("B and C against A"), A last.
    plan.replaceChildren('Preview: ', ...chips([...versions.slice(1), versions[0]]), `. Nothing changes until you run it${current ? `; the running test #${s.experiment.id} stops first` : ''}.`);
  } else if (current) {
    const list = M.arms(s);
    plan.replaceChildren(`Running: ${M.kindLabel(current)} test #${s.experiment.id}, `, ...chips([...list.slice(1), list[0]]), '. Pick another kind to preview it.');
  } else {
    plan.textContent = 'No test is running. Pick A/A, A/B or A/B/C to preview it, then run it.';
  }
  renderFlowButton(s, current, blocked);
  // Simulated shoppers only on the demo: a console for your own app sends none (turnout simulate has its own).
  $('visitors-form').hidden = s.simulator === false;
}

// Your own app (/app) has visitors, not shoppers.
const WHO = document.querySelector('meta[name="turnout-app"]') ? 'visitors' : 'shoppers';

// ---- one button: start the test, send shoppers, ask Flagsmith ------------------------------------------------
// The same judge jobs the steps run, one after the other, each waited for. Flagsmith recomputes results at most once
// every 5 minutes, so the flow asks only after the shoppers' events have arrived, and if a window is still closed it
// waits it out with a countdown and asks then. A console for your own app only starts the test (no shoppers).
const FLOW_STEPS = [
  { id: 'start', title: 'Start the test in Flagsmith' },
  { id: 'visitors', title: `Send simulated ${WHO}` },
  { id: 'score', title: 'Ask Flagsmith for the results' },
];
const flow = { running: false, step: -1, done: [], note: '', tone: 'neutral', waitUntil: 0, timer: 0 };

const kindNow = (s) => (s?.experiment && s.experiment.status !== 'completed' ? M.kindOf(s) : null);
const wantedKind = (s) => run.plan ?? kindNow(s) ?? s?.releases?.length ?? 2;

function renderFlowButton(s, current, blocked) {
  const go = /** @type {HTMLButtonElement} */ ($('run-go'));
  const kind = wantedKind(s);
  const label = M.kindLabel(kind);
  const article = /^A/.test(label) ? 'an' : 'a';
  const sim = s.simulator !== false;
  const fresh = run.plan !== null || !current;
  const counted = s.results?.metrics?.find((m) => m.role === 'goal');
  go.textContent = flow.running
    ? 'Running…'
    : !sim
      ? `Start ${article} ${label} test`
      : fresh
        ? `▶ Run ${article} ${label} test`
        : counted
          ? `▶ Send more ${WHO} and ask Flagsmith again`
          : `▶ Send ${WHO} and ask Flagsmith`;
  go.disabled = flow.running || (blocked && !flow.running) || (!sim && !fresh);
  go.title = sim ? `Starts the test if needed, sends simulated ${WHO}, then asks Flagsmith for its results: one click.` : 'Starts the test in Flagsmith. Then open your site to be a visitor, or run turnout simulate.';
  $('run-cancel').hidden = run.plan === null || flow.running;
  const steps = $('run-steps');
  steps.hidden = flow.step < 0 && !flow.note;
  const progress = demo.job?.status === 'running' && demo.job.action === 'visitors' && demo.job.progress?.total ? demo.job.progress : null;
  const wait = flow.waitUntil > Date.now() ? Math.ceil((flow.waitUntil - Date.now()) / 1000) : 0;
  steps.replaceChildren(
    ...FLOW_STEPS.filter((st) => sim || st.id === 'start').map((st, i) => {
      const status = flow.done.includes(st.id) ? 'done' : flow.step === i && flow.running ? 'current' : 'todo';
      const extra = st.id === 'visitors' && status === 'current' && progress
        ? ` (${progress.done.toLocaleString('en-GB')} of ${progress.total.toLocaleString('en-GB')})`
        : st.id === 'score' && status === 'current' && wait
          ? ` (Flagsmith allows the next look in ${Math.floor(wait / 60)}:${String(wait % 60).padStart(2, '0')})`
          : '';
      return h('li', { 'data-status': status }, `${status === 'done' ? '✓ ' : status === 'current' ? '… ' : ''}${st.title}${extra}`);
    }),
  );
  if (flow.note) {
    const status = $('demo-status');
    status.dataset.tone = flow.tone;
    status.textContent = flow.note;
  }
}

async function postJob(action, payload) {
  const res = await api('/api/judge/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...payload }) });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 202 || !body.job) throw new Error(body.error || `HTTP ${res.status}`);
  demo.mine.add(body.job.id);
  trackDemoJob(body.job);
  return body.job;
}
async function waitJob(id) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 900));
    const res = await api('/api/judge/job', { cache: 'no-store' }).catch(() => null);
    const job = res?.ok ? (await res.json()).job : null;
    if (job) trackDemoJob(job);
    renderRun();
    if (job && job.id === id && job.status !== 'running') return job;
  }
}
async function stepJob(i, action, payload) {
  flow.step = i;
  renderRun();
  const job = await waitJob((await postJob(action, payload)).id);
  if (job.status === 'failed') throw Object.assign(new Error(job.error || `${action} failed`), { action });
  flow.done.push(action === 'start' ? 'start' : action);
  await loadRunState();
}

async function runFlow() {
  const s = run.judge;
  if (!s || flow.running) return;
  const kind = wantedKind(s);
  Object.assign(flow, { running: true, step: -1, done: [], note: '', tone: 'neutral', waitUntil: 0 });
  renderRun();
  try {
    if (run.plan !== null || !kindNow(s) || kindNow(s) !== kind) {
      run.plan = null;
      await stepJob(0, 'start', { arms: kind });
    } else flow.done.push('start');
    if (run.judge.simulator === false) {
      Object.assign(flow, { note: 'Started. Now open your site to be a visitor, or run turnout simulate; Refresh on the results asks Flagsmith once visitors have arrived.', tone: 'good' });
      return;
    }
    const e = run.judge.experiment;
    await stepJob(1, 'visitors', { experimentId: e.id, visitors: M.shoppersFor(M.arms(run.judge).length) });
    // Flagsmith's refresh window: wait it out if it's still closed, then ask once.
    for (let attempt = 0; attempt < 2; attempt++) {
      const allowed = Date.parse(run.judge?.results?.refreshAllowedAt ?? '') || 0;
      if (allowed > Date.now()) {
        flow.step = 2;
        flow.waitUntil = allowed;
        while (Date.now() < flow.waitUntil) {
          renderRun();
          await new Promise((r) => setTimeout(r, 1000));
        }
        flow.waitUntil = 0;
      }
      try {
        await stepJob(2, 'score', { experimentId: e.id });
        break;
      } catch (error) {
        await loadRunState();
        if (!/every 5 minutes/.test(error.message) || attempt) throw error;
      }
    }
    const v = M.verdict(run.judge);
    Object.assign(flow, { note: v ? `${v.title}. ${v.text} Decide below.` : "Done: Flagsmith's results are on the right. Decide below.", tone: v?.tone === 'good' ? 'good' : 'neutral' });
  } catch (error) {
    Object.assign(flow, { note: `Stopped: ${error.message}`, tone: 'bad' });
  } finally {
    flow.running = false;
    flow.step = -1;
    void refreshNow();
    renderRun();
  }
}
$('run-go').addEventListener('click', () => void runFlow());
$('run-cancel').addEventListener('click', () => {
  run.plan = null;
  renderRun();
});

// ---- start ---------------------------------------------------------------------------------------------------
setupMenu('console');
void loadYou();
void loadRunState();
if (!READONLY) void loadSignin().then((x) => {
  const drop = $('signin-drop');
  if (!x?.dashboardUrl) return void (drop.hidden = true);
  $('signin-box').replaceChildren(signinBox(x, { compact: true }));
});
if (!READONLY) void setupTry();
else document.getElementById('try-open')?.remove();
if (READONLY) {
  for (const id of ['refresh-btn', 'signin-drop', 'site-new', 'site-suggest']) {
    const node = document.getElementById(id);
    if (node) node.hidden = true;
  }
}
const tour = createTour({ stops: stopsFor(CONSOLE_STOPS, READONLY), seenKey: READONLY ? 'turnout-tour-public-console-seen' : 'turnout-tour-console-seen' });
// Your app's console (/app, from Try it): the same page for your versions; it says so, and links back to the shop's.
if (document.querySelector('meta[name="turnout-app"]')) {
  document.body.classList.add('is-app');
  void fetch('/try/api/try/status', { headers: { [TOKEN_HEADER]: TOKEN } }).then((r) => r.json()).then((st) => {
    const names = st?.names ?? {};
    F.setShownNames(Object.fromEntries(Object.entries(names).map(([label, name]) => [label, `${label.slice(-1).toUpperCase()} · ${name}`])));
    app.choiceKeys = '';
    if (app.state) render(app.state);
  }).catch(() => {});
  const more = document.querySelector('#run-more > summary, .run-card details > summary');
  if (more) more.textContent = more.textContent.replace('shoppers', 'visitors');
  document.querySelector('.brand-name')?.append(h('span', { class: 'app-chip' }, 'your app'));
  document.querySelector('.brand')?.setAttribute('href', '/app');
  document.getElementById('try-open')?.after(h('a', { class: 'btn btn-ghost btn-small app-back', href: '/' }, '← Demo shop'));
}
// One page: Judge mode is the switch beside Tour; while it is on, Tour shows the judge view's tour.
const mode = setupMode();
$('tour-open').addEventListener('click', () => mode.tour() || tour.start());
// Your app's console (/app) opens straight after a build: no tour on top of it (Tour is one click away).
setTimeout(() => (mode.isOn() || document.body.classList.contains('is-app') ? null : tour.offer()), 1500);

setInterval(renderConnection, 1000);
refreshNow();
void loadDemoJob();
connectFeed();
