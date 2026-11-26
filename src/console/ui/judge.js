// Turnout judge mode: a full-width dashboard and a guided tour (tour.js) through the whole story.
//   left    the seven steps as a timeline, and the release history
//   centre  the flow line, four live numbers, the live track map, and the stage: the single thing to do now
//   right   "In Flagsmith right now": the experiment, the flag, the results and Feature Health, read from its API
// A welcome card over the dimmed dashboard starts the tour. Other views (the shop, the feature map, the setup check)
// are tabs. Wording and the rules for which button a state allows live in judge-format.js; the tour's script in
// tour-plan.js; small animations in fx.js. Every string goes in through textContent.
import * as J from './judge-format.js';
import { judgeSwingOffer } from './format.js';
import * as P from './tour-plan.js';
import * as FX from './fx.js';
import { createTrack } from './track.js';
import { createTour } from './tour.js';

const STATE_POLL_MS = 5000;
const JOB_POLL_MS = 1000;
const HEALTH_POLL_MS = 10000;
const DEMO_MAX_MS = 2000;
const SPARK_BARS = 40;
const WELCOME_KEY = 'turnout-judge-welcome';
const FLAGSMITH_TAB = 'turnout-flagsmith';
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

// The per-boot token the server put in the page. Every /api/* call carries it; without it the server refuses.
const TOKEN = document.querySelector('meta[name="turnout-console"]')?.getAttribute('content') ?? '';
const TOKEN_HEADER = 'x-turnout-console';
// Server mode's public view (/judge on the server's hostname): the API lives under /judge/api/, every action is refused.
const BASE = document.querySelector('meta[name="turnout-base"]')?.getAttribute('content') ?? '';
const READONLY = document.querySelector('meta[name="turnout-readonly"]') !== null;
const READONLY_TEXT = 'This is the public, read-only view. It runs by itself; actions run only from the console on the server.';
if (READONLY) {
  document.body.classList.add('is-readonly');
  // The setup check and the feature map are the console's, not public: drop their tabs. Flagsmith's dashboard and
  // the full console are private (SSH tunnel): drop their links too.
  for (const tab of ['map', 'setup']) {
    document.querySelector(`.tab[data-tab="${tab}"]`)?.remove();
    document.getElementById(`tab-${tab}`)?.remove();
  }
  document.getElementById('link-flagsmith')?.remove();
  for (const a of document.querySelectorAll('.footer a[href="/"]')) a.remove();
  // The welcome card: a live demo that runs on its own, and one button that narrates it.
  for (const el of document.querySelectorAll('#welcome .welcome-mode')) el.remove();
  const sub = document.querySelector('#welcome .welcome-sub');
  sub?.after(
    Object.assign(document.createElement('p'), {
      className: 'welcome-live',
      textContent:
        "This is a live, read-only demo running on its own: Turnout's autopilot sends simulated visitors, asks Flagsmith for results and follows Turnout's recommendation, round and round. Nothing here needs a click or a sign-in.",
    }),
  );
  const go = document.getElementById('tour-start');
  if (go) go.textContent = 'Watch the tour';
  const skip = document.getElementById('welcome-skip');
  if (skip) skip.textContent = 'Just watch the dashboard';
  const label = document.querySelector('#tour-open .appbar-tour-label');
  if (label) label.textContent = 'Watch tour';
  document.getElementById('tour-open')?.setAttribute('aria-label', 'Watch the tour');
}

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
    else if (k === 'on') for (const [name, fn] of Object.entries(v)) node.addEventListener(name, fn);
    else if (k.startsWith('data-') || k.startsWith('aria-') || ['role', 'scope', 'for', 'target', 'rel'].includes(k)) node.setAttribute(k, v === true ? '' : String(v));
    else node[k] = v;
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const NS = 'http://www.w3.org/2000/svg';
/** A 24×24 line icon. */
function icon(d) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ic');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}
const ICON_OUT = 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5';
// The flow line's stages, drawn as icons (the only "Step x of 7" on the page is the demo's own).
const PHASE_ICON = {
  deploy: 'M12 16V4M7 9l5-5 5 5M5 20h14',
  split: 'M12 21v-7M12 14 6 8M12 14l6-6M6 8V4M18 8V4',
  measure: 'M4 20V11M10 20V5M16 20v-6M2 20h20',
  decide: 'M12 4v16M5 8h14M5 8l-3 6a3 3 0 0 0 6 0zM19 8l-3 6a3 3 0 0 0 6 0zM8 20h8',
  everyone: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c.8-3.6 3.3-5.5 6.5-5.5s5.7 1.9 6.5 5.5M16 4.8a3.4 3.4 0 0 1 0 6.4M18 14.8c1.9.7 3 2.4 3.5 5.2',
};
const HISTORY_SHOWN = 3; // the release history shows the latest few; "Show all" opens the rest
const JOB_FRESH_MS = 8000; // a finished job's panel stays open this long after a new step became current

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtTime = (ms) => (Number.isFinite(ms) ? timeFmt.format(ms) : '');
const fmtDateTime = (ms) => (Number.isFinite(ms) ? dateTimeFmt.format(ms) : '');
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** "just now", "12 min ago", "3 h ago". */
function ago(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return fmtDateTime(ms);
}

const ui = {
  state: null,
  stateAt: 0,
  error: null, // { kind: 'expired' | 'network' | 'http', text }
  runError: null,
  posting: false,
  verify: null, // the last verify job's result
  rules: [],
  stateTimer: 0,
  jobTimer: 0,
  tab: 'story',
  shopMode: null,
  health: undefined, // undefined: not asked yet; null: not configured (404)
  retryMs: 1000, // the state fetch's back-off after a failure: 1 s, 2 s, 4 s, then 8 s
  retryTimer: 0,
  historyAll: false,
  peak: 0, // the highest req/s in the latest burst of traffic
  framesPreloaded: false,
};

/** Rebuilds a slot only when what it shows changed. */
function setSlot(el, sig, build) {
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  el.replaceChildren(...[build()].flat().filter(Boolean));
}

/** Sets an element's text only when it changed (keeps screen readers and selections calm). */
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

const busy = () => ui.posting || J.jobRunning(ui.state);

// ---- fx.js, guarded: a missing helper never breaks the page ------------------------------------------------------

function fx(name, ...args) {
  const fn = FX[name];
  if (typeof fn !== 'function') return Promise.resolve();
  try {
    return Promise.resolve(fn(...args)).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

const countSeq = new WeakMap();
/** Counts an element up to a value (fx.countUp), and always lands on the exact formatted value. */
function countTo(el, value, format, ms = 900, from = undefined) {
  const seq = (countSeq.get(el) ?? 0) + 1;
  countSeq.set(el, seq);
  const land = () => {
    if (countSeq.get(el) === seq) setText(el, format(value));
  };
  if (motion.matches || typeof FX.countUp !== 'function') return Promise.resolve(land());
  return fx('countUp', el, value, { ms, format, from }).then(land);
}

/** A KPI number: counts up when it changes; "—" when there is none. */
function setCount(el, value, format) {
  const key = Number.isFinite(value) ? String(value) : '';
  if (el.dataset.value === key) return;
  el.dataset.value = key;
  if (!Number.isFinite(value)) {
    countSeq.set(el, (countSeq.get(el) ?? 0) + 1);
    // Take over any count still running on this tile (it would write its old number back), then show the dash.
    fx('countUp', el, 0, { ms: 0, format: () => '—' });
    setText(el, '—');
    return;
  }
  countTo(el, value, format);
}

// ---- state -------------------------------------------------------------------------------------------------------

async function loadState() {
  clearTimeout(ui.retryTimer);
  ui.retryTimer = 0;
  try {
    const res = await api('/api/judge/state', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (res.status === 403) return expire();
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || !Array.isArray(body.steps)) {
      // The detail goes in the banner's tooltip; the words stay calm.
      fail('http', body?.error ? String(body.error) : `HTTP ${res.status}`);
      return;
    }
    if (ui.state?.current !== body.current) ui.runError = null;
    ui.state = body;
    ui.stateAt = Date.now();
    ui.error = null;
    ui.retryMs = 1000;
    document.body.classList.remove('is-loading');
    if (body.job?.action === 'verify' && body.job.status === 'done' && body.job.result) ui.verify = body.job.result;
    render();
  } catch {
    fail('network', "can't reach the Turnout console server");
  } finally {
    if (J.jobRunning(ui.state)) startJobPoll();
  }
}

/** A failed state fetch: a calm banner with "Retry now", and a retry after 1 s, 2 s, 4 s, then every 8 s. */
function fail(kind, detail) {
  ui.error = { kind, text: ui.state ? 'Lost touch with the demo for a moment, retrying…' : "Couldn't reach the demo yet, retrying…", detail };
  renderBanner();
  if (ui.retryTimer) return;
  ui.retryTimer = setTimeout(() => {
    ui.retryTimer = 0;
    loadState();
  }, ui.retryMs);
  ui.retryMs = Math.min(ui.retryMs * 2, 8000);
}

function expire() {
  ui.error = { kind: 'expired', text: "This page's session expired — reload" };
  clearTimeout(ui.stateTimer);
  clearTimeout(ui.jobTimer);
  tour.end();
  renderBanner();
  if (ui.state) renderStage(ui.state);
}

function scheduleState() {
  clearTimeout(ui.stateTimer);
  if (ui.error?.kind === 'expired') return;
  ui.stateTimer = setTimeout(async () => {
    if (!document.hidden && !J.jobRunning(ui.state)) await loadState();
    scheduleState();
  }, STATE_POLL_MS);
}

function startJobPoll() {
  if (ui.jobTimer || ui.error?.kind === 'expired') return;
  const tick = async () => {
    try {
      const res = await api('/api/judge/job', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (res.status === 403) {
        ui.jobTimer = 0;
        return expire();
      }
      const body = await res.json().catch(() => null);
      if (res.ok && body && ui.state) {
        ui.state.job = body.job ?? null;
        if (J.jobRunning(ui.state)) {
          renderStage(ui.state);
          renderFlow(ui.state);
          renderSteps(ui.state);
          tour.update(ui.state);
        }
      }
    } catch {
      /* the next tick retries */
    }
    if (J.jobRunning(ui.state)) {
      ui.jobTimer = setTimeout(tick, JOB_POLL_MS);
      return;
    }
    ui.jobTimer = 0;
    await loadState(); // fresh state first: the tour's next beat reads it
  };
  ui.jobTimer = setTimeout(tick, JOB_POLL_MS);
}

async function run(action, payload = {}) {
  if (busy() || !ui.state) return;
  if (READONLY) {
    ui.runError = READONLY_TEXT;
    renderStage(ui.state);
    return;
  }
  ui.runError = null;
  ui.posting = true;
  renderStage(ui.state);
  try {
    const res = await api('/api/judge/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, experimentId: ui.state?.experiment?.id, ...payload }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 403) return expire();
    if (res.status === 202 && body.job) {
      ui.state.job = body.job;
      ui.posting = false;
      render();
      startJobPoll();
      return;
    }
    ui.runError = J.runErrorText(res.status, body);
  } catch {
    ui.runError = "Couldn't reach the Turnout console server. Nothing was started.";
  } finally {
    ui.posting = false;
  }
  await loadState();
}

// ---- page ----------------------------------------------------------------------------------------------------

function render() {
  renderBanner();
  const s = ui.state;
  if (!s) return;
  const fs = /** @type {HTMLAnchorElement | null} */ (document.getElementById('link-flagsmith'));
  if (fs && s.dashboardUrl) fs.href = s.dashboardUrl;
  renderContext(s);
  renderSteps(s);
  renderFlow(s);
  renderKpis(s);
  renderTrack(s);
  renderStage(s);
  renderHistory(s);
  renderFlagsmith(s);
  renderShopHead(s);
  preloadFrames(s);
  tour.update(s);
}

// The Flagsmith column scrolls on its own: a soft fade at the foot says there is more below. The left column (the
// steps and the history) never does: it stays in view while it fits on the screen, and scrolls with the page when
// it doesn't, so the history is never cut off.
function syncScrollCues() {
  const left = document.querySelector('.col-left');
  if (left) {
    const box = /** @type {HTMLElement} */ (left);
    const css = getComputedStyle(document.documentElement);
    const room = innerHeight - (parseFloat(css.getPropertyValue('--appbar-h')) || 64) - 2 * (parseFloat(getComputedStyle(box).rowGap) || 20);
    box.classList.toggle('is-sticky', getComputedStyle(box).display !== 'contents' && box.offsetHeight <= room);
  }
  for (const el of document.querySelectorAll('.fs-panel')) {
    const box = /** @type {HTMLElement} */ (el);
    const scrolls = getComputedStyle(box).overflowY === 'auto' && box.scrollHeight > box.clientHeight + 4;
    box.classList.toggle('has-more', scrolls && box.scrollTop + box.clientHeight < box.scrollHeight - 4);
  }
}
for (const el of document.querySelectorAll('.fs-panel')) el.addEventListener('scroll', syncScrollCues, { passive: true });
addEventListener('resize', syncScrollCues);

function renderBanner() {
  const e = ui.error;
  $('banner').hidden = !e;
  setText($('banner-text'), e ? e.text : '');
  $('banner-text').title = e?.detail ?? '';
  $('banner-reload').hidden = e?.kind !== 'expired';
  $('banner-retry').hidden = !e || e.kind === 'expired';
}
$('banner-reload').addEventListener('click', () => location.reload());
$('banner-retry').addEventListener('click', () => {
  ui.retryMs = 1000;
  loadState();
});

// ---- app bar: what Flagsmith is running ------------------------------------------------------------------------

function renderContext(s) {
  const e = s.experiment;
  setText($('ctx-source'), s.live ? `Flagsmith · live ${s.live}` : 'Flagsmith');
  $('ctx-exp').hidden = !e;
  $('ctx-status').hidden = !e;
  if (!e) return;
  setText($('ctx-exp'), `Experiment ${e.id} · ${e.name}`);
  $('ctx-exp').title = e.hypothesis ?? '';
  $('ctx-status').dataset.status = e.status;
  setText($('ctx-status'), e.status);
}

// ---- left: the steps, as a timeline -----------------------------------------------------------------------------

/**
 * A step's title as the page shows it. The server names the decide step "Ship winner"; below Flagsmith's 95% bar
 * there is no winner, so the page says so instead.
 */
function stepTitle(s, step) {
  if (step.id !== 'decide' || step.title !== 'Ship winner') return step.title;
  const c = s.results?.winner?.chanceToWin;
  if (!Number.isFinite(c) || c >= 0.95) return step.title;
  const d = J.latestDecision(s);
  return s.experiment?.status === 'completed' && d?.decision === 'shipped' && d.experimentId === s.experiment.id ? "Shipped Flagsmith's pick" : 'Ship or revert';
}

const STEP_STATE = { done: 'Done', current: 'Now', todo: 'Next', optional: 'Optional' };

/** One line under a step's title: what it did (done) or what it does (now / next). */
function stepLine(s, step, status) {
  if (status === 'done') {
    const ev = J.stepEvidence(s, step.id, { verify: ui.verify });
    if (ev.length) return ev[0];
  }
  return J.stepGuide(step.id, s)?.you ?? '';
}

/** How far the running job is: 0..1, or null when nothing of this step runs. */
function jobFraction(s) {
  const job = s.job;
  if (job?.status !== 'running') return null;
  if (job.progress?.total) return Math.min(1, job.progress.done / job.progress.total);
  const stages = Array.isArray(job.stages) ? job.stages : [];
  if (!stages.length) return 0.1;
  const done = stages.filter((x) => x.status === 'done').length;
  const running = stages.some((x) => x.status === 'running') ? 0.5 : 0;
  return Math.min(1, (done + running) / stages.length);
}

function renderSteps(s) {
  const steps = s.steps ?? [];
  const done = s.current === 'reset';
  setText($('steps-meta'), J.progressText(s));
  const items = steps.map((step) => {
    const status = step.id === s.current ? 'current' : step.status;
    return { id: step.id, title: stepTitle(s, step), status, line: stepLine(s, step, status) };
  });
  setSlot($('steps-list'), JSON.stringify([items, done]), () =>
    items.map((x, i) =>
      h(
        'li',
        { class: 'step-item', 'data-status': x.status, 'data-step': x.id, 'aria-current': x.status === 'current' ? 'step' : null },
        h('span', { class: 'step-num', 'aria-hidden': 'true' }, x.status === 'done' ? '✓' : String(i + 1)),
        h(
          'span',
          { class: 'step-body' },
          h('span', { class: 'step-name' }, x.title),
          x.line ? h('span', { class: 'step-desc', title: x.line }, x.line) : null,
          x.status === 'current' ? h('span', { class: 'step-progress', 'aria-hidden': 'true' }, h('span', { class: 'step-progress-fill' })) : null,
        ),
        h('span', { class: 'step-state' }, STEP_STATE[x.status] ?? x.status),
        h('span', { class: 'sr-only' }, `: ${J.stepStatusText(x.status, x.status === 'current')}`),
      ),
    ),
  );
  // The current step's bar: the running job's progress, or a quiet shimmer while it waits for a click.
  const cur = $('steps-list').querySelector('.step-item[data-status="current"]');
  if (cur) {
    const f = jobFraction(s);
    cur.dataset.working = String(f != null);
    /** @type {HTMLElement} */ (cur.querySelector('.step-progress-fill'))?.style.setProperty('--w', `${Math.round((f ?? 0) * 100)}%`);
  }
}

// ---- the flow line: deploy → split → measure → decide → everyone -----------------------------------------------

const flowEls = P.PHASES.map((p) =>
  h(
    'li',
    { class: 'flow-step', 'data-phase': p.id },
    h('span', { class: 'flow-dot', 'aria-hidden': 'true' }, icon(PHASE_ICON[p.id] ?? PHASE_ICON.deploy)),
    h('span', { class: 'flow-text' }, h('strong', {}, p.label), h('span', {}, p.sub)),
  ),
);
$('flow-steps').append(...flowEls);

function renderFlow(s) {
  // The finished loop: every stage done, the line full.
  const complete = s.current === 'reset' && !J.jobRunning(s);
  const active = complete ? P.PHASES.length : P.PHASES.findIndex((p) => p.id === P.phaseOf(s.current));
  const working = J.jobRunning(s);
  flowEls.forEach((li, i) => {
    li.dataset.state = i < active ? 'done' : i === active ? (working ? 'working' : 'active') : 'todo';
    if (i === active) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  });
  $('flowline').style.setProperty('--progress', `${(Math.min(P.PHASES.length - 1, Math.max(0, active)) / (P.PHASES.length - 1)) * 100}%`);
}

// ---- KPI tiles ---------------------------------------------------------------------------------------------------

/** Flagsmith's identity count for this experiment: the goal metric's n, summed over arms. */
function identities(s) {
  const goal = s.results?.metrics?.find((m) => m.role === 'goal') ?? s.results?.metrics?.[0];
  return goal ? Object.values(goal.arms ?? {}).reduce((sum, a) => sum + (Number(a?.n) || 0), 0) : 0;
}

const pct = (x) => J.formatChance(x / 100);
const kpi = {}; // name → [element, value, format], for the count-up demo

function renderKpis(s) {
  const sent = s.totals?.visitorsSent ?? 0;
  const ids = identities(s);
  const visitors = Math.max(sent, ids);
  kpi.visitors = [$('kpi-visitors'), visitors, J.formatInt];
  setCount($('kpi-visitors'), visitors, J.formatInt);
  setText(
    $('kpi-visitors-sub'),
    ids > sent ? "Flagsmith's identity count" : sent ? `sent through Turnout${ids ? ` · ${J.formatInt(ids)} counted by Flagsmith` : ''}` : 'none yet: step 1 sends them',
  );

  const accepted = s.totals?.eventsAccepted;
  const rejected = s.totals?.eventsRejected;
  kpi.events = [$('kpi-events'), Number.isFinite(accepted) ? accepted : null, J.formatInt];
  setCount($('kpi-events'), Number.isFinite(accepted) ? accepted : null, J.formatInt);
  setText($('kpi-events-sub'), Number.isFinite(accepted) ? `${J.formatInt(rejected ?? 0)} rejected · all runs` : "the counter isn't available here");

  const w = s.results?.winner;
  const chance = w && Number.isFinite(w.chanceToWin) ? Math.round(w.chanceToWin * 1000) / 10 : null;
  kpi.chance = [$('kpi-chance'), chance, pct];
  setCount($('kpi-chance'), chance, pct);
  const losing = s.results?.losingGuardrails?.length ?? 0;
  setText(
    $('kpi-chance-sub'),
    w
      ? `${w.release ?? w.key} ${chance != null && chance >= 95 ? 'wins, above 95%' : 'leads · below 95%'}${losing ? ' · guardrail losing' : ''}`
      : s.results
        ? 'no leader yet'
        : 'no results yet',
  );
  const tile = /** @type {HTMLElement} */ ($('kpi-chance').closest('.kpi'));
  // Winning the goal while a guardrail loses is a warning, not a contradiction: amber, not red.
  tile.dataset.tone = losing ? 'warn' : chance != null && chance >= 95 ? 'good' : 'neutral';
}

// Live requests per second: from the track's counters (or our own count of the feed), with a 40-second sparkline.
const ownTimes = [];
const sparkHist = Array(SPARK_BARS).fill(0);
const sparkBars = Array.from({ length: SPARK_BARS }, () => h('span', { class: 'spark-bar' }));
$('kpi-rate-spark').append(...sparkBars);

function currentRate() {
  if (typeof track.rates === 'function') {
    try {
      const all = track.rates() ?? {};
      return Object.values(all).reduce((sum, r) => sum + (Number.isFinite(r) ? r : 0), 0);
    } catch {
      /* fall back to our own count */
    }
  }
  const now = performance.now();
  while (ownTimes.length && ownTimes[0] < now - 5000) ownTimes.shift();
  return J.perSecond(ownTimes, now);
}

function tickRate() {
  const r = currentRate();
  const prev = sparkHist[sparkHist.length - 1] ?? 0;
  if (r > 0) ui.peak = prev > 0 ? Math.max(ui.peak, r) : r; // a new burst starts a new peak
  setText($('kpi-rate'), r < 10 ? r.toFixed(1) : String(Math.round(r)));
  const idle = r <= 0;
  /** @type {HTMLElement} */ ($('kpi-rate').closest('.kpi')).dataset.idle = String(idle);
  const fmt = (x) => (x < 10 ? x.toFixed(1) : String(Math.round(x)));
  setText($('kpi-rate-sub'), idle ? (ui.peak > 0 ? `idle · peak ${fmt(ui.peak)} req/s last run` : 'idle · no traffic yet') : `through Turnout · peak ${fmt(ui.peak)}`);
  sparkHist.push(r);
  sparkHist.shift();
  const top = Math.max(1, ...sparkHist);
  sparkHist.forEach((v, i) => sparkBars[i].style.setProperty('--h', `${Math.max(4, (v / top) * 100)}%`));
  kpi.rate = [$('kpi-rate'), r, (x) => (x < 10 ? x.toFixed(1) : String(Math.round(x)))];
}

// ---- the stage: the one thing to do now --------------------------------------------------------------------------

const stageAction = (s) => {
  if (s.current === 'reset') return J.stepControls(s, 'reset');
  return J.stepControls(s, s.current, { visitors: J.JUDGE_VISITORS });
};

/** The one button: the step's recommended action (the first primary one), usable or not. */
function primaryButton(c) {
  return c.buttons.find((b) => b.tone === 'primary') ?? c.buttons[0] ?? null;
}

// The stage's button is one element per action: posting, a busy job or a refused click only change its text and
// state, so the tour's spotlight (and the judge's focus) never lose it.
const stageBtn = { el: /** @type {HTMLButtonElement | null} */ (null), action: '', payload: {} };

function stageButton(b, done) {
  if (!b) {
    stageBtn.el?.remove();
    stageBtn.el = null;
    stageBtn.action = '';
    return null;
  }
  if (!stageBtn.el || stageBtn.action !== b.action) {
    stageBtn.el?.remove();
    stageBtn.action = b.action;
    stageBtn.el = /** @type {HTMLButtonElement} */ (
      h('button', { class: 'btn btn-primary stage-go', type: 'button', 'data-key': `btn-${b.action}`, on: { click: () => run(stageBtn.action, stageBtn.payload) } }, b.label)
    );
    $('stage-go-slot').replaceChildren(stageBtn.el);
  }
  stageBtn.payload = b.payload;
  stageBtn.el.classList.toggle('btn-secondary', done);
  setText(stageBtn.el, b.label);
  return stageBtn.el;
}

/** The optional swing after a ship (format.js decides when), with the swing step's own note as its tooltip. */
function swingOffer(s) {
  const offer = judgeSwingOffer(s);
  return offer && { ...offer, note: J.stepControls(s, 'swing').note };
}

function renderStage(s) {
  const steps = s.steps ?? [];
  const done = s.current === 'reset';
  const step = steps.find((x) => x.id === s.current);
  const guide = done ? null : J.stepGuide(s.current, s);
  const kicker = done ? 'All steps done' : `${J.progressText(s)} · ${P.PHASES.find((p) => p.id === P.phaseOf(s.current))?.label ?? ''}`;
  const heading = done ? 'The loop is complete' : step ? stepTitle(s, step) : '';
  setText($('stage-kicker'), kicker);
  setText($('stage-title'), heading);
  setText($('stage-text'), done ? "Every decision is in the release history, with Flagsmith's numbers. Start over to run it again." : guide ? `${guide.you} ${guide.proves}` : '');
  $('stage-where').hidden = !guide?.where;
  setText($('stage-where'), guide?.where ?? '');

  // One prominent button. After a ship, the optional swing sits beside it as a quiet secondary action; Ship anyway
  // and the visitor count live in the full console.
  const c = stageAction(s);
  // The public view has no buttons: the autopilot runs the steps, and the stage says what it does next.
  const b = READONLY ? null : primaryButton(c);
  const disabled = busy() || ui.error?.kind === 'expired' || !b || b.disabled;
  const btn = stageButton(b, done);
  if (btn) btn.disabled = disabled;
  const swing = READONLY ? null : swingOffer(s);
  const auto = READONLY ? J.autopilotLine(s) : null;
  setSlot($('stage-extra'), JSON.stringify([c.countdown, ui.runError, swing, auto?.kind, s.autopilot?.next, s.autopilot?.phase, s.job?.status]), () => [
    auto ? h('p', { class: 'autopilot-line', id: 'autopilot-line', role: 'status', 'data-kind': auto.kind }, auto.text) : null,
    swing
      ? h('button', { class: 'btn btn-small btn-ghost stage-swing', type: 'button', 'data-key': `btn-${swing.action}`, title: swing.note, on: { click: () => run(swing.action) } }, swing.label)
      : null,
    c.countdown ? h('p', { class: 'countdown', 'data-countdown': c.countdown }, J.countdownText(c.countdown)) : null,
    ui.runError && !READONLY ? h('p', { class: 'jstep-error', role: 'alert' }, ui.runError) : null,
  ]);
  const swingBtn = /** @type {HTMLButtonElement | null} */ ($('stage-extra').querySelector('.stage-swing'));
  if (swingBtn) swingBtn.disabled = busy() || ui.error?.kind === 'expired';
  // The step's caveat, in Flagsmith's terms: an inconclusive lead says so next to the button.
  const caveat = s.current === 'decide' && /inconclusive|losing|Not a win/.test(c.note);
  $('stage-note').hidden = !c.note || busy();
  $('stage-note').dataset.tone = caveat ? 'warn' : '';
  setText($('stage-note'), c.note);

  renderVisual(s);
  renderDock(s, { kicker, heading, b, disabled });
}

// ---- the action dock: the stage's button at the foot of the screen while the stage is scrolled away -------------

const dock = { stageInView: true, seen: false };

function renderDock(s, { kicker, heading, b, disabled }) {
  const go = /** @type {HTMLButtonElement} */ ($('dock-go'));
  const job = J.jobView(s.job);
  setText($('dock-kicker'), job?.running ? 'Working' : kicker);
  setText($('dock-title'), job?.running ? `${job.title}…` : heading);
  go.hidden = !b;
  if (b) {
    go.className = `btn ${s.current === 'reset' ? 'btn-secondary' : 'btn-primary'} dock-go`;
    setText(go, b.label);
    go.disabled = disabled;
  }
  syncDock();
}

function syncDock() {
  $('action-dock').hidden = dock.stageInView || !ui.state || ui.tab !== 'story';
}

$('dock-go').addEventListener('click', () => stageBtn.el?.click());
$('dock-see').addEventListener('click', () => {
  $('stage').scrollIntoView({ behavior: motion.matches ? 'auto' : 'smooth', block: 'start' });
});
if (typeof IntersectionObserver === 'function') {
  // "In view" means the stage shows down to its button (about 200 px of it), not just its top edge.
  new IntersectionObserver(
    (entries) => {
      for (const e of entries) dock.stageInView = e.isIntersecting;
      syncDock();
    },
    { rootMargin: '0px 0px -200px 0px', threshold: 0 },
  ).observe($('stage'));
}

function renderVisual(s) {
  const parts = [];
  const sig = [];
  const job = J.jobView(s.job, Date.now(), s.results?.losingGuardrails ?? []);
  // The results, from the moment Flagsmith has them until the decision is made.
  if (s.results && (s.current === 'score' || s.current === 'decide')) {
    const v = J.resultsView(s);
    if (v) {
      parts.push(() => resultsPanel(v, s.releases));
      sig.push(v);
    }
  }
  if (s.current !== 'visitors' || job?.running) {
    const vv = J.verifySummary(ui.verify);
    if (vv && job?.action === 'verify' && !job.running) {
      parts.push(() => verifyBars(vv, s.releases));
      sig.push(vv);
    }
  }
  setSlot($('stage-visual-static'), JSON.stringify(sig), () => parts.map((build) => build()));
  renderJob(job);
}

function chanceBar(m, label) {
  return h(
    'div',
    { class: 'chance-bar', role: 'img', 'aria-label': label, vars: { '--c': m.verdict.tone === 'bad' ? 'var(--bad)' : m.verdict.tone === 'good' ? 'var(--treatment)' : 'var(--faint)' } },
    h('span', { class: 'chance-fill', vars: { '--w': `${m.v2.chanceRatio * 100}%` } }),
    h('span', { class: 'tick tick-lo', 'aria-hidden': 'true' }),
    h('span', { class: 'tick tick-hi', 'aria-hidden': 'true' }),
  );
}

function resultsPanel(v, releases) {
  // Column headers name the arms by release: control first, then v2 (resultsView sorts them that way).
  const arms = v.metrics[0]?.arms ?? [];
  const armHead = (i, fallback) => {
    const a = arms[i];
    return h('span', { class: 'jarm-rel', vars: { '--c': J.releaseColor(releases, a?.release) } }, a ? [a.release ?? a.key, h('small', { class: 'jarm-key' }, a.key)] : fallback);
  };
  return h(
    'div',
    { class: 'jresults' },
    h('p', { class: 'jwinner', 'data-tone': v.winner.tone }, v.winner.text),
    v.losing.length ? h('ul', { class: 'losing-list', role: 'note' }, v.losing.map((t) => h('li', {}, t))) : null,
    h(
      'div',
      { class: 'jtable', role: 'table', 'aria-label': "Flagsmith's results per metric" },
      h(
        'div',
        { class: 'jrow jrow-head', role: 'row' },
        h('span', { role: 'columnheader' }, 'Metric'),
        h('span', { role: 'columnheader' }, 'Verdict'),
        h('span', { role: 'columnheader' }, armHead(0, 'control')),
        h('span', { role: 'columnheader' }, armHead(1, 'v2')),
        h('span', { role: 'columnheader' }, 'Chance v2 wins'),
      ),
      v.metrics.map((m) =>
        h(
          'div',
          { class: `jrow jrow-${m.role}`, role: 'row', 'data-tone': m.verdict.tone },
          h(
            'span',
            { class: 'jcell-metric', role: 'cell' },
            h('span', { class: 'metric-name', title: m.name }, m.name),
            h('span', { class: 'jcell-role', 'data-role': m.role }, m.roleLabel),
          ),
          h('span', { role: 'cell' }, h('span', { class: 'verdict', 'data-tone': m.verdict.tone }, m.verdict.word)),
          ...[0, 1].map((i) => {
            const a = m.arms[i];
            return a
              ? h('span', { class: 'jcell-arm', role: 'cell', 'data-label': a.release ?? a.key }, h('strong', {}, a.value), h('span', { class: 'jcell-n' }, `n ${a.n}`))
              : h('span', { class: 'jcell-none', role: 'cell' }, '—');
          }),
          m.v2
            ? h(
                'span',
                { class: 'jcell-chance', role: 'cell' },
                chanceBar(m, `v2: ${m.v2.chance} chance to win; Flagsmith's thresholds are 5% and 95%`),
                h('strong', {}, m.v2.chance),
                h('span', { class: 'jcell-lift' }, `lift ${m.v2.lift}`),
                h('span', { class: 'jcell-lift jcell-interval', title: "Flagsmith's credible interval for v2's lift" }, `interval ${m.v2.interval}`),
              )
            : h('span', { class: 'jcell-none', role: 'cell' }, 'no comparison yet'),
        ),
      ),
    ),
    h('p', { class: 'provenance' }, "Flagsmith's results, as returned", v.asOf ? ` · computed ${fmtTime(v.asOf)}` : ''),
  );
}

function verifyBars(v, releases) {
  return h(
    'div',
    { class: 'verify' },
    h(
      'ul',
      { class: 'verify-bars', 'aria-label': 'New visitors by release' },
      v.bars.map((b) =>
        h(
          'li',
          { vars: { '--c': J.releaseColor(releases, b.release) } },
          h('span', { class: 'verify-label' }, b.release),
          h('span', { class: 'verify-bar', 'aria-hidden': 'true' }, h('span', { class: 'verify-fill', vars: { '--w': `${b.pct}%` } })),
          h('span', { class: 'verify-count' }, J.formatInt(b.count)),
        ),
      ),
    ),
    h('p', {}, v.text),
    v.check ? h('p', { class: 'verify-check' }, v.check) : null,
  );
}

// The job panel: a checklist of its stages, a progress bar, and what changed in Flagsmith. The log folds away.
const job = {
  root: /** @type {HTMLDetailsElement} */ (h('details', { class: 'jobp', 'aria-label': 'Progress of the running step', hidden: true, open: true })),
  spinner: h('span', { class: 'spinner', 'aria-hidden': 'true' }),
  check: h('span', { class: 'jobp-check', 'aria-hidden': 'true' }, '✓'),
  kicker: h('span', { class: 'jobp-kicker' }, 'Last step'),
  title: h('strong', { class: 'jobp-title' }),
  sum: h('span', { class: 'jobp-sum' }),
  elapsed: h('span', { class: 'jobp-elapsed' }),
  body: h('div', { class: 'jobp-body' }),
  stages: h('ol', { class: 'jobp-stages', 'aria-label': 'Stages' }),
  bar: h('div', { class: 'jobp-progress', hidden: true }),
  barFill: h('span', { class: 'jobp-progress-fill' }),
  barText: h('span', { class: 'jobp-progress-text' }),
  outcome: h('p', { class: 'jobp-outcome', role: 'status' }),
  guardrails: h('ul', { class: 'losing-list' }),
  diff: h('div', { class: 'jobp-diff' }),
  log: h('ol', { class: 'jobp-log', role: 'log', 'aria-label': 'Technical log' }),
  tech: h('details', { class: 'jobp-tech' }),
  id: null,
  lines: 0,
  last: false, // shown as the one-line "last step" summary
  keepUntil: 0, // the tour is showing this job's before → after: it stays open until then
  closeTimer: 0,
};
job.bar.append(job.barFill, job.barText);
job.tech.append(h('summary', {}, 'Technical log'), job.log);
job.body.append(job.stages, job.bar, job.outcome, job.guardrails, job.diff, job.tech);
job.root.append(h('summary', { class: 'jobp-head' }, job.spinner, job.check, job.kicker, job.title, job.sum, job.elapsed), job.body);
// Only the collapsed summary toggles: a running or fresh panel keeps its head inert.
job.root.addEventListener('click', (ev) => {
  if (!job.last && ev.target instanceof Element && ev.target.closest('.jobp-head') && ev.target.closest('details') === job.root) ev.preventDefault();
});
$('stage-visual').append(job.root);

const STAGE_MARK = { done: '✓', failed: '✕' };

/**
 * Whether a finished job is the previous step's: a new step is current, it ended over JOB_FRESH_MS ago, and the tour
 * isn't showing it. Then it folds into one line; it opens again on a click.
 */
function staleJob(v, s) {
  if (!v || v.running) return false;
  if (v.step === s?.current) return false; // the step hasn't moved on (it failed, say): keep it open
  const ended = J.parseTime(s?.job?.finishedAt);
  const until = Math.max(Number.isFinite(ended) ? ended + JOB_FRESH_MS : 0, job.keepUntil);
  const left = until - Date.now();
  if (left > 0) {
    clearTimeout(job.closeTimer);
    job.closeTimer = setTimeout(() => ui.state && renderStage(ui.state), left + 50);
    return false;
  }
  return true;
}

function renderJob(v) {
  // A finished job stays on show; once a new step is current it folds into a one-line "last step".
  if (!v) {
    job.root.hidden = true;
    return;
  }
  job.root.hidden = false;
  if (job.id !== v.id) {
    job.id = v.id;
    job.lines = 0;
    job.last = null; // unknown: the next line sets the class and the open state for this job
    job.keepUntil = 0;
    job.root.open = true;
    job.log.replaceChildren();
    job.root.classList.remove('is-new');
    void job.root.offsetWidth;
    job.root.classList.add('is-new');
  }
  const last = staleJob(v, ui.state);
  if (last !== job.last) {
    job.last = last;
    job.root.classList.toggle('is-last', last);
    job.root.open = !last;
    job.root.setAttribute('aria-label', last ? 'The last step that ran' : 'Progress of the running step');
  }
  if (!last && !job.root.open) job.root.open = true;
  job.root.dataset.tone = v.tone;
  job.root.dataset.status = v.status;
  job.spinner.hidden = !v.running;
  setText(job.title, v.running ? `${v.title}…` : v.title);
  setText(job.elapsed, v.status === 'done' ? `done in ${v.elapsed}` : v.elapsed);
  const moved = v.changes && v.changes.after ? J.routingDiff(v.changes.before, v.changes.after).filter((r) => r.changed).length : 0;
  setText(job.sum, v.status === 'failed' ? '· stopped' : moved ? `· ${moved} change${moved > 1 ? 's' : ''} in Flagsmith` : '');
  setSlot(job.stages, JSON.stringify(v.stages), () =>
    v.stages.map((st, i) =>
      h(
        'li',
        { class: 'jstage', 'data-status': st.status },
        h('span', { class: 'jstage-mark', 'aria-hidden': 'true' }, st.status === 'running' ? h('span', { class: 'spinner' }) : STAGE_MARK[st.status] ?? String(i + 1)),
        h('span', { class: 'jstage-title' }, st.title),
        h('span', { class: 'sr-only' }, ` (${st.status === 'todo' ? 'to do' : st.status})`),
      ),
    ),
  );
  const p = v.progress;
  job.bar.hidden = !p || !p.total;
  if (p && p.total) {
    job.barFill.style.setProperty('--w', `${Math.min(100, (p.done / p.total) * 100)}%`);
    setText(job.barText, `${J.formatInt(p.done)} of ${J.formatInt(p.total)} visitors`);
  }
  for (const line of v.log.slice(job.lines)) job.log.append(h('li', {}, h('span', { class: 'jobp-time' }, fmtTime(line.at)), ' ', line.text));
  if (v.log.length < job.lines) job.log.replaceChildren(...v.log.map((line) => h('li', {}, h('span', { class: 'jobp-time' }, fmtTime(line.at)), ' ', line.text)));
  job.lines = v.log.length;
  job.tech.hidden = v.log.length === 0;
  setText(job.outcome, v.outcome);
  job.outcome.hidden = !v.outcome;
  job.guardrails.replaceChildren(...v.guardrails.map((t) => h('li', {}, t)));
  job.guardrails.hidden = !v.guardrails.length;
  const rows = v.running || !v.changes ? [] : J.routingDiff(v.changes.before, v.changes.after);
  setSlot(job.diff, JSON.stringify(rows), () => (rows.length ? diffCard(rows) : []));
}

function diffCard(rows) {
  const changed = rows.filter((r) => r.changed).length;
  return h(
    'div',
    { class: 'diff' },
    h(
      'p',
      { class: 'diff-title' },
      h('span', { class: 'fs-dot', 'aria-hidden': 'true' }),
      'What changed in Flagsmith',
      h('span', { class: 'diff-count' }, changed ? `${changed} change${changed > 1 ? 's' : ''}` : 'no routing change'),
    ),
    h(
      'ul',
      { class: 'diff-rows' },
      rows.map((r) =>
        h(
          'li',
          { class: 'diff-row', 'data-changed': String(r.changed) },
          h('span', { class: 'diff-label' }, r.label),
          h(
            'span',
            { class: 'diff-values' },
            r.changed ? h('span', { class: 'diff-before' }, h('span', { class: 'sr-only' }, 'before: '), r.before) : null,
            r.changed ? h('span', { class: 'diff-arrow', 'aria-hidden': 'true' }, '→') : null,
            h('span', { class: 'diff-after' }, h('span', { class: 'sr-only' }, r.changed ? 'after: ' : 'unchanged: '), r.after ?? r.before),
          ),
        ),
      ),
    ),
  );
}

// ---- the release history ------------------------------------------------------------------------------------------

function renderHistory(s) {
  const entries = J.ledgerView(s.ledger);
  setText($('history-meta'), entries.length ? `${entries.length} decision${entries.length > 1 ? 's' : ''}` : '');
  // The latest few; the rest (earlier practice runs) behind "Show all".
  const shown = ui.historyAll ? entries : entries.slice(0, HISTORY_SHOWN);
  const more = /** @type {HTMLButtonElement} */ ($('history-more'));
  more.hidden = entries.length <= HISTORY_SHOWN;
  more.setAttribute('aria-expanded', String(ui.historyAll));
  setText(more, ui.historyAll ? 'Show the latest only' : `Show all ${entries.length} decisions`);
  setSlot($('history-list'), JSON.stringify(shown), () =>
    shown.length
      ? shown.map((e) =>
          h(
            'li',
            { class: 'history-item', 'data-tone': e.tone },
            h('span', { class: 'history-top' }, h('span', { class: 'verdict', 'data-tone': e.tone }, e.decision), e.at ? h('span', { class: 'history-at' }, fmtDateTime(e.at)) : null),
            h('strong', { class: 'history-exp' }, e.experiment),
            h('span', { class: 'history-text' }, e.text),
          ),
        )
      : [h('li', { class: 'empty' }, 'No decisions yet. Ship or Revert writes the first one.')],
  );
}
$('history-more').addEventListener('click', () => {
  ui.historyAll = !ui.historyAll;
  if (ui.state) renderHistory(ui.state);
  syncScrollCues();
});

// ---- right: in Flagsmith right now ---------------------------------------------------------------------------------

/** A label / value row; `flag` rows are the ones the fs-flash demo lights up. */
function row(label, ...value) {
  return h('div', { class: 'fs-row' }, h('dt', {}, label), h('dd', {}, ...value));
}

function releaseChip(releases, release) {
  if (!release) return h('span', { class: 'rel rel-none' }, '—');
  return h('span', { class: 'rel', vars: { '--c': J.releaseColor(releases, release) } }, release);
}

/** "Open ↗": the same thing in Flagsmith's own dashboard, in its named tab (it refuses to be framed). */
function openLink(slot, url, label) {
  if (READONLY) url = null; // Flagsmith's dashboard is private on the server: the column itself is the view
  setSlot($(slot), url ?? '', () => (url ? h('a', { class: 'fs-open', href: url, target: FLAGSMITH_TAB, title: label, 'aria-label': label }, 'Open', icon(ICON_OUT)) : []));
}

function renderFlagsmith(s) {
  const e = s.experiment;
  const r = s.routing;
  const releases = s.releases ?? [];
  setText($('fs-asof'), ui.stateAt ? `· ${fmtTime(ui.stateAt)}` : '');
  openLink('fs-exp-open', s.links?.experiment, 'Open the experiment in Flagsmith');
  openLink('fs-flag-open', s.links?.flag, 'Open the release flag in Flagsmith');
  openLink('fs-results-open', s.links?.experiment, "Open Flagsmith's results page");

  // The experiment: what it tests, since when, and how it splits visitors right now.
  $('fs-exp-status').hidden = !e;
  if (e) {
    $('fs-exp-status').dataset.status = e.status;
    setText($('fs-exp-status'), e.status);
  }
  const started = J.parseTime(e?.startedAt);
  const ended = J.parseTime(e?.endedAt);
  const x = r?.experiment;
  setSlot($('fs-exp-body'), JSON.stringify([e, x, releases]), () =>
    e
      ? [
          h('p', { class: 'fs-name' }, h('span', { class: 'fs-id' }, `#${e.id}`), e.name),
          e.hypothesis ? h('p', { class: 'fs-hyp' }, h('span', { class: 'fs-hyp-label' }, 'Hypothesis'), e.hypothesis) : null,
          Number.isFinite(started) || Number.isFinite(ended)
            ? h(
                'dl',
                { class: 'fs-dl' },
                Number.isFinite(started) ? row('Started', h('time', { dateTime: e.startedAt, title: fmtDateTime(started) }, ago(started))) : null,
                Number.isFinite(ended) ? row('Ended', h('time', { dateTime: e.endedAt, title: fmtDateTime(ended) }, ago(ended))) : null,
              )
            : null,
          x
            ? h(
                'div',
                { class: 'split' },
                h('p', { class: 'split-head' }, h('span', {}, 'The split'), h('span', { class: 'split-enrolled' }, `${Math.round(x.enrolledPct * 10) / 10}% of visitors enrolled`)),
                h(
                  'div',
                  { class: 'split-bar', role: 'img', 'aria-label': x.arms.map((a) => `${a.pct}% ${a.release ?? a.key}`).join(', ') },
                  x.arms.map((a) => h('span', { class: 'split-seg', vars: { '--w': `${a.pct}%`, '--c': J.releaseColor(releases, a.release ?? a.key) } })),
                ),
                h(
                  'ul',
                  { class: 'split-legend' },
                  x.arms.map((a) => h('li', { vars: { '--c': J.releaseColor(releases, a.release ?? a.key) } }, h('span', { class: 'split-key' }, a.key), h('strong', {}, `${Math.round(a.pct * 10) / 10}%`), h('span', { class: 'split-rel' }, a.release ?? ''))),
                ),
              )
            : h('p', { class: 'fs-note' }, e.status === 'completed' ? 'Completed: its split is drained, the flag decides alone.' : 'No visitors are being split yet.'),
        ]
      : [h('p', { class: 'fs-empty' }, 'No experiment on the flag yet.')],
  );

  // The flag, as Flagsmith holds it now: its default (control's value), v2's current value, the preview override.
  const v2Now = Array.isArray(s.variants) ? s.variants.find((o) => o.key === 'v2')?.release : e?.v2;
  setSlot($('fs-flag-body'), JSON.stringify([r, v2Now, releases]), () => {
    if (!r) return [h('p', { class: 'fs-empty' }, 'No routing read from Flagsmith yet.')];
    return [
      h(
        'dl',
        { class: 'fs-dl' },
        row(h('span', {}, 'Default value', h('small', {}, 'control, and everyone outside')), releaseChip(releases, r.defaultRelease)),
        v2Now !== undefined ? row(h('span', {}, 'Variant v2', h('small', {}, 'multivariate option')), releaseChip(releases, v2Now)) : null,
        row(
          h('span', {}, 'Preview override', h('small', {}, 'turnout-preview segment')),
          r.preview?.active ? releaseChip(releases, r.preview.release) : h('span', { class: 'fs-off' }, 'off'),
        ),
      ),
    ];
  });

  // The results, as returned: a verdict chip and Flagsmith's chance per metric (the stage states the verdict).
  const v = J.resultsView(s);
  setText($('fs-results-meta'), v?.asOf ? `computed ${fmtTime(v.asOf)}` : '');
  setSlot($('fs-results-body'), JSON.stringify(v), () =>
    v
      ? [
          h(
            'ul',
            { class: 'fs-metrics' },
            v.metrics.map((m) =>
              h(
                'li',
                { class: 'fs-row fs-metric' },
                h('span', { class: 'fs-metric-head' }, h('span', { class: 'metric-name' }, m.name), h('span', { class: `role role-${m.role}` }, m.roleLabel), h('span', { class: 'verdict', 'data-tone': m.verdict.tone }, m.verdict.word)),
                m.v2
                  ? h('span', { class: 'fs-metric-chance' }, chanceBar(m, `${m.name}: v2 has ${m.v2.chance} chance to win`), h('span', { class: 'fs-metric-num' }, m.v2.chance))
                  : h('span', { class: 'fs-note' }, 'no comparison yet'),
              ),
            ),
          ),
        ]
      : [h('p', { class: 'fs-empty' }, "Flagsmith hasn't computed results yet. Step 2 asks for them.")],
  );
  syncScrollCues();
}

// Feature Health, from the console's bridge (GET /api/guard). Not configured (404): the line stays hidden.
// Resolves to the status Flagsmith was last told ('healthy' | 'unhealthy'), or null.
async function loadHealth(force = false) {
  // The public view has no guard API (it's the console's): Feature Health stays out of it.
  if (READONLY) {
    ui.health = null;
    $('fs-health').hidden = true;
    return null;
  }
  if (ui.health === null || ui.error?.kind === 'expired' || (document.hidden && !force)) return null;
  try {
    const res = await api('/api/guard', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (res.status === 404) {
      ui.health = null;
      $('fs-health').hidden = true;
      return null;
    }
    if (!res.ok) return null;
    const body = await res.json();
    ui.health = body;
    const last = body?.health?.last;
    let text = 'Feature Health reporting is off.';
    if (body?.health?.enabled) {
      if (!last) text = 'No report yet; the first check runs within 20 seconds.';
      else if (last.delivered === false) text = `Couldn't tell Flagsmith: ${last.error ?? 'no answer'}.`;
      else text = `Flagsmith shows the flag as ${last.status === 'unhealthy' ? 'Unhealthy' : 'Healthy'}${last.summary ? `: ${last.summary}` : ''}.`;
    }
    const line = $('fs-health-line');
    line.dataset.status = last?.status ?? '';
    setText(line, text);
    $('fs-health').hidden = false;
    syncScrollCues();
    return last && last.delivered !== false ? (last.status ?? null) : null;
  } catch {
    return null; // the next poll retries
  }
}

// Which release this browser sees in the Shop tab, from the flag's routing (the frame itself is another origin, so
// the page can't read which release it actually rendered: it says what the flag gives new visitors).
function renderShopHead(s) {
  const r = s.routing;
  let text = s.live ? `The flag's default is ${s.live}: every new visitor gets it.` : '';
  if (ui.shopMode === 'preview' && r?.preview?.active) text = `This browser opened the preview link: it sees ${r.preview.release}. Everyone else gets ${r.defaultRelease}.`;
  else if (r?.experiment) text = `This browser is a visitor too: Flagsmith puts it in ${r.experiment.arms.map((a) => a.release ?? a.key).join(' or ')}.`;
  setText($('shop-release'), text);
}

// ---- tabs ----------------------------------------------------------------------------------------------------------

const FRAMES = { shop: 'shop-frame', map: 'map-frame', setup: 'setup-frame' };

function frameUrl(tab) {
  if (tab === 'shop') return ui.state?.links?.shop ?? 'about:blank';
  if (tab === 'map') return '/flagsmith';
  if (tab === 'setup') return '/setup';
  return null;
}

function showTab(tab) {
  if (!document.getElementById(`tab-${tab}`)) return Promise.resolve();
  const changed = ui.tab !== tab;
  ui.tab = tab;
  for (const b of document.querySelectorAll('.tab[data-tab]')) b.setAttribute('aria-selected', String(/** @type {HTMLElement} */ (b).dataset.tab === tab));
  for (const panel of document.querySelectorAll('.tab-panel')) {
    const on = /** @type {HTMLElement} */ (panel).dataset.tab === tab;
    /** @type {HTMLElement} */ (panel).hidden = !on;
    if (on && changed) {
      panel.classList.remove('is-entering');
      void (/** @type {HTMLElement} */ (panel).offsetWidth);
      panel.classList.add('is-entering');
    }
  }
  const frame = FRAMES[tab] && /** @type {HTMLIFrameElement} */ ($(FRAMES[tab]));
  // A frame opened for the first time: wait for it to load (at most 3 s), so the tour never shows "Loading…".
  const loaded = frame && !frame.src ? loadFrame(frame, frameUrl(tab)) : Promise.resolve();
  if (changed) window.scrollTo({ top: 0, behavior: motion.matches ? 'auto' : 'smooth' });
  syncDock();
  const shown = new Promise((r) => setTimeout(r, changed && !motion.matches ? 320 : 0));
  return Promise.all([shown, loaded]).then(() => {});
}

/** Points a frame at a URL; resolves on its load event, or after `ms`. */
function loadFrame(frame, url, ms = 3000) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, ms);
    frame.addEventListener('load', done, { once: true });
    frame.src = url;
  });
}

// The closing beats show the feature map and the setup check: load them in the background while the last decision
// plays out, so they are ready (their own data fetched) when the tour gets there.
// Loaded each time the story reaches its end (not on every poll), so the values they show are this run's.
function preloadFrames(s) {
  const end = s.current === 'reset' || (s.current === 'verify' && !s.next);
  const edge = end && !ui.framesPreloaded;
  ui.framesPreloaded = end;
  if (!edge) return;
  for (const tab of ['map', 'setup']) {
    const frame = /** @type {HTMLIFrameElement | null} */ (document.getElementById(FRAMES[tab]));
    if (!frame || ui.tab === tab) continue; // the public view has no map or setup frame // never reload a frame the judge is looking at
    frame.loading = 'eager';
    frame.src = frameUrl(tab);
  }
}

function loadShop(mode) {
  ui.shopMode = mode;
  if (ui.state) renderShopHead(ui.state);
  const frame = /** @type {HTMLIFrameElement} */ ($('shop-frame'));
  let url = mode === 'preview' && ui.state?.links?.preview ? ui.state.links.preview : frameUrl('shop');
  // A fresh request every time: nothing between this browser and Turnout can answer from a cache.
  if (url && url !== 'about:blank' && mode !== 'preview') url += `${url.includes('?') ? '&' : '?'}_sy=${Date.now().toString(36)}`;
  frame.src = 'about:blank';
  setTimeout(() => (frame.src = url), 30);
}

for (const b of document.querySelectorAll('.tab[data-tab]')) {
  b.addEventListener('click', () => showTab(/** @type {HTMLElement} */ (b).dataset.tab));
}
$('shop-reload').addEventListener('click', () => loadShop('reload'));

// ---- the track map and the live feed ------------------------------------------------------------------------------

const track = createTrack($('track'), {
  colorOf: (release) => J.releaseColor(ui.state?.releases ?? [], release),
  summary: J.routingSummary,
});

function renderTrack(s) {
  ui.rules = J.trackRules(s.routing);
  track.update(ui.rules, s.releases ?? []);
}

let source = null;
let feedBackoff = 1000;
let feedTimer = 0;

function setFeed(state, text) {
  const el = $('feed-state');
  el.dataset.state = state;
  el.title = `Live traffic feed: ${text}`;
  setText(el, text);
}

function connectFeed() {
  clearTimeout(feedTimer);
  if (source || document.hidden || ui.error?.kind === 'expired') return;
  source = new EventSource(`${BASE}/api/traffic?token=${encodeURIComponent(TOKEN)}`); // EventSource can't set headers
  source.onopen = () => {
    feedBackoff = 1000;
    setFeed('ok', 'live');
  };
  source.onmessage = (m) => {
    try {
      const ev = JSON.parse(m.data);
      if (ev && typeof ev.release === 'string' && ev.release) {
        ownTimes.push(performance.now());
        if (ownTimes.length > 5000) ownTimes.splice(0, ownTimes.length - 5000);
        track.pulse(ev, J.routeOf(ev, ui.rules));
      }
    } catch {
      /* ignore malformed lines */
    }
  };
  source.onerror = () => {
    source?.close();
    source = null;
    setFeed('error', 'reconnecting…');
    feedTimer = setTimeout(connectFeed, feedBackoff);
    feedBackoff = Math.min(feedBackoff * 2, 15000);
  };
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    source?.close();
    source = null;
    setFeed('pending', 'paused while hidden');
    track.clear();
  } else {
    connectFeed();
    loadState();
    loadHealth();
  }
});

// ---- the welcome card ------------------------------------------------------------------------------------------------

const welcome = $('welcome');
const BEHIND = ['.appbar', '#banner', '#main', '.footer'];
let welcomeSeq = 0;

function welcomeDismissed() {
  try {
    return sessionStorage.getItem(WELCOME_KEY) === 'dismissed';
  } catch {
    return false;
  }
}

function rememberDismissed() {
  try {
    sessionStorage.setItem(WELCOME_KEY, 'dismissed');
  } catch {
    /* private mode: it just shows again next load */
  }
}

function setBehind(inert) {
  for (const sel of BEHIND) {
    const el = /** @type {HTMLElement | null} */ (document.querySelector(sel));
    if (el) el.inert = inert;
  }
}

function openWelcome() {
  if (tour.active) return;
  const seq = ++welcomeSeq;
  welcome.hidden = false;
  document.body.classList.add('welcome-open');
  setBehind(true);
  requestAnimationFrame(() => {
    if (seq === welcomeSeq) welcome.classList.add('is-in');
  });
  $('welcome-card').focus({ preventScroll: true }); // the card, not the button: no focus ring before any key press
}

function closeWelcome() {
  if (welcome.hidden) return;
  const seq = ++welcomeSeq;
  rememberDismissed();
  welcome.classList.remove('is-in');
  document.body.classList.remove('welcome-open');
  setBehind(false);
  setTimeout(() => {
    if (seq === welcomeSeq) welcome.hidden = true;
  }, motion.matches ? 0 : 300);
}

function chosenMode() {
  return /** @type {HTMLInputElement | null} */ (document.querySelector('input[name="tour-mode"]:checked'))?.value === 'auto' ? 'auto' : 'guide';
}

function chosenLength() {
  return /** @type {HTMLInputElement | null} */ (document.querySelector('input[name="tour-length"]:checked'))?.value === 'full' ? 'full' : 'quick';
}

$('welcome-skip').addEventListener('click', () => {
  closeWelcome();
  $('tour-open').focus({ preventScroll: true });
});
$('tour-open').addEventListener('click', openWelcome);
welcome.addEventListener('click', (ev) => {
  if (ev.target === welcome) closeWelcome(); // a click on the dimmed dashboard
});
addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !welcome.hidden) closeWelcome();
});

// ---- the tour, and the "show" half of each beat -----------------------------------------------------------------------

/** Re-runs the KPI count-ups from zero. */
function recount() {
  return Promise.all(
    ['visitors', 'events', 'chance'].map((name) => {
      const [el, value, format] = kpi[name] ?? [];
      if (!el || !Number.isFinite(value)) return null;
      setText(el, format(0));
      return countTo(el, value, format, 1300, 0);
    }),
  );
}

/** The SHOW animation for a tour beat, on its target. Resolves within DEMO_MAX_MS; at once under reduced motion. */
function demo(name, target) {
  if (motion.matches || !name) return Promise.resolve();
  const el = target instanceof Element ? target : null;
  const inStage = (sel) => (el?.matches(sel) ? el : (el?.querySelector(sel) ?? $('stage-visual').querySelector(sel)));
  let work;
  try {
    switch (name) {
      case 'flow-sweep':
        work = fx('sweep', flowEls, { className: 'is-sweep', stepMs: 240 });
        break;
      case 'steps-sweep':
        work = fx('sweep', [...$('steps-list').children], { className: 'is-sweep', stepMs: 150 });
        break;
      case 'track-burst': {
        // The experiment's split is the story while it runs; otherwise no track is singled out (the dots share out by
        // pct, so everyone else's default carries most of them and a new preview track shows as its own lane).
        const lit = ui.rules.some((r) => r.id === 'experiment') ? 'experiment' : null;
        if (typeof track.highlight === 'function') track.highlight(lit);
        work = (typeof track.demo === 'function' ? Promise.resolve(track.demo(14)) : wait(600)).finally(() => {
          if (typeof track.highlight === 'function') track.highlight(null);
        });
        break;
      }
      case 'kpi-count':
        work = recount();
        break;
      case 'results-grow':
        work = fx('grow', el ?? $('fs-results'));
        break;
      case 'diff-flash': {
        // The tour is showing this job's before → after: keep its panel open while the beat is read.
        if (job.id) {
          job.keepUntil = Date.now() + 15000; // about one beat's reading time
          if (ui.state) renderStage(ui.state);
        }
        const box = el ?? $('stage-visual');
        const changed = [...box.querySelectorAll('.diff-row[data-changed="true"]')];
        work = fx('flashRows', changed.length ? changed : [...box.querySelectorAll('.diff-row')]);
        break;
      }
      case 'verify-grow':
        work = fx('grow', inStage('.verify') ?? el ?? $('stage-visual'));
        break;
      case 'stage-pulse':
        // The button the beat asks for: the target itself, else the bubble's own action button, else the stage's.
        work = fx('pulse', el?.matches('[data-key]') ? el : (document.getElementById('tour-action') ?? stageBtn.el ?? $('stage')));
        break;
      case 'fs-flash': {
        const box = el ?? $('fs-panel');
        const rows = [...box.querySelectorAll('.fs-row')];
        work = rows.length ? fx('flashRows', rows) : fx('pulse', box);
        break;
      }
      default:
        work = Promise.resolve();
    }
  } catch {
    work = Promise.resolve();
  }
  return Promise.race([Promise.resolve(work).catch(() => {}), wait(DEMO_MAX_MS)]).then(() => {});
}

const tour = createTour({
  state: () => ui.state,
  showTab,
  loadShop,
  run: (action) => run(action),
  recommended: (s) => primaryButton(J.stepControls(s, 'decide'))?.action ?? 'ship',
  signin: async () => (READONLY ? null : (await api('/api/judge/signin', { cache: 'no-store' })).json()),
  // Also refreshes the flag card's Feature Health line, so the page shows the same answer the tour got.
  // null: Feature Health reporting isn't set up here, so the answer will never come.
  unhealthy: async () => {
    const status = await loadHealth(true);
    if (ui.health === null || ui.health?.health?.enabled === false) return null;
    return status === 'unhealthy';
  },
  demo,
  openWelcome: () => openWelcome(),
  onChange: (active, mode) => {
    $('tour-open').hidden = active;
    document.body.classList.toggle('is-touring', active);
    if (active) closeWelcome();
    const radio = /** @type {HTMLInputElement | null} */ (document.querySelector(`input[name="tour-mode"][value="${mode === 'auto' ? 'auto' : 'guide'}"]`));
    if (radio) radio.checked = true;
  },
});

$('tour-start').addEventListener('click', () => {
  const mode = READONLY ? 'watch' : chosenMode();
  closeWelcome();
  tour.start(mode, READONLY ? 'full' : chosenLength());
});

// ---- tickers and start ---------------------------------------------------------------------------------------------

setInterval(() => {
  track.tickRates();
  tickRate();
  for (const el of document.querySelectorAll('[data-countdown]')) {
    const text = J.countdownText(/** @type {HTMLElement} */ (el).dataset.countdown);
    if (!text && ui.state) {
      renderStage(ui.state); // the refresh is allowed again: enable the button
      break;
    }
    setText(el, text);
  }
  const line = document.getElementById('autopilot-line');
  if (line && ui.state) setText(line, J.autopilotLine(ui.state).text);
  if (J.jobRunning(ui.state)) {
    const v = J.jobView(ui.state.job);
    if (v) setText(job.elapsed, v.elapsed);
  }
}, 1000);

if (!welcomeDismissed()) openWelcome();
loadState().then(scheduleState);
loadHealth();
setInterval(loadHealth, HEALTH_POLL_MS);
connectFeed();
