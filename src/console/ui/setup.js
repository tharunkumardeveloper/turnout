// Setup check (/setup): turnout doctor's checks from GET /api/doctor, grouped by area, with "Expected → Actual"
// for anything that differs. Every string from the server goes in through textContent.
const TOKEN = document.querySelector('meta[name="turnout-console"]')?.getAttribute('content') ?? '';
const TOKEN_HEADER = 'x-turnout-console';
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

const MARK = { ok: '✓', warn: '!', fail: '✕' };
const WORD = { ok: 'OK', warn: 'Warning', fail: 'Failing' };
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Small element builder; strings become text nodes, never HTML. */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Checks grouped by area, in the order the server sent them. */
export function groupByArea(checks) {
  const groups = new Map();
  for (const c of checks) {
    if (!groups.has(c.area)) groups.set(c.area, []);
    groups.get(c.area).push(c);
  }
  return [...groups].map(([area, list]) => ({ area, checks: list }));
}

export function verdict(summary) {
  if (summary.fail) return `${summary.fail} thing${summary.fail === 1 ? '' : 's'} to fix`;
  if (summary.warn) return `Ready, with ${summary.warn} warning${summary.warn === 1 ? '' : 's'}`;
  return 'Everything is in place';
}

function areaNote(checks) {
  const fail = checks.filter((c) => c.status === 'fail').length;
  const warn = checks.filter((c) => c.status === 'warn').length;
  if (fail) return `${fail} failing`;
  if (warn) return `${warn} warning${warn === 1 ? '' : 's'}`;
  return checks.length === 1 ? 'OK' : `all ${checks.length} OK`;
}

function worst(checks) {
  return checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok';
}

function renderCheck(c) {
  const status = MARK[c.status] ? c.status : 'warn';
  const item = h('li', { class: 'check', 'data-status': status },
    h('span', { class: 'check-mark', 'aria-hidden': 'true' }, MARK[status]),
    h('div', { class: 'check-body' },
      h('p', { class: 'check-line' },
        h('span', { class: 'sr-only' }, `${WORD[status]}: `),
        h('span', { class: 'check-name' }, c.name),
        h('span', { class: 'check-actual' }, c.actual),
      ),
    ),
  );
  if (status !== 'ok') {
    const body = item.querySelector('.check-body');
    body.append(
      h('div', { class: 'diff', role: 'group', 'aria-label': 'Difference' },
        h('div', { class: 'diff-side' }, h('span', { class: 'diff-label' }, 'Expected'), h('span', { class: 'diff-value' }, c.expected)),
        h('span', { class: 'diff-arrow', 'aria-hidden': 'true' }, '→'),
        h('div', { class: 'diff-side diff-actual' }, h('span', { class: 'diff-label' }, 'Actual'), h('span', { class: 'diff-value' }, c.actual)),
      ),
    );
    if (c.fix) body.append(h('p', { class: 'fix' }, h('span', { class: 'fix-label' }, 'Fix: '), c.fix));
  }
  return item;
}

function render(report) {
  const { summary, checks } = report;
  $('verdict').textContent = verdict(summary);
  $('verdict').dataset.status = summary.fail ? 'fail' : summary.warn ? 'warn' : 'ok';
  $('count-ok').textContent = String(summary.ok);
  $('count-warn').textContent = String(summary.warn);
  $('count-fail').textContent = String(summary.fail);
  $('checked-at').textContent = `Checked at ${timeFmt.format(new Date(report.at))}.`;
  const groups = groupByArea(checks).map(({ area, checks: list }, i) =>
    h('section', { class: 'card group', 'data-status': worst(list), 'aria-labelledby': `area-${i}` },
      h('div', { class: 'group-head' },
        h('h3', { id: `area-${i}` }, area),
        h('span', { class: 'group-note' }, areaNote(list)),
      ),
      h('ul', { class: 'checks' }, list.map(renderCheck)),
    ),
  );
  $('groups').replaceChildren(...groups);
}

// fresh: "Check again" asks for new checks; the first load may take the console's kept result (15 s).
async function load(fresh = false) {
  const button = /** @type {HTMLButtonElement} */ ($('recheck'));
  button.disabled = true;
  $('recheck-spinner').hidden = false;
  $('groups').setAttribute('aria-busy', 'true');
  if ($('groups').childElementCount) $('verdict').textContent = 'Checking again…';
  try {
    const res = await fetch(fresh ? '/api/doctor?fresh=1' : '/api/doctor', { headers: { [TOKEN_HEADER]: TOKEN }, cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    render(body);
    $('error').hidden = true;
  } catch (error) {
    $('error').textContent = `Couldn't run the checks: ${error.message}. Is the console still running? In a terminal: docker compose run --rm cli doctor`;
    $('error').hidden = false;
    if (!$('groups').childElementCount) $('verdict').textContent = 'Not checked';
  } finally {
    button.disabled = false;
    $('recheck-spinner').hidden = true;
    $('groups').setAttribute('aria-busy', 'false');
  }
}

$('recheck').addEventListener('click', () => load(true));
load();
