// Turnout's judge page: one screen, four fixed steps, one green button at a time. Wording and rules live in
// demo-model.js; this file only draws them and runs the button. Every string goes in through textContent.
// Server mode's public page is the same page, read-only (meta turnout-readonly): the autopilot runs the tests, the
// API lives under /judge/api/, and nothing private shows (no Flagsmith link or login, no console).
import * as M from './demo-model.js';
import { createTour } from './tour.js';
import { JUDGE_STOPS, stopsFor } from './tour-stops.js';
import { PLAY, READONLY, loadSignin, setupMenu, setVersions, signinBox, viewLink } from './menu.js';

const STATE_POLL_MS = 4000;
const JOB_POLL_MS = 800;
const AUTOPLAY_PAUSE_MS = 2500;
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

// The per-boot token the server put in the page. Every /api/* call carries it.
const TOKEN = document.querySelector('meta[name="turnout-console"]')?.getAttribute('content') ?? '';
const TOKEN_HEADER = 'x-turnout-console';
const BASE = document.querySelector('meta[name="turnout-base"]')?.getAttribute('content') ?? '';
const api = (path, init = {}) => fetch(BASE + path, { ...init, headers: { ...(init.headers ?? {}), [TOKEN_HEADER]: TOKEN } });
if (READONLY) document.body.classList.add('is-readonly');
// Locked: the public page without play. With play, visitors run the demo's steps; pins, sign-in and links stay private.
const LOCKED = READONLY && !PLAY;

// One page: guided demo is a switch on the console. This page is what the switch shows (?embed=1, inside the console);
// opened on its own (an old link, a bookmark) it sends you to the console with the switch on.
const QUERY = new URLSearchParams(location.search);
export const EMBED = QUERY.has('embed') || window.self !== window.top;
if (!EMBED) {
  const tryPage = document.querySelector('meta[name="turnout-try"]') !== null;
  const consolePath = BASE === '/judge' ? '/judge/console' : '/';
  // Your app's test lives on your app's console; the demo shop's on the console with Guided demo on.
  if (tryPage) location.replace('/app');
  else location.replace(`${consolePath}?${new URLSearchParams({ mode: 'judge' })}`);
} else {
  document.body.classList.add('is-embed');
  // Links inside open in the console's window, not in this frame (those with their own target keep it).
  document.head.prepend(Object.assign(document.createElement('base'), { target: '_top' }));
}

// Try it with your app (/try): the same page for YOUR versions. Its words follow: visitors, not shoppers; your app,
// not the shop; conversions, not orders.
const TRY = document.querySelector('meta[name="turnout-try"]') !== null;
const WORDS = [[/\bShoppers\b/g, 'Visitors'], [/\bshoppers\b/g, 'visitors'], [/\bShopper\b/g, 'Visitor'], [/\bshopper\b/g, 'visitor'],
  [/\bthe demo shop\b/g, 'your app'], [/\bthe shop\b/g, 'your app'], [/\bOrders\b/g, 'Conversions'], [/\bordered\b/g, 'converted'], [/\borders\b/g, 'conversions'], [/\border\b/g, 'conversion']];
const words = (t) => (TRY ? WORDS.reduce((x, [re, to]) => x.replace(re, to), String(t)) : String(t));
if (TRY) document.body.classList.add('is-try');

/** Small element builder; strings become text nodes, never HTML. */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k === 'style') for (const [p, val] of Object.entries(v)) node.style.setProperty(p, val);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : words(c));
  return node;
}
const setText = (el, text) => {
  const t = words(text);
  if (el.textContent !== t) el.textContent = t;
};

const KIND_KEY = TRY ? 'turnout-try-kind' : 'turnout-demo-kind';
const storedKind = (() => {
  try {
    const n = Number(localStorage.getItem(KIND_KEY));
    return Number.isInteger(n) && n >= 1 ? n : null;
  } catch {
    return null;
  }
})();

const ui = {
  kind: storedKind, // the kind of test the judge picked: 1 = A/A, 2 = A/B, 3 = A/B/C…; null: the current test's kind
  plan: null, // a kind picked but not started: its versions show as a preview, and step 1 offers Start
  pendingKind: null, // a kind just started: its versions show at once, until the page shows the started test
  tab: 'results', // the bottom panel: 'results' (what Flagsmith measured) or 'flagsmith' (in Flagsmith)
  journey: [], // where this browser landed over time: before the test, in it, after the decision
  signin: null, // Flagsmith's address and login (this machine only)
  pinned: undefined, // the version this browser is pinned to in Flagsmith (an identity override); null: none
  you: null, // where this browser lands (the proxy's receipt)
  state: null,
  job: null, // the job this page is following
  jobTimer: 0,
  stateTimer: 0,
  error: '',
  autoplay: false,
  autoplayTimer: 0,
  decidedThisRun: false,
  decision: null, // the last Ship or Revert job, for its before → after
  tick: 0, // the countdown timer while Flagsmith's refresh limit holds the next look
  sending: false, // a click is on its way to the server: no second click
  before: null, // the state's signature when the job started
  settle: null, // after a job: { sig, until } — hold the buttons until the state shows the job's effect
  live: { exp: null, counts: {} }, // page views and orders per release from the traffic feed, this experiment only
  frames: {}, // one preview iframe per release, kept across renders so it doesn't reload
};

// ---- loading ------------------------------------------------------------------------------------------------------
// What a finished job must change before the page offers the next button: Flagsmith's answers can lag a job by a
// second or two, and until then the old button would come back and invite a second click.
const signature = (s) =>
  JSON.stringify([s?.experiment?.id, s?.experiment?.status, s?.results?.asOf, (s?.steps ?? []).map((x) => x.status), s?.ledger?.length]);

async function loadState() {
  clearTimeout(ui.stateTimer);
  let next = STATE_POLL_MS;
  try {
    const res = await api('/api/judge/state', { cache: 'no-store' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    ui.state = body;
    if (TRY) {
      M.setNames(body.names);
      // One version → an A/A test, two → A/B, three → A/B/C: the kind follows what you built.
      const built = { 'A/A': 1, 'A/B': 2, 'A/B/C': 3 }[body.tryit?.kind];
      if (built && ui.builtKind !== body.tryit.kind) {
        ui.builtKind = body.tryit.kind;
        ui.kind = built;
      }
    }
    if (body.job?.status === 'running' && !ui.job) followJob(body.job);
    if (ui.settle) {
      if (signature(body) !== ui.settle.sig || Date.now() > ui.settle.until) ui.settle = null;
      else next = 700;
    }
    if (ui.error.startsWith('Cannot reach')) ui.error = '';
  } catch (error) {
    ui.error = `Cannot reach the console: ${error.message}`;
  }
  render();
  ui.stateTimer = setTimeout(loadState, next);
}

function followJob(job) {
  ui.job = job;
  ui.before ??= signature(ui.state);
  clearTimeout(ui.jobTimer);
  const poll = async () => {
    try {
      const res = await api('/api/judge/job', { cache: 'no-store' });
      const { job: now } = await res.json();
      if (now && now.id === ui.job?.id) ui.job = now;
    } catch {
      /* the next poll tries again */
    }
    // A finished job holds the buttons (jobFinished) before anything redraws, so the old button never flashes back.
    if (ui.job?.status === 'running') {
      render();
      ui.jobTimer = setTimeout(poll, JOB_POLL_MS);
    } else jobFinished(ui.job);
  };
  ui.jobTimer = setTimeout(poll, JOB_POLL_MS);
}

async function jobFinished(job) {
  if (job?.status === 'failed') {
    ui.error = job.error ?? 'That step failed.';
    ui.pendingKind = null;
  }
  else ui.settle = { sig: ui.before ?? signature(ui.state), until: Date.now() + 8000 };
  ui.before = null;
  await loadState();
  while (ui.settle) await new Promise((r) => setTimeout(r, 300));
  // After Ship or Revert, check straight away that brand-new shoppers get the decision.
  if (job?.status === 'done' && (job.action === 'ship' || job.action === 'revert')) {
    ui.decidedThisRun = true;
    ui.decision = job;
    await run('verify');
  }
}

async function run(action, extra = {}) {
  const s = ui.state;
  if (action === 'cancel-plan') {
    ui.plan = null;
    return render();
  }
  if (ui.sending) return;
  if (action === 'start') {
    ui.pendingKind = extra.arms ?? null;
    ui.plan = null;
  }
  ui.sending = true;
  ui.before = signature(s); // the state before this job, to wait for its effect
  ui.error = '';
  render();
  const body = {
    action,
    ...(s?.experiment ? { experimentId: s.experiment.id } : {}),
    ...(action === 'visitors' ? { visitors: extra.visitors ?? M.shoppersFor(M.arms(s).length) } : {}),
    ...(action === 'start' ? { arms: extra.arms } : {}),
  };
  if (action === 'release' || action === 'reset' || action === 'abc' || action === 'start') delete body.experimentId;
  try {
    const res = await api('/api/judge/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
    if (out.job) followJob(out.job);
  } catch (error) {
    ui.error = error.message;
    ui.before = null;
    ui.pendingKind = null;
    stopAutoplay();
  }
  ui.sending = false;
  render();
}

// ---- the traffic feed: live page views and orders per version ---------------------------------------------------
let feed = null;
function connectFeed() {
  if (feed || document.hidden) return;
  feed = new EventSource(`${BASE}/api/traffic?token=${encodeURIComponent(TOKEN)}`); // EventSource can't set headers
  feed.onmessage = (m) => {
    try {
      const ev = JSON.parse(m.data);
      if (!ev?.release) return;
      const c = (ui.live.counts[ev.release] ??= { pages: 0, orders: 0 });
      if (ev.document) c.pages++;
      if (ev.converted) c.orders++;
      paintLive();
    } catch {
      /* ignore malformed lines */
    }
  };
  feed.onerror = () => {
    feed?.close();
    feed = null;
    setTimeout(connectFeed, 3000);
  };
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    feed?.close();
    feed = null;
  } else {
    connectFeed();
    loadState();
  }
});

function paintLive() {
  for (const el of document.querySelectorAll('[data-live]')) {
    // Only while a test runs, and only page views: the previews' own asset requests aren't shoppers.
    const c = ui.state?.experiment?.status === 'running' ? ui.live.counts[el.dataset.live] : null;
    const n = (k, one, many) => `${c[k].toLocaleString('en-GB')} ${c[k] === 1 ? one : many}`;
    setText(el, c?.pages ? `Live: ${n('pages', 'page view', 'page views')} · ${n('orders', 'order', 'orders')}` : '');
  }
}

// ---- the kind of test: A/A, A/B, A/B/C… -----------------------------------------------------------------------------
// Picking a kind sets what the next test is. While a test runs, a different kind asks first: starting it stops the
// running test (everyone goes back to A).
function chosenKind(s) {
  const max = s?.releases?.length ?? 2;
  const k = ui.kind ?? M.kindOf(s) ?? max;
  return Math.min(k, max);
}

function renderKinds(s, kind) {
  const box = $('kinds');
  const options = M.kinds(s.releases);
  const current = s.experiment?.status !== 'completed' ? M.kindOf(s) : null;
  const busy = isBusy();
  const key = JSON.stringify([options.map((o) => o.arms), kind, current, busy, ui.pendingKind, ui.plan]);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(
    h('span', { class: 'kinds-label' }, 'Test'),
    ...options.map((o) => h('button', {
      class: 'kind', type: 'button',
      title: LOCKED ? `${o.blurb} On this public page the autopilot picks the test.` : `${o.blurb} Click to preview it; Start runs it.`,
      'aria-pressed': String(o.arms === (ui.plan ?? ui.pendingKind ?? kind)), 'data-running': o.arms === current ? 'true' : null,
      disabled: LOCKED || busy,
      on: { click: () => pickKind(o.arms) },
    }, o.label)));
}

const isBusy = () => ui.job?.status === 'running' || ui.state?.job?.status === 'running' || ui.sending || Boolean(ui.settle);

// A click on a kind previews that test: its versions show, and step 1 offers Start. Nothing changes in Flagsmith
// until Start (a running test stops first then). Clicking the running test's own kind goes back to it.
function pickKind(k) {
  if (LOCKED || isBusy()) return;
  ui.kind = k;
  try {
    localStorage.setItem(KIND_KEY, String(k));
  } catch {
    /* remembered for this page only */
  }
  const s = ui.state;
  const running = s?.experiment && s.experiment.status !== 'completed' ? M.kindOf(s) : null;
  ui.plan = running === k ? null : k;
  document.dispatchEvent(new CustomEvent('turnout:kind', { detail: { kind: k, label: M.kindLabel(k), planned: ui.plan !== null } }));
  render();
}

// ---- drawing ------------------------------------------------------------------------------------------------------
function render() {
  const s = ui.state;
  const err = $('error');
  err.hidden = !ui.error;
  setText(err, ui.error);
  if (!s) return;

  const links = s.links ?? {};
  setVersions(links.shop, s.releases, TRY ? s.names : null);
  const rl = $('results-link');
  rl.hidden = !(links.experiment && s.results);
  rl.setAttribute('href', links.experiment ?? '#');

  const kind = chosenKind(s);
  const m = ui.plan !== null && !isBusy() ? M.planModel(s, ui.plan) : M.model(s, { kind });
  // A test that was just picked: show its versions now, before Flagsmith confirms it. Cleared once the page shows it.
  if (ui.pendingKind !== null && !ui.sending && !isBusy() && M.kindOf(s) === ui.pendingKind && s.experiment?.status === 'running') ui.pendingKind = null;
  if (ui.pendingKind !== null && !m.plan) m.versions = M.plannedVersions(s.releases, ui.pendingKind);
  renderKinds(s, kind);
  if (ui.live.exp !== s.experiment?.id) ui.live = { exp: s.experiment?.id ?? null, counts: {} };

  setText($('now'), m.now);
  setText($('exp-id'), m.plan ? `· preview of an ${m.letters} test` : s.experiment ? `· ${m.letters} test #${s.experiment.id}` : '');
  const visit = $('be-visitor');
  visit.setAttribute('href', String(links.shop ?? (READONLY ? '/' : '#'))); // the public shop is its own host (shop.<host>)
  renderVersions(s, m);
  renderSteps(s, m);
  renderNext(s, m);
  renderResults(s, m);
  renderFlagsmith(s);
  renderBlind(s);
  renderHistory(s);
  paintLive();
  scheduleAutoplay(m);
}

function renderVersions(s, m) {
  const box = $('versions');
  box.style.setProperty('--n', String(Math.max(2, m.versions.length)));
  // An A/A test: the copy (A′) is the same shop in the same colour, with a dashed outline.
  box.dataset.aa = String(m.versions.length === 2 && m.versions[0].release === m.versions[1].release);
  const goal = s.results?.metrics?.find((x) => x.role === 'goal');
  // The tiles are built once per set of releases and then only their words change: moving a preview frame in the
  // page reloads it, so the frames stay where they are.
  const set = JSON.stringify(m.versions.map((v) => [v.key, v.release]));
  if (box.dataset.set !== set) {
    box.dataset.set = set;
    box.replaceChildren(...m.versions.map((v) => h('article', { class: 'version', 'data-key': v.key },
      h('div', { class: 'version-head' },
        h('span', { class: 'version-letter', 'aria-hidden': 'true' }, v.letter),
        h('div', { class: 'version-title' }, h('h3', { class: 'version-name' }, M.label(v.release)), h('span', { class: 'version-role' })),
        h('span', { class: 'version-badge' })),
      frameFor(s, v.key, v.release),
      h('p', { class: 'version-line version-fs' }),
      h('p', { class: 'version-line', 'data-live': v.release }))));
    fitFrames();
  }
  m.versions.forEach((v, i) => {
    const tile = /** @type {HTMLElement} */ (box.children[i]);
    tile.dataset.state = v.state;
    const aaCopy = box.dataset.aa === 'true' && i === 1;
    setText(tile.querySelector('.version-role'), v.key === 'control' ? 'current' : aaCopy ? 'copy of A (same shop)' : 'new');
    setText(tile.querySelector('.version-badge'), v.badge);
    const arm = m.plan ? null : goal?.arms?.[v.key]; // a preview has no numbers yet
    setText(tile.querySelector('.version-fs'), arm ? (/_ms$/.test(goal.name) ? `${Math.round(arm.mean)} ms per page, ${arm.n.toLocaleString('en-GB')} shoppers` : `${(arm.mean * 100).toFixed(1)}% of ${arm.n.toLocaleString('en-GB')} shoppers ordered`) : '');
    // Once Flagsmith has counted, its numbers replace the live tally (one line, so the tiles stay short).
    tile.classList.toggle('has-results', Boolean(arm));
  });
}

// One preview per version in the test (an A/A test shows the same release twice, in two frames).
function frameFor(s, key, release) {
  const id = `${key}:${release}`;
  if (!ui.frames[id]) {
    const src = viewLink(s.links?.shop, release);
    const iframe = h('iframe', { src, title: `Preview of ${M.label(release)}`, tabindex: '-1', 'aria-hidden': 'true' });
    iframe.addEventListener('load', fitFrames);
    ui.frames[id] = h('a', { class: 'version-frame', href: viewLink(s.links?.shop, release), target: '_blank', rel: 'noopener', title: `Open ${M.label(release)} on its own (never counted)` }, iframe);
  }
  return ui.frames[id];
}
function fitFrames() {
  for (const box of document.querySelectorAll('.version-frame')) {
    const f = box.querySelector('iframe');
    if (!f || !box.clientWidth) continue;
    // The page is laid out at a virtual width that suits the tile's shape, then scaled to fit: a wide tile shows the
    // desktop layout (1280 px); a tall, narrow one (A/B/C) a narrower layout, so the page fills the tile instead of
    // leaving its lower part blank. The frame is as tall as the tile at that scale.
    const virtual = Math.round(Math.min(1280, Math.max(460, (box.clientWidth / Math.max(1, box.clientHeight)) * 1100)));
    if (f.style.width !== `${virtual}px`) f.style.width = `${virtual}px`;
    const scale = box.clientWidth / virtual;
    f.style.transform = `scale(${scale.toFixed(4)})`;
    f.style.height = `${Math.ceil(Math.max(box.clientHeight, 1) / scale)}px`;
  }
}
new ResizeObserver(fitFrames).observe(document.documentElement);

const JOB_STEP = { visitors: 'visitors', score: 'score', ship: 'decide', revert: 'decide', 'keep-running': 'decide', release: 'start', reset: 'start', abc: 'start', start: 'start' };

function renderSteps(s, m) {
  const job = ui.job?.status === 'running' ? ui.job : null;
  // A new test started from the finished page shows its progress in the box under the steps instead.
  const jobStep = job && !(m.finished && JOB_STEP[job.action] === 'start') ? JOB_STEP[job.action] : null;
  const items = m.steps.map((st) => {
    const showJob = jobStep === st.id;
    const isCurrent = st.status === 'current' && !m.finished;
    const body = [];
    if (st.result && !(st.id === 'decide' && m.finished)) body.push(h('p', { class: 'step-result', 'data-tone': st.id === 'score' ? (m.verdict?.tone ?? '') : '' }, st.result));
    if (st.id === 'decide' && m.finished) body.push(outcomeBox(m));
    if (showJob) body.push(jobBox(job));
    else if (isCurrent && m.action && !job) body.push(actionBox(m));
    return h('li', { class: 'step', 'data-status': showJob ? 'current' : st.status, 'aria-current': isCurrent ? 'step' : null },
      h('span', { class: 'step-n', 'aria-hidden': 'true' }, st.status === 'done' && !showJob ? '✓' : String(st.n)),
      h('div', { class: 'step-body' }, h('h3', { class: 'step-title' }, st.title), ...body));
  });
  $('steps').replaceChildren(...items);
}

function actionBox(m) {
  const a = m.action;
  if (LOCKED) {
    return h('div', { class: 'action' }, h('p', { class: 'action-explain' }, a.explain), h('p', { class: 'autopilot', role: 'status' }, M.autopilotLine(ui.state)));
  }
  const wait = a.waitUntil ? Math.max(0, Date.parse(a.waitUntil) - Date.now()) : 0;
  const mins = Math.floor(wait / 60000);
  const secs = String(Math.floor((wait % 60000) / 1000)).padStart(2, '0');
  const busy = ui.job?.status === 'running' || ui.state?.job?.status === 'running' || ui.sending || Boolean(ui.settle);
  const main = h('button', { class: 'btn btn-go', type: 'button', id: 'go', 'data-action': a.action, disabled: wait > 0 || busy, on: { click: () => run(a.action, { arms: a.arms, visitors: a.shoppers }) } },
    ui.sending ? 'Starting…' : ui.settle ? 'Reading Flagsmith…' : wait > 0 ? `Flagsmith allows the next look in ${mins}:${secs}` : a.label);
  const alt = m.alt ? h('button', { class: 'btn btn-quiet', type: 'button', disabled: busy, on: { click: () => run(m.alt.action) } }, m.alt.label) : null;
  if (wait > 0 && !ui.tick) ui.tick = setTimeout(() => ((ui.tick = 0), render()), 1000);
  return h('div', { class: 'action' },
    h('p', { class: 'action-explain' }, a.explain),
    h('div', { class: 'action-row' }, main, alt));
}

function jobBox(job) {
  const v = M.jobView(job);
  return h('div', { class: 'job', role: 'status' },
    h('p', { class: 'job-title' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), `${v.title}…`),
    h('p', { class: 'job-detail' }, v.detail),
    v.fraction !== null ? h('div', { class: 'bar' }, h('i', { style: { width: `${Math.round(v.fraction * 100)}%` } })) : null);
}

// Flagsmith's results: a row per metric, a column per version; each new version's cell says how it did against A.
function renderResults(s, m) {
  const box = $('results');
  if (!m.findings.length) {
    const text = s.experiment?.status === 'running' ? "Flagsmith's results appear here once shoppers have gone through and you ask for them." : 'No results yet.';
    if (box.dataset.empty !== text) {
      box.dataset.empty = text;
      box.replaceChildren(h('p', { class: 'placeholder' }, text));
    }
    return;
  }
  delete box.dataset.empty;
  const key = JSON.stringify([m.findings, m.verdict]);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(
    h('table', { class: 'findings', style: { '--n': String(m.versions.length) } },
      h('thead', {}, h('tr', {},
        h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Metric')),
        ...m.versions.map((v) => h('th', { scope: 'col', 'data-key': v.key }, h('span', { class: 'th-letter' }, v.letter), ` ${M.label(v.release)}`)))),
      h('tbody', {}, ...m.findings.map((f) => h('tr', { 'data-role': f.role },
        h('th', { scope: 'row' }, h('span', { class: 'f-name' }, f.name), ' ', h('span', { class: 'f-role', 'data-role': f.role }, f.roleText)),
        ...f.cells.map((c) => h('td', { 'data-tone': c.tone },
          h('span', { class: 'f-value' }, c.value),
          c.word ? h('span', { class: 'f-word' }, c.word) : null,
          c.note ? h('span', { class: 'f-note' }, c.note) : null)))))),
    m.verdict ? h('p', { class: 'verdict', 'data-tone': m.verdict.tone }, h('strong', {}, `${m.verdict.title}. `), m.verdict.text) : null);
}

function outcomeBox(m) {
  const o = m.outcome;
  const lastJobs = [ui.job, ui.state?.job, ui.decision].filter(Boolean);
  const exp = ui.state?.experiment?.id;
  const decisionJob = lastJobs.find((j) => (j.action === 'ship' || j.action === 'revert') && j.status === 'done' && j.changes?.before?.experiment?.id === exp);
  const changed = M.changes(decisionJob);
  const check = M.verifyText(lastJobs.find((j) => j.action === 'verify'));
  return h('div', { class: 'outcome', 'data-shipped': String(o.shipped) },
    h('p', { class: 'outcome-title' }, o.title, h('span', { class: 'outcome-sub' }, ` ${o.text}`)),
    changed ? h('dl', { class: 'change' },
      h('div', {}, h('dt', {}, 'Before'), h('dd', {}, changed.before)),
      h('div', {}, h('dt', {}, 'After'), h('dd', {}, changed.after))) : null,
    check ? h('p', { class: 'check', 'data-ok': String(check.ok) }, `${check.ok ? '✓' : '✗'} Checked: ${check.text}`) : null);
}

function renderNext(s, m) {
  const box = $('next');
  const job = ui.job?.status === 'running' ? ui.job : null;
  box.hidden = !m.finished;
  if (box.hidden) return box.replaceChildren();
  if (job) return box.replaceChildren(...(['release', 'reset', 'abc', 'start', 'verify'].includes(job.action) ? [jobBox(job)] : []));
  if (!m.action) return box.replaceChildren();
  const a = actionBox({ ...m, alt: null });
  a.querySelector('.action-explain')?.remove();
  a.querySelector('#go')?.setAttribute('title', m.action.explain);
  box.replaceChildren(a);
}

// Blind rounds (server mode): hidden while a round runs, revealed with Flagsmith's call after it, and the scoreboard.
function renderBlind(s) {
  const box = $('blind');
  const v = M.blindView(s);
  box.hidden = !v;
  if (!v) return;
  const key = JSON.stringify(v);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.dataset.tone = v.tone;
  box.replaceChildren(h('p', { class: 'blind-title' }, v.title), h('p', { class: 'blind-text' }, v.text), h('p', { class: 'blind-score' }, v.score));
}

function renderHistory(s) {
  const rows = M.history(s.ledger);
  setText($('history-count'), rows.length ? `(${(s.ledger ?? []).filter((e) => e.decision !== 'kept-running').length})` : '');
  $('history-box').hidden = !rows.length;
  $('history').replaceChildren(...rows.map((r) => h('li', { 'data-tone': r.tone },
    h('span', {}, r.text),
    h('time', { datetime: r.at }, new Date(r.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })))));
}

// ---- Play it for me: clicks each green button after a pause, through one whole test -----------------------------
const autoBtn = $('autoplay');
autoBtn.addEventListener('click', () => (ui.autoplay ? stopAutoplay() : startAutoplay()));
function startAutoplay() {
  ui.autoplay = true;
  ui.decidedThisRun = false;
  autoBtn.setAttribute('aria-pressed', 'true');
  setText(autoBtn, '■ Stop playing');
  render();
}
function stopAutoplay() {
  ui.autoplay = false;
  clearTimeout(ui.autoplayTimer);
  ui.autoplayTimer = 0;
  autoBtn.setAttribute('aria-pressed', 'false');
  setText(autoBtn, '▶ Play it for me');
  document.body.classList.remove('autoplaying');
}
function scheduleAutoplay(m) {
  if (!ui.autoplay) return;
  document.body.classList.add('autoplaying');
  const busy = ui.job?.status === 'running' || ui.state?.job?.status === 'running' || ui.sending || Boolean(ui.settle);
  // One whole test: stop once a decision is made and checked.
  if (ui.decidedThisRun && m.finished && !busy) return stopAutoplay();
  if (busy || ui.autoplayTimer || !m.action || m.action.waitUntil) return;
  ui.autoplayTimer = setTimeout(() => {
    ui.autoplayTimer = 0;
    const go = /** @type {HTMLButtonElement|null} */ (document.getElementById('go'));
    if (ui.autoplay && go && !go.disabled) {
      go.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      go.click();
    }
  }, AUTOPLAY_PAUSE_MS);
}

// ---- you: where this browser lands -------------------------------------------------------------------------------
// The console asks the proxy with this browser's visitor cookie (/api/you). The public page shares an origin with the
// shop, so it asks the proxy's receipt directly.
const JOURNEY_KEY = 'turnout-you-journey-judge';
try {
  ui.journey = JSON.parse(localStorage.getItem(JOURNEY_KEY) ?? '[]');
} catch {
  ui.journey = [];
}

async function loadYou() {
  if (!document.hidden) {
    try {
      const res = READONLY ? await fetch('/__turnout/receipt', { cache: 'no-store', credentials: 'same-origin' }) : await api('/api/you', { cache: 'no-store' });
      ui.you = res.ok ? await res.json() : READONLY && res.status === 404 ? { visited: false } : null;
      // The proxy answers visitor: null (200) before this browser has a cookie: that is "not visited", not a visit.
      if (READONLY && ui.you && !('visited' in ui.you)) ui.you.visited = ui.you.visitor !== null;
    } catch {
      ui.you = null;
    }
    if (!READONLY && ui.you?.visited) await loadPin();
    setText($('you'), `${M.youText(ui.you, ui.state, READONLY)}${ui.pinned && ui.pinned === ui.you?.release ? ' (pinned)' : ''}`);
    // Where this browser lands, remembered over time: what it got before the test, in it, and after the decision.
    const next = ui.state ? M.addVisit(ui.journey, M.visitOf(ui.you, ui.state, ui.pinned)) : ui.journey;
    if (next !== ui.journey) {
      ui.journey = next;
      try {
        localStorage.setItem(JOURNEY_KEY, JSON.stringify(next));
      } catch {
        /* this page only */
      }
    }
    renderFlagsmith(ui.state);
  }
  setTimeout(loadYou, 4000);
}

// ---- pin this browser to one version: a Flagsmith identity override for its visitor id --------------------------
async function loadPin() {
  try {
    const res = await api('/api/pin', { cache: 'no-store' });
    ui.pinned = res.ok ? (await res.json()).pinned : undefined;
  } catch {
    ui.pinned = undefined;
  }
}
async function pin(release) {
  ui.pinning = true;
  renderFlagsmith(ui.state, true);
  try {
    const res = await api('/api/pin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ release }) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
    ui.pinned = out.pinned;
    ui.pinError = '';
  } catch (error) {
    ui.pinError = error.message;
  }
  ui.pinning = false;
  renderFlagsmith(ui.state, true);
}
function pinRow() {
  if (READONLY || !ui.you?.visited || ui.you.viewing) return null;
  const releases = ui.state?.releases ?? [];
  return h('div', { class: 'pin' },
    h('h3', { class: 'fs-h' }, 'Pin my browser'),
    h('div', { class: 'pin-row' },
      ...releases.map((r, i) => h('button', {
        class: 'btn btn-small pin-btn', type: 'button', 'data-i': String(i), 'aria-pressed': String(ui.pinned === r), disabled: Boolean(ui.pinning),
        title: `Always give this browser ${M.label(r)}: a Flagsmith identity override for your visitor id`,
        on: { click: () => pin(r) },
      }, M.label(r))),
      ui.pinned ? h('button', { class: 'btn btn-small btn-quiet', type: 'button', disabled: Boolean(ui.pinning), on: { click: () => pin(null) } }, 'Unpin') : null),
    h('p', { class: 'fs-note' }, ui.pinError || (ui.pinned
      ? `Pinned to ${M.label(ui.pinned)} by an identity override in Flagsmith: every page you load gets it, outside the test (not counted).`
      : 'An identity override in Flagsmith for your visitor id: your browser gets that version on every page, outside the test.')));
}

// ---- the bottom panel's tabs: what Flagsmith measured | in Flagsmith -----------------------------------------------
function setTab(tab) {
  ui.tab = tab;
  if (tab === 'flagsmith' && !READONLY && ui.you?.visited) void loadPin().then(() => renderFlagsmith(ui.state, true));
  for (const [id, name] of [['tab-results', 'results'], ['tab-flagsmith', 'flagsmith'], ['tab-yours', 'yours']]) $(id).setAttribute('aria-selected', String(tab === name));
  $('results').hidden = tab !== 'results';
  $('flagsmith-tab').hidden = tab !== 'flagsmith';
  $('yours-tab').hidden = tab !== 'yours';
  renderFlagsmith(ui.state);
}
$('tab-results').addEventListener('click', () => setTab('results'));
$('tab-flagsmith').addEventListener('click', () => setTab('flagsmith'));
$('tab-yours').addEventListener('click', () => setTab('yours'));
// Use it on your app: this machine's install line (Windows or not), each command with Copy.
{
  // The repository's address, written apart: the page itself names no remote URL (it requests nothing outside).
  const repo = ['https:', '', 'github.com', 'tharunkumardeveloper', 'turnout'].join('/');
  for (const c of document.querySelectorAll('#yours-tab [data-repo]')) c.textContent = (c.textContent ?? '').replace('{repo}', repo);
  for (const a of document.querySelectorAll('#yours-tab [data-repo-link]')) a.setAttribute('href', repo + a.getAttribute('data-repo-link'));
  const win = /Win/i.test(navigator.platform || navigator.userAgent);
  for (const c of document.querySelectorAll('#yours-tab code[data-os]')) c.hidden = (c.getAttribute('data-os') === 'win') !== win;
  for (const b of document.querySelectorAll('#yours-tab .copy')) {
    b.addEventListener('click', () => {
      const code = [...b.parentElement.querySelectorAll('code')].find((c) => !c.hidden);
      void navigator.clipboard?.writeText(code?.textContent ?? '').then(() => {
        b.textContent = 'Copied';
        setTimeout(() => (b.textContent = 'Copy'), 1500);
      });
    });
  }
}

// ---- in Flagsmith: the flag, the route each shopper takes (and yours), the experiment, the login -----------------
function renderFlagsmith(s, force = false) {
  const box = $('flagsmith-tab');
  if (!s || box.hidden) return;
  const f = M.flagsmithModel(s, ui.you);
  if (!f) return;
  const key = JSON.stringify([f, ui.journey, Boolean(ui.signin), ui.pinned, ui.pinning, ui.pinError, ui.you?.visited]);
  if (!force && box.dataset.key === key) return;
  box.dataset.key = key;
  const route = h('div', { class: 'fs-col fs-route' },
    h('h3', { class: 'fs-h' }, 'The route, right now'),
    h('div', { class: 'route' },
      h('span', { class: 'route-node' }, 'Shopper'), h('span', { class: 'route-arrow', 'aria-hidden': 'true' }, '→'),
      h('span', { class: 'route-node' }, 'Turnout'), h('span', { class: 'route-arrow', 'aria-hidden': 'true' }, '→'),
      h('span', { class: 'route-node route-flag' }, `flag ${f.flag}`)),
    h('ul', { class: 'route-arms' }, ...f.route.map((r) => h('li', { class: 'route-arm', 'data-i': String(Math.max(0, 'ABC'.indexOf((r.letter || 'A')[0]))), 'data-you': String(r.you) },
      h('span', { class: 'route-letter' }, r.letter || '•'),
      h('span', { class: 'route-name' }, r.name),
      h('span', { class: 'route-bar', style: { '--w': `${r.pct}%` } }, h('i')),
      h('span', { class: 'route-pct' }, `${r.pct}%`),
      r.you ? h('span', { class: 'you-pin' }, 'YOU') : null))),
    f.outside ? h('p', { class: 'fs-note' }, `${f.outside}% of shoppers are outside the test and get ${f.everyone}${f.youOutside ? ' (you are one of them)' : ''}.`) : null,
    f.preview ? h('p', { class: 'fs-note' }, `Your team's preview browsers get ${f.preview} (a segment override).`) : null,
    ui.journey.length
      ? h('div', { class: 'journey' }, h('h3', { class: 'fs-h' }, 'Your visits'),
          h('ol', { class: 'journey-list' }, ...ui.journey.map((v) => h('li', {}, h('strong', {}, v.name), ` ${v.where}`))))
      : h('p', { class: 'fs-note' }, 'Press “Be a visitor” to get a version like a real shopper: the route marks it with YOU.'),
    pinRow());
  const e = f.experiment;
  const facts = h('div', { class: 'fs-col' },
    h('h3', { class: 'fs-h' }, 'The flag and the experiment'),
    h('dl', { class: 'fs-facts' },
      h('dt', {}, 'Flag'), h('dd', {}, h('code', {}, f.flag), ' · multivariate, tagged release'),
      h('dt', {}, 'Variants'), h('dd', {}, f.variants.map((v) => `${v.key} → ${M.label(v.value)}`).join(' · ')),
      h('dt', {}, 'Everyone else'), h('dd', {}, `${f.everyone} (the flag's default)`),
      ...(e ? [
        h('dt', {}, 'Experiment'), h('dd', {}, `#${e.id}, ${e.kind}, ${e.status}${e.counted ? `, ${e.counted.toLocaleString('en-GB')} shoppers counted` : ''}`),
        h('dt', {}, 'Hypothesis'), h('dd', {}, e.hypothesis),
        h('dt', {}, 'Metrics'), h('dd', {}, e.metrics.length ? e.metrics.map((m) => `${m.name} (${m.role.toLowerCase()})`).join(' · ') : 'goal and safety checks, once Flagsmith has results'),
      ] : [])));
  const open = h('div', { class: 'fs-col fs-open' },
    h('h3', { class: 'fs-h' }, 'Open it in Flagsmith'),
    READONLY
      ? h('p', { class: 'fs-note' }, "On this public page Flagsmith's dashboard stays private. Every number here comes straight from its API.")
      : h('div', { class: 'fs-links' },
          f.links.flag ? h('a', { class: 'btn btn-small', href: f.links.flag, target: '_blank', rel: 'noopener' }, 'The flag ↗') : null,
          f.links.experiment ? h('a', { class: 'btn btn-small', href: f.links.experiment, target: '_blank', rel: 'noopener' }, 'The experiment ↗') : null),
    READONLY ? null : ui.signin ? signinBox(ui.signin, { compact: true }) : h('p', { class: 'fs-note' }, 'Loading the login…'));
  box.replaceChildren(route, facts, open);
}

setupMenu('judge');
if (READONLY) {
  $('autoplay').hidden = true;
} else {
  void loadSignin().then((x) => {
    ui.signin = x;
    renderFlagsmith(ui.state);
  });
}
void loadYou();
const tour = createTour({ stops: stopsFor(JUDGE_STOPS, READONLY), seenKey: READONLY ? 'turnout-tour-public-seen' : TRY ? 'turnout-tour-try-seen' : 'turnout-tour-judge-seen' });
if (TRY) {
  const foot = document.querySelector('.foot');
  if (foot?.firstChild) foot.firstChild.textContent = words(foot.firstChild.textContent ?? '');
  document.querySelector('.brand')?.append(h('span', { class: 'try-chip' }, 'your app'));
  document.title = 'Turnout: try it with your app';
}
$('tour-open').addEventListener('click', () => tour.start());
// The console's Tour button, while Guided demo is on: the tour of this view.
window.addEventListener('message', (e) => {
  if (e.origin === location.origin && e.data?.turnout === 'tour') tour.start();
});
connectFeed();
// /try?play=1 (the console's "Run your app's test"): play the whole test straight away, no tour.
const playNow = TRY && new URLSearchParams(location.search).get('play') === '1';
// Inside the console the tour starts from its Tour button, not by itself.
loadState().then(() => (playNow ? startAutoplay() : EMBED ? null : tour.offer()));
