// Turnout's simple judge page: one column, four fixed steps, one green button at a time. Wording and rules live in
// demo-model.js; this file only draws them and runs the button. Every string goes in through textContent.
import * as M from './demo-model.js';

const STATE_POLL_MS = 4000;
const JOB_POLL_MS = 800;
const AUTOPLAY_PAUSE_MS = 2500;
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

// The per-boot token the server put in the page. Every /api/* call carries it.
const TOKEN = document.querySelector('meta[name="turnout-console"]')?.getAttribute('content') ?? '';
const TOKEN_HEADER = 'x-turnout-console';
const api = (path, init = {}) => fetch(path, { ...init, headers: { ...(init.headers ?? {}), [TOKEN_HEADER]: TOKEN } });

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
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}
const setText = (el, text) => {
  if (el.textContent !== text) el.textContent = text;
};

const ui = {
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
  if (job?.status === 'failed') ui.error = job.error ?? 'That step failed.';
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

async function run(action) {
  const s = ui.state;
  if (ui.sending) return;
  ui.sending = true;
  ui.before = signature(s); // the state before this job, to wait for its effect
  ui.error = '';
  render();
  const body = { action, ...(s?.experiment ? { experimentId: s.experiment.id } : {}), ...(action === 'visitors' ? { visitors: M.SHOPPERS } : {}) };
  if (action === 'release' || action === 'reset') delete body.experimentId;
  try {
    const res = await api('/api/judge/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
    if (out.job) followJob(out.job);
  } catch (error) {
    ui.error = error.message;
    ui.before = null;
    stopAutoplay();
  }
  ui.sending = false;
  render();
}

// ---- the traffic feed: live page views and orders per version ---------------------------------------------------
let feed = null;
function connectFeed() {
  if (feed || document.hidden) return;
  feed = new EventSource(`/api/traffic?token=${encodeURIComponent(TOKEN)}`); // EventSource can't set headers
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

// ---- drawing ------------------------------------------------------------------------------------------------------
function render() {
  const s = ui.state;
  const err = $('error');
  err.hidden = !ui.error;
  setText(err, ui.error);
  if (!s) return;

  const links = s.links ?? {};
  $('link-shop').setAttribute('href', links.shop ?? '#');
  const fs = $('link-flagsmith');
  fs.hidden = !(links.experiment ?? s.dashboardUrl);
  fs.setAttribute('href', links.experiment ?? s.dashboardUrl ?? '#');

  const m = M.model(s);
  if (ui.live.exp !== s.experiment?.id) ui.live = { exp: s.experiment?.id ?? null, counts: {} };

  setText($('now'), m.now);
  setText($('exp-id'), s.experiment ? `Flagsmith experiment #${s.experiment.id}` : '');
  renderVersions(s, m);
  renderSteps(s, m);
  renderNext(s, m);
  renderHistory(s);
  paintLive();
  scheduleAutoplay(m);
}

function renderVersions(s, m) {
  const box = $('versions');
  box.hidden = !m.versions.length;
  const goal = s.results?.metrics?.find((x) => x.role === 'goal');
  // The tiles are built once per pair of releases and then only their words change: moving a preview frame in the
  // page reloads it, so the frames stay where they are.
  const pair = JSON.stringify(m.versions.map((v) => [v.key, v.release]));
  if (box.dataset.pair !== pair) {
    box.dataset.pair = pair;
    box.replaceChildren(...m.versions.map((v) => h('article', { class: 'version', 'data-key': v.key },
      h('div', { class: 'version-head' }, h('span', { class: 'version-role' }), h('span', { class: 'version-badge' })),
      h('h3', { class: 'version-name' }, M.label(v.release)),
      frameFor(s, v.release),
      h('p', { class: 'version-line', 'data-live': v.release }),
      h('p', { class: 'version-line version-fs' }))));
    fitFrames();
  }
  m.versions.forEach((v, i) => {
    const tile = /** @type {HTMLElement} */ (box.children[i]);
    tile.dataset.state = v.state;
    setText(tile.querySelector('.version-role'), v.role);
    setText(tile.querySelector('.version-badge'), v.badge);
    const arm = goal?.arms?.[v.key];
    setText(tile.querySelector('.version-fs'), arm ? `Flagsmith: ${(arm.mean * 100).toFixed(1)}% of ${arm.n.toLocaleString('en-GB')} shoppers ordered` : '');
  });
}

function frameFor(s, release) {
  if (!ui.frames[release]) {
    const src = `${(s.links?.shop ?? '').replace(/\/$/, '')}/?__turnout_view=${encodeURIComponent(release)}`;
    const iframe = h('iframe', { src, title: `Preview of ${M.label(release)}`, tabindex: '-1', 'aria-hidden': 'true' });
    iframe.addEventListener('load', fitFrames);
    ui.frames[release] = h('div', { class: 'version-frame' }, iframe);
  }
  return ui.frames[release];
}
function fitFrames() {
  for (const box of document.querySelectorAll('.version-frame')) {
    const f = box.querySelector('iframe');
    if (f && box.clientWidth) f.style.transform = `scale(${(box.clientWidth / 1280).toFixed(4)})`;
  }
}
new ResizeObserver(fitFrames).observe(document.documentElement);

const JOB_STEP = { visitors: 'visitors', score: 'score', ship: 'decide', revert: 'decide', 'keep-running': 'decide', release: 'start', reset: 'start' };

function renderSteps(s, m) {
  const job = ui.job?.status === 'running' ? ui.job : null;
  // A new test started from the finished page shows its progress in the box under the steps instead.
  const jobStep = job && !(m.finished && JOB_STEP[job.action] === 'start') ? JOB_STEP[job.action] : null;
  const items = m.steps.map((st) => {
    const showJob = jobStep === st.id;
    const isCurrent = st.status === 'current' && !m.finished;
    const body = [];
    if (st.result) body.push(h('p', { class: 'step-result' }, st.result));
    if (st.id === 'score' && m.findings.length && (st.status === 'done' || m.finished)) body.push(findingsTable(s, m));
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
  const wait = a.waitUntil ? Math.max(0, Date.parse(a.waitUntil) - Date.now()) : 0;
  const mins = Math.floor(wait / 60000);
  const secs = String(Math.floor((wait % 60000) / 1000)).padStart(2, '0');
  const busy = ui.job?.status === 'running' || ui.state?.job?.status === 'running' || ui.sending || Boolean(ui.settle);
  const main = h('button', { class: 'btn btn-go', type: 'button', id: 'go', disabled: wait > 0 || busy, on: { click: () => run(a.action) } },
    ui.sending ? 'Starting…' : ui.settle ? 'Reading Flagsmith…' : wait > 0 ? `Flagsmith allows the next look in ${mins}:${secs}` : a.label);
  const alt = m.alt ? h('button', { class: 'btn btn-quiet', type: 'button', disabled: busy, on: { click: () => run(m.alt.action) } }, m.alt.label) : null;
  if (wait > 0 && !ui.tick) ui.tick = setTimeout(() => ((ui.tick = 0), render()), 1000);
  return h('div', { class: 'action' },
    m.verdict && a.action !== 'visitors' && a.action !== 'score' ? h('p', { class: 'verdict', 'data-tone': m.verdict.tone }, h('strong', {}, `${m.verdict.title}. `), m.verdict.text) : null,
    h('p', { class: 'action-explain' }, a.explain),
    h('div', { class: 'action-row' }, main, alt));
}

function jobBox(job) {
  const v = M.jobView(job);
  return h('div', { class: 'job', role: 'status' },
    h('p', { class: 'job-title' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), `${v.title}…`, h('span', { class: 'job-detail' }, v.detail)),
    v.fraction !== null ? h('div', { class: 'bar' }, h('i', { style: { width: `${Math.round(v.fraction * 100)}%` } })) : null);
}

function findingsTable(s, m) {
  const e = s.experiment;
  return h('div', { class: 'findings' },
    h('table', {},
      h('thead', {}, h('tr', {},
        h('th', { scope: 'col' }, 'What Flagsmith measured'),
        h('th', { scope: 'col', class: 'num' }, M.label(e.control)),
        h('th', { scope: 'col', class: 'num' }, M.label(e.v2)),
        h('th', { scope: 'col' }, `${M.label(e.v2)} is…`))),
      h('tbody', {}, ...m.findings.map((f) => h('tr', { 'data-tone': f.tone, 'data-role': f.role },
        h('th', { scope: 'row' }, h('span', { class: 'f-name' }, f.name), h('span', { class: 'f-role', 'data-role': f.role }, f.roleText), f.hint ? h('span', { class: 'f-hint' }, f.hint) : null),
        h('td', { class: 'num', 'data-label': M.label(e.control) }, f.current),
        h('td', { class: 'num', 'data-label': M.label(e.v2) }, f.next),
        h('td', { class: 'f-call' }, h('span', { class: 'f-word' }, f.word), f.note ? h('span', { class: 'f-note' }, f.note) : null))))),
    h('p', { class: 'findings-src' }, 'Numbers and calls exactly as Flagsmith returned them.',
      s.links?.experiment ? [' ', h('a', { href: s.links.experiment, target: '_blank', rel: 'noopener' }, 'See them in Flagsmith ↗')] : null));
}

function outcomeBox(m) {
  const o = m.outcome;
  const lastJobs = [ui.job, ui.state?.job, ui.decision].filter(Boolean);
  const exp = ui.state?.experiment?.id;
  const decisionJob = lastJobs.find((j) => (j.action === 'ship' || j.action === 'revert') && j.status === 'done' && j.changes?.before?.experiment?.id === exp);
  const changed = M.changes(decisionJob);
  const check = M.verifyText(lastJobs.find((j) => j.action === 'verify'));
  return h('div', { class: 'outcome', 'data-shipped': String(o.shipped) },
    h('p', { class: 'outcome-title' }, o.title),
    h('p', {}, o.text),
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
  if (job) return box.replaceChildren(...(['release', 'reset', 'verify'].includes(job.action) ? [jobBox(job)] : []));
  if (!m.action) return box.replaceChildren();
  box.replaceChildren(h('p', { class: 'next-lead' }, 'This test is finished. Run the next one:'), actionBox({ ...m, verdict: null, alt: null }));
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

connectFeed();
loadState();
