// Your test (your app's console, /app, from Try it): the verdict in one sentence, every metric as Flagsmith returned
// it, the checks Turnout runs (split, settings, visitors needed), what visitors were seen doing, the goal changed
// mid-test, steady simulated visitors and the Markdown report. Only on /app; nothing here on the demo console.
import { metricRows, report, splitCheck, verdict } from './verdict.js';

const TOKEN = document.querySelector('meta[name="turnout-console"]')?.getAttribute('content') ?? '';
const api = (path, init = {}) => fetch(path.replace(/^\/api\//, '/try/api/'), { ...init, headers: { ...(init.headers ?? {}), 'x-turnout-console': TOKEN } });
const json = async (path, init) => {
  const res = await api(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
};
const post = (path, body) => json(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

function setUp() {
  const dialog = h('dialog', { id: 'test-panel', class: 'dialog test-panel', 'aria-labelledby': 'tp-title' });
  const body = h('div', { class: 'tp-body' });
  dialog.append(
    h('header', { class: 'tp-head' }, h('h2', { id: 'tp-title' }, 'Your test'), h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => dialog.close() }, 'Close')),
    body,
  );
  document.body.append(dialog);
  const open = h('button', { class: 'btn btn-small', id: 'tp-open', type: 'button', title: 'The verdict, every metric, the checks, the goal and steady visitors' }, 'Your test');
  document.getElementById('tour-open')?.before(open);
  let timer = 0;
  open.addEventListener('click', () => {
    dialog.showModal();
    void render(body);
    timer = window.setInterval(() => void render(body), 10_000);
  });
  dialog.addEventListener('close', () => clearInterval(timer));
}

const say = (el, text, tone) => {
  el.textContent = text;
  if (tone) el.dataset.tone = tone;
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
  const goal = state.results?.metrics?.find((m) => m.role === 'goal');
  const split = goal ? splitCheck(goal.arms) : { ok: true, text: 'Split check: no visitors yet.' };
  const n = w?.needed;

  // The card: the verdict and the goal row; everything else below it.
  const card = h('section', { class: 'tp-card' },
    h('p', { class: 'tp-verdict' }, verdict(state, state.names ?? {})),
    h('p', { class: 'tp-goal' }, `Goal: ${st.goal ?? 'page speed'}${st.goalSince ? `, counting from ${String(st.goalSince).slice(11, 16)} UTC` : ''}`));

  const checks = h('ul', { class: 'tp-checks' },
    h('li', { 'data-tone': split.ok ? 'good' : 'bad' }, split.text),
    h('li', { 'data-tone': settings.ok ? 'good' : 'bad' }, settings.ok ? `Settings check: the proxy routes on Flagsmith's current settings${settings.ageSeconds != null ? ` (read ${settings.ageSeconds} s ago)` : ''}.` : `Settings check: ${settings.differences.join('; ')}.`),
    n ? h('li', {}, `Visitors needed: about ${n.perVersion} per version for a ${Math.round(n.lift * 100)}% lift on a ${(n.base * 100).toFixed(1)}% rate (Flagsmith's minimum: 50 visitors and 5 conversions).${Object.keys(w.counted ?? {}).length ? ` Counted: ${Object.entries(w.counted).map(([k, v]) => `${k} ${v}`).join(', ')}.` : ''}`) : null);

  const rows = metricRows(state.results);
  const table = h('div', { class: 'tp-table-wrap' }, h('table', { class: 'tp-table' },
    h('thead', {}, h('tr', {}, ...['Metric', 'Role', 'Arm', 'Visitors', 'Mean', 'Lift', '95% interval', 'Chance to win'].map((t) => h('th', { scope: 'col' }, t)))),
    h('tbody', {}, ...rows.map((r) => h('tr', {}, ...[r.metric, r.role, r.arm, r.n, r.mean, r.lift, r.interval, r.chance].map((v) => h('td', {}, v)))))));
  const full = h('details', { class: 'tp-full' }, h('summary', {}, `Every metric, as Flagsmith returned it (${rows.length} rows)`), rows.length ? table : h('p', {}, 'No results yet.'));

  // The goal: a choice from the actions found on every version (plain words), changed mid-test.
  const choice = h('select', { id: 'tp-goal', 'aria-label': 'What counts as a win' },
    h('option', { value: '' }, 'Page speed (no goal)'),
    ...(w?.offered ?? []).map((a) => h('option', { value: a.goal, selected: a.goal === st.goal }, `A visitor who ${a.label} (${a.goal})`)));
  const goalNote = h('p', { class: 'tp-note', role: 'status' });
  const goalBox = h('section', { class: 'tp-box' }, h('h3', {}, 'What should count as a win?'), choice,
    h('button', { class: 'btn', type: 'button', onclick: async () => {
      say(goalNote, 'Starting a new experiment with that goal…');
      try {
        const r = await post('/api/try/goal', { goal: choice.value });
        say(goalNote, `Counting from ${String(r.goalSince).slice(11, 16)} UTC.`, 'good');
      } catch (e) {
        say(goalNote, e.message, 'bad');
      }
    } }, 'Count this instead'), goalNote);

  // Steady simulated visitors, labelled; results fetched when Flagsmith allows.
  const rate = h('input', { type: 'number', min: '1', max: '600', value: String(w?.steady?.perMinute || 20), 'aria-label': 'Simulated visitors a minute' });
  const steadyNote = h('p', { class: 'tp-note', role: 'status' }, w?.steady?.on ? `Running: ${w.steady.perMinute} simulated visitors a minute.` : 'Off.');
  const steadyBox = h('section', { class: 'tp-box' }, h('h3', {}, 'Simulated visitors, steady'), h('label', {}, rate, ' a minute'),
    h('button', { class: 'btn', type: 'button', onclick: async () => {
      try {
        const s = await post('/api/try/steady', { perMinute: Number(rate.value) });
        say(steadyNote, `Running: ${s.perMinute} simulated visitors a minute. Results refresh every 5 minutes.`, 'good');
      } catch (e) {
        say(steadyNote, e.message, 'bad');
      }
    } }, 'Start'),
    h('button', { class: 'btn btn-ghost', type: 'button', onclick: async () => (await post('/api/try/steady', { perMinute: 0 }), say(steadyNote, 'Off.')) }, 'Stop'), steadyNote);

  const seen = h('details', { class: 'tp-full' }, h('summary', {}, `What visitors were seen doing (${(w?.seen ?? []).length})`),
    h('ul', { class: 'tp-seen' }, ...(w?.seen ?? []).slice(0, 25).map((s) => h('li', {}, `${s.action}: ${s.count}${Object.keys(s.statuses ?? {}).length ? ` (${Object.entries(s.statuses).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`))));

  // The report: Markdown, saved as a file.
  const save = h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => {
    const url = URL.createObjectURL(new Blob([report(state)], { type: 'text/markdown' }));
    const a = h('a', { href: url, download: `turnout-report-${new Date().toISOString().slice(0, 10)}.md` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } }, 'Save the report (Markdown)');

  const open = [...body.querySelectorAll('details')].map((d) => d.open);
  body.replaceChildren(card, checks, full, h('div', { class: 'tp-row' }, goalBox, steadyBox), seen, save);
  body.querySelectorAll('details').forEach((d, i) => (d.open = open[i] ?? false));
}

if (document.querySelector('meta[name="turnout-app"]')) setUp();
