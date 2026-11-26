// The Flagsmith feature map: renders GET /api/flagsmith-map as cards grouped by status. Every string from the server
// goes in through textContent, and only http(s) links become hrefs.

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const TOKEN = globalThis.document?.querySelector('meta[name="turnover-console"]')?.getAttribute('content') ?? '';
const TOKEN_HEADER = 'x-turnover-console';

export const GROUPS = [
  { status: 'used', title: 'Used live', chip: 'Used live', sub: 'Turnover writes to these, or runs on them, during the demo.' },
  { status: 'used-read-only', title: 'Read only', chip: 'Read only', sub: 'Turnover reads these, or they show what Turnover set somewhere else.' },
  {
    status: 'not-available-locally',
    title: 'Needs a public endpoint or account',
    chip: 'Needs more',
    sub: "Real Flagsmith features that need something a laptop demo doesn't have. Each says what, with the Flagsmith source behind it.",
  },
  { status: 'not-used', title: 'Not used', chip: 'Not used', sub: 'Available here, but nothing in the demo calls for it yet.' },
];
const KIND = { menu: 'Menu', integration: 'Integration', feature: 'Feature' };

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

export function render(map) {
  const groups = $('groups');
  const counts = $('counts');
  const items = Array.isArray(map?.items) ? map.items : [];
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

  counts.replaceChildren(
    ...GROUPS.map((g) => {
      const n = items.filter((i) => i.status === g.status).length;
      return n || g.status !== 'not-used'
        ? h('li', { class: 'fcount', 'data-status': g.status }, h('a', { href: `#group-${g.status}` }, h('strong', {}, String(n)), ' ', g.title))
        : null;
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
  groups.setAttribute('aria-busy', 'false');
}

async function load() {
  const button = /** @type {HTMLButtonElement} */ ($('refresh'));
  const banner = $('banner');
  button.disabled = true;
  $('groups').setAttribute('aria-busy', 'true');
  try {
    const res = await fetch('/api/flagsmith-map', { headers: { [TOKEN_HEADER]: TOKEN } });
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
  $('refresh').addEventListener('click', () => void load());
  void load();
}
