// Your test (your app's console, /app, from Try it): the verdict in one sentence (with a red alert when the test
// can't be fair), progress per version, every metric as Flagsmith returned it (in plain words), the checks Turnout
// runs, what visitors were seen doing, the goal changed mid-test, steady simulated visitors and the Markdown report.
import { armReleases, fairness, goalWords, metricLabel, metricValue, report, splitCheck, verdict, versionName } from './verdict.js';

const TOKEN = document.querySelector('meta[name="turnout-console"]')?.getAttribute('content') ?? '';
// Try it's API, through the console: /api/try/status → /try/api/try/status.
const api = (path, init = {}) => fetch(path.replace(/^\/api\//, '/try/api/'), { ...init, headers: { ...(init.headers ?? {}), 'x-turnout-console': TOKEN } });
const json = async (path, init) => {
  const res = await api(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
};
const post = (path, body) => json(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const pct = (x) => `${Math.round(x * 100)}%`;

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

let lastState = null;
function saveReport() {
  if (!lastState) return;
  const url = URL.createObjectURL(new Blob([report(lastState)], { type: 'text/markdown' }));
  const a = h('a', { href: url, download: `turnout-report-${new Date().toISOString().slice(0, 10)}.md` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setUp() {
  const dialog = h('dialog', { id: 'test-panel', class: 'dialog test-panel', 'aria-labelledby': 'tp-title' });
  const body = h('div', { class: 'tp-body' });
  dialog.append(
    h('header', { class: 'tp-head' },
      h('h2', { id: 'tp-title' }, 'Your test'),
      h('span', { class: 'tp-head-actions' },
        h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: saveReport }, 'Save report (.md)'),
        h('button', { class: 'btn btn-small', type: 'button', onclick: () => dialog.close() }, 'Close'))),
    body,
  );
  document.body.append(dialog);
  const open = h('button', { class: 'btn btn-small', id: 'tp-open', type: 'button', title: 'The verdict, every metric, the checks, the goal and steady visitors' }, 'Your test');
  document.getElementById('tour-open')?.before(open);
  let timer = 0;
  open.addEventListener('click', () => {
    // One dialog at a time: the tour steps aside.
    [...document.querySelectorAll('.tour-tip button')].find((b) => /end tour|done/i.test(b.textContent ?? ''))?.click();
    dialog.showModal();
    void render(body);
    timer = window.setInterval(() => void render(body), 10_000);
  });
  dialog.addEventListener('close', () => clearInterval(timer));
}

const say = (el, text, tone) => {
  el.textContent = text;
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
};

async function render(body) {
  const [st, w, state, settings] = await Promise.all([
    json('/api/try/status').catch(() => null),
    json('/api/try/actions').catch(() => null),
    json('/api/judge/state').catch(() => null),
    json('/api/try/settings-check').catch((e) => ({ ok: false, differences: [e.message] })),
  ]);
  if (!st || st.status !== 'ready' || !state) {
    body.replaceChildren(h('p', {}, st?.status === 'building' ? 'Setting up the test…' : 'Nothing is running yet: build your versions with Try it first.'));
    return;
  }
  lastState = state;
  const names = { ...(st.names ?? {}), ...(state.names ?? {}) };
  const releases = armReleases(state);
  const armName = (key) => versionName(releases[key], names);
  const results = state.results;
  const goalMetric = results?.metrics?.find((m) => m.role === 'goal');
  const goalLabel = st.goal ? `visitors who ${goalWords(st.goal)}` : 'page speed';
  const unfair = fairness(state, w?.seen ?? [], st.goal, names);

  // The card: the verdict (or, first, why the test can't be fair) and the goal.
  const card = h('section', { class: 'tp-card', 'data-tone': unfair ? 'bad' : null },
    unfair ? h('p', { class: 'tp-alert', role: 'alert' }, unfair) : null,
    h('p', { class: 'tp-verdict' }, verdict(state, Object.fromEntries(Object.values(releases).map((r) => [r, versionName(r, names)])), { goalLabel })),
    h('p', { class: 'tp-goal' }, `Goal: a visitor who ${goalWords(st.goal)}${st.goal ? ` (${st.goal})` : ''}${st.goalSince ? `, counting from ${String(st.goalSince).slice(11, 16)} UTC` : ''}`));

  // Progress per version toward the visitors needed (Flagsmith's minimum marked).
  const n = w?.needed;
  const progress = goalMetric && n ? h('section', { class: 'tp-progress', 'aria-label': 'Visitors so far' },
    h('h3', {}, `Visitors so far, of about ${n.perVersion.toLocaleString()} per version for a ${pct(n.lift)} lift`),
    ...Object.entries(goalMetric.arms).map(([k, a]) => h('div', { class: 'tp-bar-row' },
      h('span', { class: 'tp-bar-name' }, armName(k)),
      h('span', { class: 'tp-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(n.perVersion), 'aria-valuenow': String(a.n) },
        h('span', { class: 'tp-bar-fill', style: `width:${Math.min(100, (a.n / n.perVersion) * 100).toFixed(1)}%` }),
        h('span', { class: 'tp-bar-min', style: `left:${Math.min(100, (50 / n.perVersion) * 100).toFixed(2)}%`, title: "Flagsmith's minimum: 50 visitors" })),
      h('span', { class: 'tp-bar-num' }, `${a.n.toLocaleString()} visitors`))),
    h('p', { class: 'tp-note' }, "The tick is Flagsmith's minimum (50 visitors and 5 conversions per version).")) : null;

  const split = goalMetric ? splitCheck(goalMetric.arms) : { ok: true, text: 'Split check: no visitors yet.' };
  const checks = h('ul', { class: 'tp-checks' },
    h('li', { 'data-tone': split.ok ? 'good' : 'bad' }, split.text.replace(/\b(control|v\d)\b/g, (k) => armName(k))),
    h('li', { 'data-tone': settings.ok ? 'good' : 'bad' }, settings.ok ? `Settings check: the proxy routes on Flagsmith's current settings${settings.ageSeconds != null ? ` (read ${settings.ageSeconds} s ago)` : ''}.` : `Settings check: ${settings.differences.join('; ')}.`));

  // Every metric: one row each, a column per version, values as people read them.
  const keys = goalMetric ? Object.keys(goalMetric.arms).sort((a, b) => (a === 'control' ? -1 : b === 'control' ? 1 : a.localeCompare(b))) : [];
  const cell = (m, k) => {
    const a = m.arms?.[k];
    const vs = m.byArm?.[k] ?? (k === 'v2' ? m.v2 : null);
    return h('td', {}, h('strong', {}, metricValue(m, a?.mean)), a ? h('span', { class: 'tp-n' }, ` n ${a.n}`) : null,
      vs ? h('div', { class: 'tp-vs' }, `${vs.lift >= 0 ? '+' : ''}${pct(vs.lift)} (${pct(vs.ciLow)} to ${pct(vs.ciHigh)}), ${pct(vs.chanceToWin)} chance to win`)
        : k !== 'control' && a ? h('div', { class: 'tp-vs' }, m.verdict === 'no-events' ? 'no result: nothing counted' : 'no result yet') : null);
  };
  const table = h('div', { class: 'tp-table-wrap' }, h('table', { class: 'tp-table' },
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Metric'), ...keys.map((k) => h('th', { scope: 'col' }, armName(k))))),
    h('tbody', {}, ...(results?.metrics ?? []).map((m) => h('tr', {}, h('th', { scope: 'row', title: m.name }, metricLabel(m, st.goal), h('div', { class: 'tp-role' }, m.role === 'guardrail' ? 'safety check' : m.role)), ...keys.map((k) => cell(m, k)))))));
  const full = h('details', { class: 'tp-full', open: true }, h('summary', {}, "Every metric, as Flagsmith returned it"), results?.metrics?.length ? table : h('p', {}, 'No results yet: send visitors, then Refresh in the console.'));

  // The goal: a choice from the actions found on every version, the current one always listed and selected.
  const offered = [...(w?.offered ?? [])];
  if (st.goal && !offered.some((a) => a.goal === st.goal)) offered.unshift({ goal: st.goal, label: goalWords(st.goal) });
  const choice = h('select', { id: 'tp-goal', 'aria-label': 'What counts as a win' },
    ...offered.map((a) => h('option', { value: a.goal, selected: a.goal === st.goal }, `A visitor who ${a.label}`)),
    h('option', { value: '', selected: !st.goal }, 'Page speed only (no goal)'));
  const change = h('button', { class: 'btn btn-primary', type: 'button', disabled: true }, 'Count this instead');
  choice.addEventListener('change', () => (change.disabled = choice.value === (st.goal ?? '')));
  const goalNote = h('p', { class: 'tp-note', role: 'status' }, 'Changing it starts a new experiment on the same versions, counted from then.');
  change.addEventListener('click', async () => {
    change.disabled = true;
    say(goalNote, 'Starting a new experiment with that goal…');
    try {
      const r = await post('/api/try/goal', { goal: choice.value });
      say(goalNote, `Done: counting from ${String(r.goalSince).slice(11, 16)} UTC.`, 'good');
    } catch (e) {
      say(goalNote, e.message, 'bad');
    }
  });
  const goalBox = h('section', { class: 'tp-box' }, h('h3', {}, 'What should count as a win?'), choice, change, goalNote);

  // Steady simulated visitors: Start when off, Stop when on.
  const on = Boolean(w?.steady?.on);
  const rate = h('input', { type: 'number', min: '1', max: '600', value: String(w?.steady?.perMinute || 20), 'aria-label': 'Simulated visitors a minute' });
  const steadyNote = h('p', { class: 'tp-note', role: 'status', 'data-tone': on ? 'good' : null }, on ? `Running: ${w.steady.perMinute} a minute, labelled as simulated. Results refresh every 5 minutes.` : 'Off. Labelled as simulated; results refresh every 5 minutes while on.');
  const toggle = h('button', { class: on ? 'btn' : 'btn btn-primary', type: 'button' }, on ? 'Stop' : 'Start');
  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    try {
      await post('/api/try/steady', { perMinute: on ? 0 : Number(rate.value) });
      await render(body);
    } catch (e) {
      say(steadyNote, e.message, 'bad');
      toggle.disabled = false;
    }
  });
  const steadyBox = h('section', { class: 'tp-box' }, h('h3', {}, 'Simulated visitors, steady'),
    h('div', { class: 'tp-inline' }, h('label', {}, rate, ' a minute'), toggle), steadyNote);

  const seenList = w?.seen ?? [];
  const seen = h('details', { class: 'tp-full' }, h('summary', {}, `What visitors were seen doing (${seenList.length})`),
    seenList.length ? h('ul', { class: 'tp-seen' }, ...seenList.slice(0, 25).map((s) => h('li', {},
      h('code', {}, s.action), ` ${s.count.toLocaleString()} times`,
      Object.keys(s.failedByRelease ?? {}).length ? h('span', { class: 'tp-fail' }, ` · errors on ${Object.entries(s.failedByRelease).map(([r, c]) => `${versionName(r, names)} (${c})`).join(', ')}`) : null)))
      : h('p', { class: 'tp-note' }, 'Nothing yet: open your app through Turnout, or send visitors.'));

  const open = [...body.querySelectorAll('details')].map((d) => d.open);
  body.replaceChildren(card, progress ?? '', checks, full, h('div', { class: 'tp-row' }, goalBox, steadyBox), seen);
  body.querySelectorAll('details').forEach((d, i) => (d.open = open[i] ?? d.open));
}

// The same alert on the page itself, above the cards: an unfair test is never only inside a dialog.
async function banner() {
  const [st, w, state] = await Promise.all([json('/api/try/status').catch(() => null), json('/api/try/actions').catch(() => null), json('/api/judge/state').catch(() => null)]);
  const text = st?.status === 'ready' && state ? fairness(state, w?.seen ?? [], st.goal, st.names ?? {}) : null;
  let el = document.getElementById('tp-banner');
  if (!text) return void el?.remove();
  if (!el) {
    el = h('p', { id: 'tp-banner', class: 'tp-banner', role: 'alert' });
    document.getElementById('main')?.before(el);
  }
  el.textContent = text;
}

if (document.querySelector('meta[name="turnout-app"]')) {
  setUp();
  void banner();
  setInterval(() => void banner(), 15_000);
}
