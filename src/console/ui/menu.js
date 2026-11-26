// The menu the console and judge mode share: the views, every version of the site on its own (never counted), and
// how to sign in to Flagsmith on this machine. Server mode's public page keeps only what the public may see: judge
// mode and the versions; no console, no setup check, no Flagsmith link or login. Every string goes in through
// textContent.
//
// Markup (in each page): <nav class="menu" id="menu">…<details id="menu-versions">…<details id="menu-flagsmith">…

const meta = (name) => (typeof document === 'undefined' ? null : document.querySelector(`meta[name="${name}"]`));
const TOKEN = meta('turnout-console')?.getAttribute('content') ?? '';
const BASE = meta('turnout-base')?.getAttribute('content') ?? '';
export const READONLY = meta('turnout-readonly') !== null;
// Judge mode drives the demo shop; a console for your own app (turnout compare) has none, so no links to it.
export const NO_JUDGE = meta('turnout-no-judge') !== null;
const api = (path) => fetch(BASE + path, { cache: 'no-store', headers: { 'x-turnout-console': TOKEN } });

const NAMES = { 'shop:1.4': 'Classic', 'shop:1.5': 'Express', 'shop:1.6': 'Bold' };
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const label = (r) => `${String(r).replace(/^[^:]*:/, '')}${NAMES[r] ? ` ${NAMES[r]}` : ''}`;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}

/** The link that shows one version on its own: the proxy's view switch, never counted as a visitor. */
export const viewLink = (shop, release) => `${String(shop ?? '').replace(/\/$/, '')}/?__turnout_view=${encodeURIComponent(release)}`;

let versions = { shop: null, releases: [] };

/** The versions this setup routes to, from the judge state (releases and the shop's public address). */
export function setVersions(shop, releases) {
  const key = JSON.stringify([shop, releases]);
  if (versions.key === key) return;
  versions = { key, shop, releases: [...(releases ?? [])] };
  const box = document.getElementById('versions-list');
  if (!box) return;
  box.replaceChildren(
    el('p', { class: 'menu-note' }, 'Each version on its own, in a new tab. Looking never counts as a visit.'),
    el('ul', { class: 'menu-list' }, ...versions.releases.map((r, i) =>
      el('li', {},
        el('span', { class: 'menu-letter', 'data-i': String(i) }, LETTERS[i] ?? '?'),
        el('a', { href: viewLink(shop, r), target: '_blank', rel: 'noopener' }, label(r), el('span', { class: 'menu-sub' }, i === 0 ? ' · what everyone gets first' : ''))))),
    el('p', { class: 'menu-note' }, 'The plain shop link gives you a version the way a real visitor gets one: ',
      el('a', { href: String(shop ?? '#'), target: '_blank', rel: 'noopener' }, 'open the site ↗')),
  );
}

async function loadVersions() {
  if (versions.releases.length) return;
  try {
    const r = await api('/api/judge/state');
    if (r.ok) {
      const s = await r.json();
      setVersions(s.links?.shop, s.releases);
    }
  } catch {
    /* the menu says so below */
  }
  if (!versions.releases.length) document.getElementById('versions-list')?.replaceChildren(el('p', { class: 'menu-note' }, "Couldn't read the versions just now."));
}

async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Select and copy';
  }
  setTimeout(() => (button.textContent = 'Copy'), 1500);
}

let signin = null;
async function loadSignin() {
  const box = document.getElementById('flagsmith-panel');
  if (!box || signin) return;
  try {
    const r = await api('/api/judge/signin');
    signin = r.ok ? await r.json() : { error: true };
  } catch {
    signin = { error: true };
  }
  if (signin.error || !signin.dashboardUrl) {
    box.replaceChildren(el('p', { class: 'menu-note' }, "Flagsmith's address isn't known to this console."));
    return;
  }
  const row = (name, value, secret = false) => {
    const input = el('input', { class: 'menu-secret', type: secret ? 'password' : 'text', readonly: true, value: value ?? '', 'aria-label': name, spellcheck: 'false' });
    const copyBtn = el('button', { class: 'menu-btn', type: 'button', on: { click: (e) => copy(value ?? '', e.currentTarget) } }, 'Copy');
    const show = secret
      ? el('button', { class: 'menu-btn', type: 'button', on: { click: (e) => { input.type = input.type === 'password' ? 'text' : 'password'; e.currentTarget.textContent = input.type === 'password' ? 'Show' : 'Hide'; } } }, 'Show')
      : null;
    return el('div', { class: 'menu-row' }, el('span', { class: 'menu-key' }, name), input, show, copyBtn);
  };
  box.replaceChildren(
    el('p', { class: 'menu-note' }, 'Everything Turnout does happens in Flagsmith. Sign in to see the same flag, experiment and results there.'),
    el('a', { class: 'menu-open', href: signin.dashboardUrl, target: '_blank', rel: 'noopener' }, `Open Flagsmith ↗`),
    signin.email ? row('Email', signin.email) : null,
    signin.password ? row('Password', signin.password, true) : el('p', { class: 'menu-note' }, signin.email ? 'The password is shown only on the machine running Turnout.' : 'Sign in with your own Flagsmith account.'),
    el('p', { class: 'menu-note' }, 'Then: Experimentation → the running experiment, or Features → the release flag.'),
  );
}

/** Wires the menu: marks the current page, fills the drop-downs when opened, closes them on a click outside. */
export function setupMenu(current) {
  const menu = document.getElementById('menu');
  if (!menu) return;
  for (const a of menu.querySelectorAll('a[data-page]')) if (a.dataset.page === current) a.setAttribute('aria-current', 'page');
  if (READONLY) for (const node of document.querySelectorAll('[data-private]')) node.remove(); // the console, setup, Flagsmith: private
  if (NO_JUDGE) for (const a of document.querySelectorAll('a[href="/judge"]')) a.remove();
  document.getElementById('menu-versions')?.addEventListener('toggle', (e) => e.currentTarget.open && loadVersions());
  document.getElementById('menu-flagsmith')?.addEventListener('toggle', (e) => e.currentTarget.open && loadSignin());
  document.addEventListener('click', (e) => {
    for (const d of document.querySelectorAll('details.menu-drop[open], details.history[open]')) if (!d.contains(/** @type {Node} */ (e.target))) d.open = false;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') for (const d of document.querySelectorAll('details.menu-drop[open]')) d.open = false;
  });
}
