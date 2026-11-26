// Turnout console: polls /api/state, streams /api/traffic onto the map, and runs the two human-confirmed
// actions, plus the demo controls (simulated visitors, swing back / forward) that judge mode also runs. Every string
// from the server goes in through textContent.
import * as F from './format.js';
import { TrafficMap } from './map.js';

const POLL_MS = 5000;
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

// The per-boot token the server put in the page. Every /api/* call carries it; without it the server refuses.
const TOKEN = document.querySelector('meta[name="turnout-console"]')?.getAttribute('content') ?? '';
const TOKEN_HEADER = 'x-turnout-console';

/** fetch() for the console API, with the token header added. */
function api(path, init = {}) {
  return fetch(path, { ...init, headers: { ...(init.headers ?? {}), [TOKEN_HEADER]: TOKEN } });
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
  const source = new EventSource(`/api/traffic?token=${encodeURIComponent(TOKEN)}`); // EventSource can't set headers
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
    $('site-title').textContent = 'Simulated visitors only: the Demo environment';
    $('site-open').hidden = true;
    const goalLine = $('site-goal');
    goalLine.textContent = 'Every visitor in this console is a pretend visitor sent by turnout simulate, counted in a separate Flagsmith environment ("Demo (simulated)"). Nothing here is evidence about real people, and nothing here can change your real experiment.';
    $('site-flagsmith').href = s.site.dashboardUrl;
    return;
  }
  $('site-open').href = s.site.url;
  $('site-open').textContent = `Open your site (${s.site.url.replace(/^https?:\/\//, '')})`;
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
    const r = F.compareCommand({ a: $('new-a').value, b: $('new-b').value, goal: $('new-goal').value, split: $('new-split').value });
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
  renderResults(s);
  renderActions(s);
  renderSnapshots(s);
  renderSidings(s);
  renderSwingBack(s);
  renderConnection();
  renderBanner();
}

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
  $('exp-name').textContent = e.name;
  const pill = $('exp-status');
  pill.textContent = F.statusLabel(e.status);
  pill.dataset.status = e.status;
  $('exp-hypothesis').textContent = e.hypothesis || '—';
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
  const variants = F.variantList(e);
  const r = F.routing(e, s.flag);
  map.setLayout(variants, r.shares, e.feature?.name ?? '');
  $('map').removeAttribute('aria-busy');
  renderCounts();
  $('traffic-window').textContent = String(s.traffic?.windowSeconds ?? 60);
  const badge = $('merged-badge');
  if (r.soleKey && variants.length > 1) {
    const v = variants.find((x) => x.key === r.soleKey);
    badge.textContent = `Tracks merged · everyone on ${v?.label ?? r.soleKey}`;
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
  const winnerVariant = s.winner ? F.variantList(e).find((v) => v.key === s.winner.key) : null;
  // Only a winning result takes the release's colour; a lead that is still inconclusive stays neutral.
  if (w.tone === 'good' && winnerVariant) $('winner').style.setProperty('--c', winnerVariant.color);
  else $('winner').style.removeProperty('--c');
  $('winner-headline').textContent = w.headline;
  $('winner-detail').textContent = w.detail;

  const cards = (e.metrics ?? []).map((m, i) => metricCard(F.assessMetric(e, m, res, i)));
  if (!cards.length) cards.push(h('p', { class: 'empty' }, 'This experiment has no metrics.'));
  $('metrics').replaceChildren(...cards);

  $('srm').textContent = F.srmText(res);
  $('events').textContent = F.eventsText(s.events);
  const delta = $('events-delta');
  delta.textContent = s.events && app.eventsDelta > 0 ? `+${F.formatInt(app.eventsDelta)} in the last poll` : '';
  if (app.eventsDelta > 0 && !motion.matches) {
    delta.classList.remove('bump');
    void delta.offsetWidth;
    delta.classList.add('bump');
  }
}

function metricCard(m) {
  const head = h(
    'div',
    { class: 'metric-head' },
    h('h3', { class: 'metric-name' }, m.name),
    h('span', { class: `role role-${m.role}` }, m.role === 'goal' ? 'Goal' : m.role === 'secondary' ? 'Secondary' : 'Guardrail'),
    h('span', { class: 'metric-meta' }, `${m.aggregation} · ${m.direction}`),
  );

  const hasData = m.rows.some((r) => r.n != null);
  const table = !hasData
    ? null
    : h(
    'table',
    { class: 'values' },
    h('caption', { class: 'sr-only' }, `${m.name} per release`),
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Release'), h('th', { scope: 'col' }, 'Value'), h('th', { scope: 'col' }, 'n'))),
    h(
      'tbody',
      {},
      m.rows.map((r) =>
        h(
          'tr',
          { vars: { '--c': r.color } },
          h('th', { scope: 'row' }, h('span', { class: 'swatch', 'aria-hidden': 'true' }), h('span', { class: 'v-label' }, r.label), ' ', h('span', { class: 'v-key' }, r.key)),
          h('td', { class: 'num' }, r.display),
          h('td', { class: 'num muted' }, r.n == null ? '—' : F.formatInt(r.n)),
        ),
      ),
    ),
  );

  const body = [];
  if (m.state === 'no-events') body.push(h('p', { class: 'metric-note good' }, m.note));
  else if (m.state === 'collecting') body.push(h('p', { class: 'metric-note' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Collecting data'));
  else {
    for (const t of m.treatments) body.push(inferenceBlock(t, m.treatments.length > 1));
  }

  return h('article', { class: `metric metric-${m.role}`, 'data-state': m.state, 'aria-label': `${m.role === 'goal' ? 'Goal' : m.role === 'secondary' ? 'Secondary' : 'Guardrail'} metric ${m.name}` }, head, table, ...body);
}

function inferenceBlock(t, many) {
  if (t.collecting) {
    return h('div', { class: 'inference', vars: { '--c': t.color } }, h('p', { class: 'metric-note' }, `${t.key} vs control: collecting data`));
  }
  const pct = Math.max(0, Math.min(100, t.chance * 100));
  const chance = F.formatChance(t.chance);
  return h(
    'div',
    { class: 'inference', vars: { '--c': t.color } },
    h(
      'div',
      { class: 'inference-top' },
      h('span', { class: 'vs' }, many ? `${t.key} (${t.label}) vs control` : `${t.key} vs control`),
      h('span', { class: 'verdict', 'data-tone': t.verdict.tone }, t.verdict.word),
    ),
    h(
      'div',
      { class: 'chance' },
      h(
        'div',
        { class: 'chance-bar', role: 'img', 'aria-label': `${chance} chance to win; Flagsmith's thresholds are 5% and 95%` },
        h('span', { class: 'chance-fill', vars: { '--w': `${pct}%` } }),
        h('span', { class: 'tick tick-lo', 'aria-hidden': 'true' }),
        h('span', { class: 'tick tick-hi', 'aria-hidden': 'true' }),
      ),
      h('span', { class: 'chance-value' }, chance),
      h('span', { class: 'chance-label' }, 'chance to win'),
    ),
    h(
      'p',
      { class: 'lift' },
      'Lift ',
      h('strong', {}, F.formatLift(t.lift)),
      h('span', { class: 'ci' }, ` · credible interval ${F.formatInterval(t.ciLow, t.ciHigh)}`),
    ),
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

function selectedKey() {
  return app.choice ?? app.state?.winner?.key ?? null;
}

function renderActions(s) {
  const e = s.experiment;
  const variants = F.variantList(e);
  const completed = e.status === 'completed';
  const winnerKey = s.winner?.key ?? null;

  const keys = variants.map((v) => `${v.key}=${v.label}`).join('|');
  if (keys !== app.choiceKeys) {
    app.choiceKeys = keys;
    $('ship-choices').replaceChildren(
      ...variants.map((v) =>
        h(
          'label',
          { class: 'choice', vars: { '--c': v.color } },
          h('input', { type: 'radio', name: 'ship-variant', value: v.key }),
          h('span', { class: 'choice-swatch', 'aria-hidden': 'true' }),
          h('span', { class: 'choice-text' }, h('span', { class: 'choice-label' }, v.label), h('span', { class: 'choice-key' }, v.key)),
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
    /** @type {HTMLElement} */ (label.querySelector('.pick')).hidden = input.value !== winnerKey;
  }
  // A demo job holds the console's lock too: Ship and Revert wait for it.
  const busy = app.busy || demoRunning();
  /** @type {HTMLFieldSetElement} */ ($('ship-fieldset')).disabled = completed || busy;

  const sel = variants.find((v) => v.key === selected);
  const ship = /** @type {HTMLButtonElement} */ ($('ship-btn'));
  ship.disabled = completed || !sel || busy;
  ship.textContent = sel ? `Ship ${sel.label}` : 'Ship winner';
  ship.style.setProperty('--c', sel?.color ?? 'var(--muted)');

  let note;
  if (completed) note = 'Experiment completed: the flag is a plain flag again. Edit it in Flagsmith to change who gets what.';
  else if (!sel) note = 'Flagsmith shows no winner yet. Choose a release to ship it anyway, or wait for data.';
  else if (!s.winner) note = `Your choice: ${sel.key}. Flagsmith shows no winner yet.`;
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
    : `Revert completes the experiment and drains the split: everyone gets control (${control?.label ?? 'control'}).`;
  renderDemo();
}

$('ship-choices').addEventListener('change', (ev) => {
  const t = /** @type {HTMLInputElement} */ (ev.target);
  if (t.name !== 'ship-variant') return;
  app.choice = t.value === app.state?.winner?.key ? null : t.value;
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
  const card = $('demo');
  card.hidden = demo.available !== true;
  if (card.hidden) return;
  const s = app.state;
  const e = s?.experiment;
  const blocked = demoRunning() || app.busy;

  const v = F.visitorsView(e);
  /** @type {HTMLButtonElement} */ ($('visitors-btn')).disabled = !v.enabled || blocked;
  $('visitors-note').textContent = v.note;

  const sw = F.swingView(e, s?.ledger, s?.serving);
  const back = /** @type {HTMLButtonElement} */ ($('swing-back-btn'));
  const forward = /** @type {HTMLButtonElement} */ ($('swing-forward-btn'));
  back.disabled = !sw.enabled || blocked;
  forward.disabled = !sw.enabled || blocked;
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

// ---- start ---------------------------------------------------------------------------------------------------

setInterval(renderConnection, 1000);
refreshNow();
void loadDemoJob();
connectFeed();
