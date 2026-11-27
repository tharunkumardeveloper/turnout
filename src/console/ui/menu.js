// The menu the console and guided demo share: the views, every version of the site on its own (never counted), and
// a link to Flagsmith itself (its login is on the pages: signinBox). Server mode's public page keeps only what the public may see: judge
// mode and the versions; no console, no setup check, no Flagsmith link or login. Every string goes in through
// textContent.
//
// Markup (in each page): <nav class="menu" id="menu">…<details id="menu-versions">…<details id="menu-flagsmith">…

const meta = (name) => (typeof document === 'undefined' ? null : document.querySelector(`meta[name="${name}"]`));
const TOKEN = meta('turnout-console')?.getAttribute('content') ?? '';
export const BASE = meta('turnout-base')?.getAttribute('content') ?? '';
export const READONLY = meta('turnout-readonly') !== null;
/** The public page lets visitors run the guided demo's own steps (simulated shoppers only); everything else stays read-only. */
export const PLAY = READONLY && meta('turnout-public-play') !== null;
// Guided demo drives the demo shop; a console for your own app (turnout compare) has none, so no links to it.
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
export function setVersions(shop, releases, names = null) {
  const key = JSON.stringify([shop, releases, names]);
  if (versions.key === key) return;
  versions = { key, shop, releases: [...(releases ?? [])] };
  const box = document.getElementById('versions-list');
  if (!box) return;
  box.replaceChildren(
    el('p', { class: 'menu-note' }, 'Each version on its own, in a new tab. Looking never counts as a visit.'),
    el('ul', { class: 'menu-list' }, ...versions.releases.map((r, i) =>
      el('li', {},
        el('span', { class: 'menu-letter', 'data-i': String(i) }, LETTERS[i] ?? '?'),
        el('a', { href: viewLink(shop, r), target: '_blank', rel: 'noopener' }, names?.[r] ?? label(r), el('span', { class: 'menu-sub' }, i === 0 ? ' · what everyone gets first' : ''))))),
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

let signinRead = null;
/** Flagsmith's dashboard and login (GET /api/flagsmith-login), read once per page. */
export function loadSignin() {
  signinRead ??= api('/api/flagsmith-login')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  return signinRead;
}

/**
 * The sign-in box: Flagsmith's address and its login, each with Copy (the password with Show). The password is only
 * there on the machine running Turnout; another device gets the email alone.
 */
export function signinBox(signin, { compact = false } = {}) {
  if (!signin?.dashboardUrl) return el('p', { class: 'menu-note' }, "Flagsmith's address isn't known to this console.");
  const row = (name, value, secret = false) => {
    const input = el('input', { class: 'menu-secret', type: secret ? 'password' : 'text', readonly: true, value: value ?? '', 'aria-label': `Flagsmith ${name.toLowerCase()}`, spellcheck: 'false' });
    const copyBtn = el('button', { class: 'menu-btn', type: 'button', on: { click: (e) => copy(value ?? '', e.currentTarget) } }, 'Copy');
    const show = secret
      ? el('button', { class: 'menu-btn', type: 'button', on: { click: (e) => { input.type = input.type === 'password' ? 'text' : 'password'; e.currentTarget.textContent = input.type === 'password' ? 'Show' : 'Hide'; } } }, 'Show')
      : el('span');
    return el('div', { class: 'menu-row' }, el('span', { class: 'menu-key' }, name), input, show, copyBtn);
  };
  return el('div', { class: `signin${compact ? ' signin-compact' : ''}` },
    el('a', { class: 'signin-open', href: signin.dashboardUrl, target: '_blank', rel: 'noopener' }, 'Open Flagsmith ↗'),
    signin.email ? row('Email', signin.email) : null,
    signin.password ? row('Password', signin.password, true) : el('p', { class: 'menu-note' }, signin.email ? 'The password is shown only on the machine running Turnout.' : 'Sign in with your own Flagsmith account.'));
}

// The menu's Flagsmith entry opens Flagsmith itself (a new tab); the login lives on the pages, in signinBox().
async function wireFlagsmithLink() {
  const link = document.getElementById('menu-flagsmith');
  if (!link) return;
  const signin = await loadSignin();
  if (signin?.dashboardUrl) {
    link.setAttribute('href', signin.dashboardUrl);
    link.title = signin.email ? `Flagsmith's dashboard. Sign in as ${signin.email} (the login is on this page).` : "Flagsmith's dashboard";
  } else link.remove();
}

// ---- Server mode's public page: "About this demo" ----------------------------------------------------------------
// What the shared live demo has, and what runs only on your own machine (and why). The public page (never in a
// frame: the console embeds the guided demo) shows a one-line bar at the bottom until it's closed, so the demo itself is the
// first thing anyone sees; the banner and the menu's "About this demo" open the full notice. Local pages never show it.
export const NOTICE_KEY = 'turnout-live-notice-seen';
const REPO = 'https://github.com/tharunkumardeveloper/turnout';
const RAW = 'https://raw.githubusercontent.com/tharunkumardeveloper/turnout/main';
/** The one-line installs (the README's Quick start). */
export const INSTALL = { win: `irm ${RAW}/install.ps1 | iex`, unix: `curl -fsSL ${RAW}/install.sh | sh` };
let noticeDone = Promise.resolve();
/** Resolves once the live-demo notice is closed (at once when it isn't showing): tours wait for it. */
export const noticeClosed = () => noticeDone;

/** The notice's content: what's on this server, what's only on your machine and why, and how to run it. */
export function liveNotice({ play = PLAY } = {}) {
  const item = (title, text) => el('li', {}, el('b', {}, title), ` ${text}`);
  const dialog = el('dialog', { class: 'live-notice', id: 'live-notice', 'aria-labelledby': 'live-notice-title' });
  dialog.append(el('div', { class: 'live-inner' },
    el('p', { class: 'live-eyebrow' }, 'Public live demo'),
    el('h2', { id: 'live-notice-title', tabindex: '-1', autofocus: true }, 'You’re on a shared demo server'), // focus starts at the top, not on the commands
    el('p', { class: 'live-intro' }, 'One small server (2 vCPUs) running self-hosted Flagsmith 2.291.0 and Turnout in server mode, so you can see the whole loop without installing anything. Everyone who opens this page shares it.'),
    el('div', { class: 'live-cols' },
      el('section', {},
        el('h3', {}, 'On this server'),
        el('ul', {},
          item('A demo shop', 'with three versions (1.4 Classic, 1.5 Express, 1.6 Bold) behind one Flagsmith flag.'),
          play
            ? item('The guided demo:', 'run an A/A, A/B or A/B/C test with simulated shoppers, ask Flagsmith, then ship or revert.')
            : item('The guided demo,', 'run by an autopilot: tests, Flagsmith’s results and the decision.'),
          item('Blind rounds:', 'when nobody is clicking, an autopilot runs tests with hidden rates and scores Flagsmith’s calls.'),
          item('Be a visitor:', 'the shop gives you a version the way a real visitor gets one, counted in its own live experiment.'),
          item('A read-only console:', 'the live traffic map and Flagsmith’s numbers.'))),
      el('section', {},
        el('h3', {}, 'Only on your machine, and why'),
        el('ul', {},
          item('Try it with your app', '(GitHub links, folders, images): it builds and runs code, and a shared public server never runs strangers’ code.'),
          item('Your own site', 'with turnout compare: your versions, your Flagsmith project, your experiment.'),
          item('Flagsmith’s dashboard', 'and Turnout’s tour inside it: its admin login can’t be public, so here it stays private (SSH only).'),
          item('The full console:', 'setup check, Ship and Revert on your own test, Preview for your team, Pin my browser, the Feature Health guard.'),
          item('Numbers that are yours:', 'here tests are shared and rate-limited, and the one running may be someone else’s.')))),
    el('div', { class: 'live-run' },
      el('h3', {}, 'Run it locally'),
      el('p', {}, 'Docker running (about 4 GB of memory for it), then one line installs it:'),
      el('pre', {}, el('code', {}, `${INSTALL.win}   # Windows (PowerShell)\n${INSTALL.unix}   # macOS, Linux\nturnout demo                                    # this demo, every feature on\nturnout compare localhost:3001 localhost:3002   # or your own two versions`))),
    el('p', { class: 'live-feedback' }, 'Tried it on your own site? ',
      el('a', { href: `${REPO}/issues/new?template=tried-turnout.yml`, target: '_blank', rel: 'noopener' }, 'Tell us how it went ↗'), ' Two minutes, and it shapes what comes next.'),
    el('div', { class: 'live-actions' },
      el('a', { class: 'live-btn', href: `${REPO}#quick-start`, target: '_blank', rel: 'noopener' }, 'Setup steps on GitHub ↗'),
      el('button', { class: 'live-btn live-primary', type: 'button', on: { click: () => dialog.close() } }, 'Explore the live demo'))));
  return dialog;
}

function setupLiveNotice(menu) {
  if (!READONLY || typeof window === 'undefined' || window.top !== window.self) return;
  const dialog = liveNotice();
  document.body.append(dialog);
  dialog.addEventListener('click', (e) => e.target === dialog && dialog.close()); // a click on the backdrop
  menu.append(el('button', { class: 'menu-about', type: 'button', on: { click: () => dialog.showModal() } }, 'About this demo'));
  let seen = false;
  try {
    seen = localStorage.getItem(NOTICE_KEY) === '1';
  } catch {
    seen = false;
  }
  if (seen) return;
  // A banner, not a dialog: nothing covers the demo. Closing it (or opening the notice from it) keeps it closed.
  const remember = () => {
    try {
      localStorage.setItem(NOTICE_KEY, '1');
    } catch {
      /* it shows again next time */
    }
  };
  const banner = el('div', { class: 'live-banner', role: 'region', 'aria-label': 'About this live demo' },
    el('span', { class: 'live-banner-text' },
      el('b', {}, 'Shared live demo:'), ' self-hosted Flagsmith 2.291.0 and Turnout on one small server. Shoppers here are simulated and labelled; ',
      el('b', {}, 'Be a visitor'), ' gets you a version for real.'),
    el('button', { class: 'live-banner-link', type: 'button', on: { click: () => { remember(); dialog.showModal(); } } }, 'What’s here, and what runs only on your machine'),
    el('button', { class: 'live-banner-close', type: 'button', 'aria-label': 'Close this note', on: { click: () => { remember(); banner.remove(); } } }, '×'));
  document.body.append(banner);
}

/** Wires the menu: marks the current page, fills the drop-downs when opened, closes them on a click outside. */
export function setupMenu(current) {
  const menu = document.getElementById('menu');
  if (!menu) return;
  for (const a of menu.querySelectorAll('a[data-page]')) if (a.dataset.page === current) a.setAttribute('aria-current', 'page');
  // The public page keeps guided demo, the read-only console, the feature map and the versions; setup and Flagsmith's
  // dashboard stay private.
  if (READONLY) {
    const consoleLink = menu.querySelector('a[data-page="console"]');
    if (consoleLink) {
      consoleLink.setAttribute('href', `${BASE}/console`);
      consoleLink.removeAttribute('data-private');
    }
    // The Flagsmith feature map is public too, read-only and without links into Flagsmith's private dashboard.
    const mapLink = menu.querySelector('a[data-page="flagsmith"]');
    if (mapLink) {
      mapLink.setAttribute('href', `${BASE}/flagsmith`);
      mapLink.textContent = 'Flagsmith features';
      mapLink.removeAttribute('data-private');
    }
    for (const brand of document.querySelectorAll('a.brand')) brand.setAttribute('href', BASE || '/');
    for (const node of document.querySelectorAll('[data-private]')) node.remove();
    setupLiveNotice(menu);
  }
  if (NO_JUDGE) for (const a of document.querySelectorAll('a[href="/judge"]')) a.remove();
  document.getElementById('menu-versions')?.addEventListener('toggle', (e) => e.currentTarget.open && loadVersions());
  if (!READONLY) void wireFlagsmithLink();
  document.addEventListener('click', (e) => {
    for (const d of document.querySelectorAll('details.menu-drop[open], details.history[open]')) if (!d.contains(/** @type {Node} */ (e.target))) d.open = false;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') for (const d of document.querySelectorAll('details.menu-drop[open]')) d.open = false;
  });
}
