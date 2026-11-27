// The Flagsmith feature map: renders GET /api/flagsmith-map. On top, the four rounds of a Flagsmith experiment (the
// hackathon's own loop: create a flag, pick a metric, split the traffic, ship the winner), each with the Flagsmith
// features Turnout uses for it and their live values; below, every feature, menu and integration as cards, with
// filters by status and a search. Every string from the server goes in through textContent, and only http(s) links
// become hrefs.
import { BASE, setupMenu } from './menu.js';

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const TOKEN = globalThis.document?.querySelector('meta[name="turnout-console"]')?.getAttribute('content') ?? '';
const TOKEN_HEADER = 'x-turnout-console';

export const GROUPS = [
  { status: 'used', title: 'Used live', chip: 'Used live', sub: 'Turnout writes to these, or runs on them, during the demo.' },
  { status: 'used-read-only', title: 'Read only', chip: 'Read only', sub: 'Turnout reads these, or they show what Turnout set somewhere else.' },
  {
    status: 'not-available-locally',
    title: 'Needs a public endpoint or account',
    chip: 'Needs more',
    sub: "Real Flagsmith features that need something a laptop demo doesn't have. Each says what, with the Flagsmith source behind it.",
  },
  { status: 'not-used', title: 'Not used', chip: 'Not used', sub: 'Available here, but nothing in the demo calls for it yet.' },
];
const KIND = { menu: 'Menu', integration: 'Integration', feature: 'Feature' };

/** The experiment loop, round by round: what Turnout does, and the map items (by id) that do it in Flagsmith. */
export const ROUNDS = [
  { n: '01', title: 'Create a flag', what: 'One multivariate flag holds every version: each variant’s value names a release, and the proxy evaluates it locally.', ids: ['feature.multivariate-flag', 'feature.local-evaluation', 'feature.tags'] },
  { n: '02', title: 'Pick a metric', what: 'Plain HTTP becomes Flagsmith events: page loads, the goal request, page speed and server errors, in Flagsmith’s own event store.', ids: ['feature.metrics', 'feature.event-store', 'feature.prometheus'] },
  { n: '03', title: 'Split the traffic', what: 'Each test is a Flagsmith experiment: its split, its audience and Bayesian results. Segments and identity overrides keep your team and pinned browsers out of it.', ids: ['feature.experiments', 'menu.segments', 'menu.identities'] },
  { n: '04', title: 'Ship the winner', what: 'Ship sets the flag’s environment default and drains the split: everyone moves with one flag change. Feature Health flags a losing safety check.', ids: ['menu.environments', 'feature.feature-health', 'integration.code-references'] },
];
// Opens on what Turnout uses (live or read-only); All shows the integrations that need an outside account too.
const view = { status: 'used-any', q: '', map: null };

/** Small element builder; strings become text nodes, never HTML. */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('data-') || k.startsWith('aria-') || ['role', 'target', 'rel', 'href', 'id'].includes(k)) node.setAttribute(k, String(v));
    else node[k] = v;
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Only absolute http(s) URLs are links; anything else (javascript:, data:) is dropped. */
export function safeHref(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function card(item, chip) {
  const link = safeHref(item.link);
  return h(
    'li',
    { class: 'fcard', 'data-status': item.status, 'data-kind': item.kind },
    h('div', { class: 'fcard-top' }, h('span', { class: 'fkind' }, KIND[item.kind] ?? item.kind), h('span', { class: 'fchip' }, chip)),
    h('h3', { class: 'fcard-name' }, item.name),
    h('p', { class: 'fcard-what' }, item.what),
    item.needs ? h('p', { class: 'fneeds' }, h('span', { class: 'flabel' }, 'Needs'), ' ', item.needs) : null,
    item.live ? h('p', { class: 'flive' }, h('span', { class: 'flabel flabel-live' }, 'Live'), ' ', h('span', { class: 'flive-value' }, item.live)) : null,
    Array.isArray(item.details) && item.details.length
      ? h(
          'ul',
          { class: 'fdetails' },
          item.details.map((d) => {
            const href = safeHref(d.href);
            return h('li', {}, href ? h('a', { href, target: '_blank', rel: 'noopener' }, d.text, h('span', { class: 'sr-only' }, ' (new tab)')) : d.text);
          }),
        )
      : null,
    h(
      'div',
      { class: 'fcard-foot' },
      link ? h('a', { class: 'btn btn-small fopen', href: link, target: '_blank', rel: 'noopener' }, 'Open in Flagsmith', h('span', { class: 'sr-only' }, ` (${item.name}, new tab)`)) : null,
      item.source ? h('p', { class: 'fsource' }, h('span', { class: 'flabel' }, 'Flagsmith source'), ' ', h('code', {}, item.source)) : null,
    ),
  );
}

/** The rounds, each with its items' names and live values (an item missing from the map is left out). */
export function roundsFrom(items) {
  const byId = new Map((items ?? []).map((i) => [i.id, i]));
  return ROUNDS.map((r) => ({ ...r, items: r.ids.map((id) => byId.get(id)).filter(Boolean) }));
}

/** Items matching a status filter ('all' or a status) and a search over name, what and live value. */
export function filterItems(items, status, q) {
  const needle = String(q ?? '').trim().toLowerCase();
  const matches = (i) => status === 'all' || i.status === status || (status === 'used-any' && String(i.status).startsWith('used'));
  return (items ?? []).filter((i) => matches(i) && (!needle || [i.name, i.what, i.live].some((x) => String(x ?? '').toLowerCase().includes(needle))));
}

function renderRounds(items) {
  $('rounds').replaceChildren(...roundsFrom(items).map((r) => h('li', { class: 'round' },
    h('p', { class: 'round-n' }, `Round ${r.n}`),
    h('h3', { class: 'round-title' }, r.title),
    h('p', { class: 'round-what' }, r.what),
    h('ul', { class: 'round-items' }, r.items.map((i) => {
      const link = safeHref(i.link);
      return h('li', { class: 'round-item', 'data-status': i.status },
        link ? h('a', { href: link, target: '_blank', rel: 'noopener', class: 'round-name' }, i.name, h('span', { class: 'sr-only' }, ' (opens Flagsmith)')) : h('span', { class: 'round-name' }, i.name),
        i.live ? h('span', { class: 'round-live' }, i.live) : null);
    })))));
}

export function render(map) {
  view.map = map;
  const groups = $('groups');
  const counts = $('counts');
  const all = Array.isArray(map?.items) ? map.items : [];
  const items = filterItems(all, view.status, view.q);
  renderRounds(all);
  const fs = map?.flagsmith ?? {};
  const read = map?.generatedAt ? new Date(map.generatedAt) : null;
  $('summary-line').textContent = [
    fs.version ? `Flagsmith ${fs.version}` : 'Flagsmith',
    fs.projectId != null ? `project ${fs.projectId}` : null,
    fs.environment ? `environment ${fs.environment}` : null,
    fs.flag ? `flag ${fs.flag}` : null,
    read && !Number.isNaN(read.getTime()) ? `read at ${read.toLocaleTimeString()}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const open = /** @type {HTMLAnchorElement} */ ($('open-flagsmith'));
  const dash = safeHref(fs.dashboardUrl);
  if (dash) open.href = dash;
  open.hidden = !dash;

  // The filter chips: all, then each status with its count; the pressed one filters the cards below.
  const chip = (status, label, n) => h('li', { class: 'fcount', 'data-status': status },
    h('button', { type: 'button', 'aria-pressed': String(view.status === status), onclick: () => { view.status = status; render(view.map); } }, h('strong', {}, String(n)), ' ', label));
  counts.replaceChildren(
    chip('used-any', 'Used by Turnout', all.filter((i) => String(i.status).startsWith('used')).length),
    chip('all', 'All', all.length),
    ...GROUPS.map((g) => {
      const n = all.filter((i) => i.status === g.status).length;
      return n ? chip(g.status, g.title, n) : null;
    }).filter(Boolean),
  );
  groups.replaceChildren(
    ...GROUPS.map((g) => {
      const mine = items.filter((i) => i.status === g.status);
      if (!mine.length) return null;
      return h(
        'section',
        { class: 'fgroup', id: `group-${g.status}`, 'data-status': g.status, 'aria-labelledby': `title-${g.status}` },
        h('div', { class: 'fgroup-head' }, h('h2', { id: `title-${g.status}` }, g.title, ' ', h('span', { class: 'fgroup-n' }, `(${mine.length})`)), h('p', { class: 'card-sub' }, g.sub)),
        h('ul', { class: 'fgrid' }, mine.map((i) => card(i, g.chip))),
      );
    }).filter(Boolean),
  );
  if (!items.length) groups.replaceChildren(h('p', { class: 'card-sub' }, 'Nothing matches. Clear the search or pick All.'));
  groups.setAttribute('aria-busy', 'false');
}

async function load() {
  const button = /** @type {HTMLButtonElement} */ ($('refresh'));
  const banner = $('banner');
  button.disabled = true;
  $('groups').setAttribute('aria-busy', 'true');
  try {
    const res = await fetch(`${BASE}/api/flagsmith-map`, { headers: { [TOKEN_HEADER]: TOKEN } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error ?? `The console answered ${res.status}`);
    render(body);
    banner.hidden = true;
  } catch (error) {
    banner.textContent = `Couldn't read the map from Flagsmith: ${error instanceof Error ? error.message : String(error)}`;
    banner.hidden = false;
    $('groups').setAttribute('aria-busy', 'false');
    if ($('summary-line').textContent === 'Reading Flagsmith…') $('summary-line').textContent = 'Not read yet.';
  } finally {
    button.disabled = false;
  }
}

if (globalThis.document?.getElementById('groups')) {
  setupMenu('flagsmith');
  $('refresh').addEventListener('click', () => void load());
  $('search').addEventListener('input', (e) => {
    view.q = /** @type {HTMLInputElement} */ (e.target).value;
    if (view.map) render(view.map);
  });
  void load();
}
