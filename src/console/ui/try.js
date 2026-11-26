// The console's "Try it with your app" box: one, two or three versions of your app (a Dockerfile, a public git repo
// or an image), built and run on this machine by the tryit service, then the same test page as judge mode at /try.
// One version makes an A/A test, two an A/B test, three an A/B/C test. Every string goes in through textContent.

import { SKIP, detect, dockerfilesIn, tarParts } from './try-model.js';

const TOKEN = document.querySelector('meta[name="turnout-console"]')?.getAttribute('content') ?? '';
const api = (path, init = {}) => fetch(path, { ...init, headers: { ...(init.headers ?? {}), 'x-turnout-console': TOKEN } });
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const LETTERS = ['A', 'B', 'C'];
const KIND = { 1: 'an A/A test: the same app on both sides, a check that the split is fair', 2: 'an A/B test', 3: 'an A/B/C test' };

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k.startsWith('data-') || k.startsWith('aria-') || ['for', 'role', 'placeholder', 'type', 'name', 'id', 'min', 'max', 'step', 'accept', 'rows', 'spellcheck', 'title', 'href', 'target', 'rel', 'src', 'tabindex'].includes(k)) node.setAttribute(k, v === true ? '' : String(v));
    else node[k] = v;
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}

// Two self-contained Dockerfiles (no other files needed), so anyone can see it work without an app of their own: the
// same product ("Ledgerly", made up) as two complete landing pages, each with a pricing page (the example's goal) and
// an about page. A is the classic design; B the bold one, with one clear call to action.
function examplePage(v) {
  const css = `*{box-sizing:border-box}body{margin:0;font-family:${v.font};color:#18202f;background:${v.bg}}a{color:inherit}`
    + `.nav{display:flex;align-items:center;justify-content:space-between;padding:18px 48px;background:${v.nav};color:${v.navText}}`
    + `.nav b{font-size:20px;letter-spacing:.02em}.nav span a{margin-left:22px;text-decoration:none;opacity:.9}`
    + `.hero{padding:72px 48px 56px;max-width:1040px;margin:auto;text-align:${v.align}}.hero small{font-weight:700;letter-spacing:.12em;color:${v.accent}}`
    + `.hero h1{font-size:${v.h1};line-height:1.1;margin:12px 0}.hero p{font-size:19px;color:#4b5565;max-width:640px;${v.align === 'center' ? 'margin:0 auto 26px' : 'margin:0 0 26px'}}`
    + `.cta{display:inline-block;padding:${v.ctaPad};border-radius:${v.radius};background:${v.accent};color:#fff;font-weight:700;text-decoration:none;font-size:${v.ctaSize}}`
    + `.ghost{margin-left:12px;color:${v.accent};font-weight:600}`
    + `.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;max-width:1040px;margin:0 auto;padding:0 48px 48px}`
    + `.card{background:#fff;border-radius:${v.cardRadius};padding:22px;box-shadow:0 8px 24px -12px rgba(15,23,42,.25);border-top:4px solid ${v.accent}}.card h3{margin:0 0 6px}.card p{margin:0;color:#4b5565}`
    + `.quote{max-width:760px;margin:0 auto 56px;padding:0 48px;font-size:20px;font-style:italic;color:#334155;text-align:center}`
    + `.foot{padding:26px 48px;background:${v.nav};color:${v.navText};font-size:14px}`;
  const nav = `<div class="nav"><b>${v.brand}</b><span><a href="/pricing.html">Pricing</a><a href="/about.html">About</a><a href="/pricing.html">Start free</a></span></div>`;
  const page = (title, body) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${css}</style>${nav}${body}<div class="foot">${v.brand} &middot; version ${v.letter} &middot; served through Turnout</div></html>`;
  const index = page(`${v.brand}: ${v.headline}`, `<div class="hero"><small>${v.kicker}</small><h1>${v.headline}</h1><p>${v.pitch}</p><a class="cta" href="/pricing.html">${v.cta}</a>${v.ghost ? `<a class="ghost" href="/about.html">${v.ghost}</a>` : ''}</div>`
    + `<div class="cards">${v.cards.map(([h, p]) => `<div class="card"><h3>${h}</h3><p>${p}</p></div>`).join('')}</div><p class="quote">&ldquo;${v.quote}&rdquo;</p>`);
  const pricing = page(`${v.brand} pricing`, `<div class="hero"><small>PRICING</small><h1>Simple plans</h1><p>Free for one person. Team: 9 a month per seat. Cancel any time.</p><a class="cta" href="/">Back home</a></div>`);
  const about = page(`About ${v.brand}`, `<div class="hero"><small>ABOUT</small><h1>Made for small teams</h1><p>Invoices, expenses and payroll in one tidy place.</p><a class="cta" href="/pricing.html">See pricing</a></div>`);
  const write = (file, html) => `printf '%s' '${html}' > /usr/share/nginx/html/${file}`;
  return `# Example version ${v.letter}: ${v.name}. Self-contained: the pages are written here, no other files needed.\nFROM nginx:alpine\nRUN ${write('index.html', index)} \\\n && ${write('pricing.html', pricing)} \\\n && ${write('about.html', about)}`;
}

const EXAMPLE = [
  examplePage({
    letter: 'A', name: 'the classic page', brand: 'Ledgerly', font: 'Georgia,serif', bg: '#f5f7fb', nav: '#1e3a8a', navText: '#fff', accent: '#1d4ed8',
    align: 'left', h1: '44px', radius: '6px', cardRadius: '6px', ctaPad: '12px 22px', ctaSize: '16px', kicker: 'BOOKKEEPING FOR SMALL TEAMS',
    headline: 'Accounting software that keeps your books tidy', pitch: 'Ledgerly tracks invoices, expenses and payroll, reconciles your bank every night, and prepares your quarterly reports so you can focus on the work you love.',
    cta: 'Start a free trial', ghost: 'Read how it works', quote: 'We closed our books in a day instead of a week.',
    cards: [['Invoices', 'Send branded invoices and get paid online.'], ['Expenses', 'Snap a receipt; Ledgerly files it.'], ['Reports', 'Quarterly reports, ready for your accountant.']],
  }),
  examplePage({
    letter: 'B', name: 'the bold page', brand: 'Ledgerly', font: 'system-ui,sans-serif', bg: '#effaf3', nav: '#14532d', navText: '#ecfdf3', accent: '#16a34a',
    align: 'center', h1: '56px', radius: '999px', cardRadius: '18px', ctaPad: '16px 34px', ctaSize: '19px', kicker: 'FREE FOR ONE PERSON',
    headline: 'Your books, done.', pitch: 'Invoices, expenses and payroll in one place. Set up in two minutes.',
    cta: 'Get started free', ghost: '', quote: 'Two minutes to set up. I never looked back.',
    cards: [['2-minute setup', 'Connect your bank and you are done.'], ['Paid faster', 'Online payments on every invoice.'], ['No surprises', 'One price. Cancel any time.']],
  }),
];

// Each version is one box: paste anything (a Dockerfile, a git URL, an image name) and Turnout works out which, or
// choose your project folder (it is sent with its Dockerfile, so COPY works) or a file (a Dockerfile, or an image
// saved with docker save). Nobody has to know which kind they have.
const rows = LETTERS.map(() => ({ text: '', folder: null, file: null, port: '', rate: '10' }));
let polling = 0;
let justBuilt = false; // a build started from this box: open /try when it is ready
let offline = false; // the tryit service isn't running (or this is the public server)
let ready = ''; // the line once a build is ready (kept until the versions change)
const mb = (n) => (n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function pickFolder(r, files) {
  const list = [...files];
  if (!list.length) return;
  const root = list[0].webkitRelativePath.split('/')[0];
  const kept = list.map((f) => ({ f, path: f.webkitRelativePath.slice(root.length + 1) })).filter((x) => x.path && !SKIP.test(x.path));
  const dockerfiles = dockerfilesIn(kept.map((x) => x.path));
  const size = kept.reduce((a, x) => a + x.f.size, 0);
  const shared = { name: root, files: kept, dockerfiles, size, skipped: list.length - kept.length, upload: null };
  r.folder = { shared, dockerfile: dockerfiles[0] ?? null };
  r.file = null;
  r.text = '';
  ready = '';
  // A folder with several Dockerfiles (indicraft: Dockerfile and Dockerfile.teal) fills the next empty versions too.
  for (const extra of dockerfiles.slice(1)) {
    const next = rows.find((x) => x !== r && !x.text.trim() && !x.folder && !x.file);
    if (!next) break;
    next.folder = { shared, dockerfile: extra };
  }
  render();
}
async function pickFile(r, file) {
  if (!file) return;
  ready = '';
  if (/\.(tar|tar\.gz|tgz)$/i.test(file.name) || file.size > 1024 ** 2) {
    r.file = { name: file.name, blob: file, upload: null };
    r.folder = null;
    r.text = '';
  } else {
    r.text = await file.text();
    r.file = null;
  }
  render();
}

function sourceLine(r) {
  if (r.folder) {
    const f = r.folder.shared;
    if (!r.folder.dockerfile) return h('p', { class: 'try-detect bad' }, `Your folder ${f.name} has no Dockerfile at its top level. Turnout runs any app that has one: add a Dockerfile to the folder and choose it again.`);
    return h('p', { class: 'try-detect' }, `✓ Your folder ${f.name} (${f.files.length} files, ${mb(f.size)}${f.skipped ? `; ${f.skipped} files in node_modules, .git and the like are left out, the build makes them` : ''}), built with `,
      f.dockerfiles.length > 1
        ? h('select', { class: 'try-select', 'aria-label': 'Which Dockerfile', on: { change: (e) => ((r.folder.dockerfile = e.target.value), (ready = '')) } }, ...f.dockerfiles.map((d) => h('option', { value: d, selected: d === r.folder.dockerfile }, d)))
        : h('code', {}, r.folder.dockerfile), '.');
  }
  if (r.file) return h('p', { class: 'try-detect' }, `✓ An image file: ${r.file.name} (${mb(r.file.blob.size)}). Turnout loads it into Docker and runs it.`);
  const d = detect(r.text);
  if (!d) return null;
  if (!d.kind) return h('p', { class: 'try-detect bad' }, `This is ${d.label}.`);
  if (d.copies) return h('p', { class: 'try-detect bad' }, 'This Dockerfile copies files from your project (COPY), so it needs its folder. Press Choose project folder and pick the folder it is in: Turnout sends the folder and its Dockerfile together.');
  return h('p', { class: 'try-detect' }, `✓ Looks like ${d.label}.`);
}

function rowView(r, i) {
  const clear = () => ((r.folder = null), (r.file = null), (r.text = ''), (ready = ''), render());
  const picked = r.folder || r.file;
  return h('div', { class: 'try-row', 'data-i': String(i) },
    h('span', { class: 'try-letter' }, LETTERS[i]),
    h('div', { class: 'try-main' },
      picked
        ? h('div', { class: 'try-picked' }, h('strong', {}, r.folder ? `📁 ${r.folder.shared.name}` : `📦 ${r.file.name}`), h('button', { type: 'button', class: 'btn btn-small btn-ghost', on: { click: clear } }, 'Change'))
        : h('textarea', { rows: 3, spellcheck: 'false', placeholder: i ? 'Optional: another version, the same way.' : 'Paste anything: a Dockerfile, a GitHub link or an image name (myapp:1.2). Or choose your project folder.', value: r.text, on: { input: (e) => ((r.text = e.target.value), (ready = ''), refreshLine(i)) } }),
      picked ? null : h('div', { class: 'try-pick' },
        h('label', { class: 'btn btn-small' }, '📁 Choose project folder', h('input', { type: 'file', class: 'try-hidden-input', webkitdirectory: true, on: { change: (e) => pickFolder(r, e.target.files ?? []) } })),
        h('label', { class: 'btn btn-small btn-ghost', title: 'A Dockerfile, or an image saved with: docker save -o app.tar myapp:1.2' }, 'Choose a file', h('input', { type: 'file', class: 'try-hidden-input', on: { change: (e) => pickFile(r, e.target.files?.[0]) } }))),
      h('div', { class: 'try-line' }, sourceLine(r))),
    h('details', { class: 'try-side' },
      h('summary', {}, 'More'),
      h('label', {}, 'App port', h('input', { class: 'try-num', type: 'number', min: 1, max: 65535, placeholder: 'auto', value: r.port, title: "The port your app listens on inside its container (not on your machine). Auto reads the Dockerfile's EXPOSE line, else 80.", on: { input: (e) => (r.port = e.target.value) } })),
      h('label', { title: 'Simulated visitors convert at this rate on this version (an input you choose, not evidence). Real page speed and errors are measured as they are.' }, 'Pretend %', h('input', { class: 'try-num', type: 'number', min: 0, max: 100, step: 1, value: r.rate, on: { input: (e) => (r.rate = e.target.value) } }))));
}
function refreshLine(i) {
  const line = document.querySelector(`.try-row[data-i="${i}"] .try-line`);
  line?.replaceChildren(...[sourceLine(rows[i])].filter(Boolean));
  kindLine();
}

/** A version that can be built: a folder with a Dockerfile, an image file, or text Turnout recognises (not a COPY Dockerfile). */
function usable(r) {
  if (r.folder) return Boolean(r.folder.dockerfile);
  if (r.file) return true;
  const d = detect(r.text);
  return Boolean(d?.kind) && !d.copies;
}
function filled() {
  return rows.filter((r) => r.folder || r.file || r.text.trim());
}
function kindLine() {
  const n = filled().length;
  const bad = filled().some((r) => !usable(r));
  $('try-kind').textContent = ready || (bad ? 'Fix the version marked in red first.' : n ? `${n} version${n > 1 ? 's' : ''}: ${KIND[n]}.` : 'Step 1: give version A.');
  /** @type {HTMLButtonElement} */ ($('try-build')).disabled = !n || bad || Boolean(polling) || offline;
}
function render() {
  $('try-versions').replaceChildren(...rows.map(rowView));
  kindLine();
}

// Uploads a chosen folder (as a tar, built here in the browser) or image file once; versions sharing a folder share it.
async function upload(target, makeBlob, say) {
  if (target.upload) return target.upload;
  say();
  const res = await api('/api/try/upload', { method: 'POST', headers: { 'content-type': 'application/x-tar' }, body: await makeBlob() });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `upload failed (HTTP ${res.status})`);
  target.upload = body.id;
  return body.id;
}
async function folderBlob(f) {
  const entries = [];
  for (const { f: file, path } of f.files) entries.push({ path, size: file.size, data: new Uint8Array(await file.arrayBuffer()) });
  return new Blob(tarParts(entries), { type: 'application/x-tar' });
}
async function versionFor(r, i) {
  const extra = Number(r.port) > 0 ? { port: Number(r.port) } : {};
  const say = (what) => () => ($('try-kind').textContent = `Sending ${what} to Turnout on this machine…`);
  if (r.folder) {
    const id = await upload(r.folder.shared, () => folderBlob(r.folder.shared), say(`your folder ${r.folder.shared.name} (${mb(r.folder.shared.size)})`));
    const name = r.folder.dockerfile === 'Dockerfile' ? r.folder.shared.name : `${r.folder.shared.name} (${r.folder.dockerfile})`;
    return { kind: 'folder', value: id, dockerfile: r.folder.dockerfile, name, ...extra };
  }
  if (r.file) {
    const id = await upload(r.file, async () => r.file.blob, say(`${r.file.name} (${mb(r.file.blob.size)})`));
    return { kind: 'imagefile', value: id, name: r.file.name.replace(/\.(tar|tar\.gz|tgz)$/i, ''), ...extra };
  }
  const d = detect(r.text);
  return { kind: d.kind, value: d.value, ...extra };
}

function stageList(v) {
  return h('li', {}, h('strong', {}, `${v.slot.toUpperCase()} · ${v.name}`),
    ...v.stages.map((s) => h('span', { class: 'try-stage', 'data-status': s.status }, ` ${s.status === 'done' ? '✓' : s.status === 'running' ? '…' : s.status === 'failed' ? '✗' : '·'} ${s.title}${s.detail ? ` (${s.detail})` : ''}`)));
}

function previews(state) {
  const shop = String(state.shop ?? '').replace(/\/$/, '');
  const list = state.versions.length === 1 ? [state.versions[0], { ...state.versions[0], slot: 'a′', label: 'try:b', name: `${state.versions[0].name} (copy)` }] : state.versions;
  return list.map((v, i) => h('a', { class: 'try-tile', href: `${shop}/?__turnout_view=${encodeURIComponent(v.label)}`, target: '_blank', rel: 'noopener', 'data-i': String(i), title: `Open ${v.name} on its own (never counted)` },
    h('span', { class: 'try-tile-name' }, `${i === 1 && state.versions.length === 1 ? 'A′' : LETTERS[i]} · ${v.name}`),
    h('span', { class: 'try-frame' }, h('iframe', { src: `${shop}/?__turnout_view=${encodeURIComponent(v.label)}`, title: `Preview of ${v.name}`, tabindex: '-1' }))));
}

async function poll() {
  try {
    const res = await api('/api/try/status', { cache: 'no-store' });
    const st = await res.json().catch(() => ({}));
    // Opt-in: the service runs only once started (sh turnout.sh tryit / turnout.bat tryit).
    offline = res.status === 502;
    const off = $('try-off');
    off.hidden = !offline;
    if (offline) {
      off.textContent = 'Try it is not running. On your machine, run  turnout.bat  (Windows) or  sh turnout.sh  (macOS, Linux): it starts Try it with everything else. A public server never runs it: it builds and runs code over the Docker socket.';
      polling = 0;
      return kindLine();
    }
    if (!res.ok) throw new Error(st.error ?? `HTTP ${res.status}`);
    const last = st.status === 'building' ? (st.log ?? []).filter((l) => !l.startsWith('  ')).at(-1) : null;
    $('try-progress').replaceChildren(...(st.versions ?? []).map(stageList), ...(last ? [h('li', { class: 'try-now' }, last)] : []));
    const err = $('try-error');
    err.hidden = st.status !== 'failed';
    err.textContent = st.status === 'failed' ? `Stopped: ${st.error}` : '';
    if (st.status === 'ready') {
      const fresh = !$('try-previews').childElementCount;
      $('try-previews').replaceChildren(...previews(st));
      $('try-open-page').hidden = false;
      ready = `Ready: the ${st.kind} test is running in Flagsmith. Open the test page: Play it for me runs it (simulated visitors, then Flagsmith's results), as in judge mode.`;
      if (fresh) $('try-previews').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      // A build you just started: once it is ready, go straight to its test page.
      if (justBuilt) {
        justBuilt = false;
        ready = 'Ready. Opening the test page…';
        setTimeout(() => location.assign('/try'), 1200);
      }
    } else ready = '';
    if (st.status === 'building') polling = setTimeout(poll, 1500);
    else polling = 0;
  } catch (error) {
    polling = 0;
    const err = $('try-error');
    err.hidden = false;
    err.textContent = error.message;
  }
  kindLine();
}

async function build() {
  let versions;
  try {
    versions = [];
    for (const [i, r] of filled().entries()) versions.push(await versionFor(r, i));
  } catch (error) {
    $('try-error').hidden = false;
    $('try-error').textContent = error.message;
    return kindLine();
  }
  const rates = filled().map((r) => Math.min(100, Math.max(0, Number(r.rate) || 0)) / 100);
  $('try-error').hidden = true;
  $('try-previews').replaceChildren();
  $('try-open-page').hidden = true;
  const res = await api('/api/try/build', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ versions, goal: /** @type {HTMLInputElement} */ ($('try-goal')).value, rates, env: /** @type {HTMLTextAreaElement} */ ($('try-env')).value }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    $('try-error').hidden = false;
    $('try-error').textContent = body.error ?? `HTTP ${res.status}`;
    return;
  }
  polling = 1;
  justBuilt = true;
  kindLine();
  void poll();
}

// The console's Run a test card follows your Try it build: what it holds (A/A, A/B, A/B/C of your versions) and one
// button that opens its test page and plays the whole test there.
function renderRunTry(st) {
  const box = document.getElementById('run-try');
  if (!box) return;
  box.hidden = st?.status !== 'ready';
  if (box.hidden) return;
  const names = (st.versions ?? []).map((v, i) => `${LETTERS[i]} · ${v.name}`);
  const key = JSON.stringify([st.kind, names]);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(
    h('p', { class: 'run-try-line' }, h('strong', {}, 'Your app (Try it): '), `an ${st.kind} test of ${names.length === 1 ? `${names[0]}, twice` : names.join(st.kind === 'A/B' ? ' against ' : ', ')}.`),
    h('a', { class: 'btn btn-primary run-try-go', href: '/try?play=1', target: '_blank', rel: 'noopener', title: 'Opens its test page and plays the whole test: start, simulated visitors, the results from Flagsmith, the decision' }, `▶ Run your app's ${st.kind} test`));
}
async function watchTry() {
  try {
    const res = await api('/api/try/status', { cache: 'no-store' });
    renderRunTry(res.ok ? await res.json() : null);
  } catch {
    renderRunTry(null);
  }
  setTimeout(watchTry, 8000);
}

export async function setupTry() {
  const open = document.getElementById('try-open');
  if (!open) return;
  // Off on this console (server mode, or no tryit service): no button.
  const probe = await api('/api/try/status', { cache: 'no-store' }).catch(() => null);
  if (!probe || probe.status === 404 || probe.status === 403) return open.remove();
  open.hidden = false;
  void watchTry();
  open.addEventListener('click', () => {
    /** @type {HTMLDialogElement} */ ($('try-dialog')).showModal();
    render();
    void poll();
  });
  $('try-build').addEventListener('click', async () => {
    await poll(); // started since the box opened?
    if (offline) return;
    ready = '';
    void build();
  });
  $('try-example').addEventListener('click', () => {
    for (const r of rows) Object.assign(r, { folder: null, file: null, text: '' });
    rows[0].text = EXAMPLE[0];
    rows[1].text = EXAMPLE[1];
    rows[0].rate = '10';
    rows[1].rate = '18';
    /** @type {HTMLInputElement} */ ($('try-goal')).value = 'GET /pricing.html';
    render();
  });
}
