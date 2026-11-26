// The console's "Try it with your app" box: one, two or three versions of your app (a Dockerfile, a public git repo
// or an image), built and run on this machine by the tryit service, then the same test page as judge mode at /try.
// One version makes an A/A test, two an A/B test, three an A/B/C test. Every string goes in through textContent.

import { SKIP, detect, dockerfilesIn, goalsFrom, goalsFromHtml, tarParts } from './try-model.js';

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

let showC = false; // the third version's card: shown once asked for (or filled)
const ROLE = ['what everyone gets today', 'the change you want to test', 'another change'];
function rowView(r, i) {
  if (i === 2 && !showC && !(r.text.trim() || r.folder || r.file)) {
    return h('button', { type: 'button', class: 'try-row try-add', 'data-i': '2', on: { click: () => ((showC = true), render(), document.querySelector('.try-row[data-i="2"] textarea')?.focus()) } },
      h('span', { class: 'try-add-plus' }, '+'), h('strong', {}, 'Add version C'), h('span', {}, 'for an A/B/C test'));
  }
  const clear = () => ((r.folder = null), (r.file = null), (r.text = ''), (ready = ''), render());
  const picked = r.folder || r.file;
  const state = !(r.text.trim() || picked) ? 'empty' : usable(r) ? 'ok' : 'bad';
  return h('div', { class: 'try-row', 'data-i': String(i), 'data-state': state },
    h('div', { class: 'try-row-head' },
      h('span', { class: 'try-letter' }, LETTERS[i]),
      h('span', { class: 'try-row-title' }, h('strong', {}, `Version ${LETTERS[i]}`), h('small', {}, ROLE[i])),
      h('span', { class: 'try-row-state', 'aria-hidden': 'true' }, state === 'ok' ? '✓' : state === 'bad' ? '!' : '')),
    picked
      ? h('div', { class: 'try-picked' },
          h('span', { class: 'try-picked-icon' }, r.folder ? '▤' : '▣'),
          h('strong', {}, r.folder ? r.folder.shared.name : r.file.name),
          h('button', { type: 'button', class: 'btn btn-small btn-ghost', on: { click: clear } }, 'Change'))
      : h('textarea', { spellcheck: 'false', placeholder: i ? 'Paste a Dockerfile, a GitHub link or an image name…' : 'Paste a Dockerfile, a GitHub link or an image name (myapp:1.2)…', value: r.text, on: { input: (e) => ((r.text = e.target.value), (ready = ''), refreshLine(i)) } }),
    picked ? null : h('div', { class: 'try-pick' },
      h('label', { class: 'btn btn-small' }, 'Project folder', h('input', { type: 'file', class: 'try-hidden-input', webkitdirectory: true, on: { change: (e) => pickFolder(r, e.target.files ?? []) } })),
      h('label', { class: 'btn btn-small btn-ghost', title: 'A Dockerfile, or an image saved with: docker save -o app.tar myapp:1.2' }, 'A file', h('input', { type: 'file', class: 'try-hidden-input', on: { change: (e) => pickFile(r, e.target.files?.[0]) } }))),
    h('div', { class: 'try-line' }, sourceLine(r)),
    h('details', { class: 'try-side' },
      h('summary', {}, 'Advanced'),
      h('div', { class: 'try-side-grid' },
        h('label', {}, 'App port', h('input', { class: 'try-num', type: 'number', min: 1, max: 65535, placeholder: 'auto', value: r.port, title: "The port your app listens on inside its container (not on your machine). Auto reads the Dockerfile's EXPOSE line, else 80.", on: { input: (e) => (r.port = e.target.value) } })),
        h('label', { title: 'Simulated visitors convert at this rate on this version (an input you choose, not evidence). Real page speed and errors are measured as they are.' }, 'Pretend %', h('input', { class: 'try-num', type: 'number', min: 0, max: 100, step: 1, value: r.rate, on: { input: (e) => (r.rate = e.target.value) } })))));
}
function refreshLine(i) {
  const row = document.querySelector(`.try-row[data-i="${i}"]`);
  const r = rows[i];
  if (row) {
    row.querySelector('.try-line')?.replaceChildren(...[sourceLine(r)].filter(Boolean));
    const state = !(r.text.trim() || r.folder || r.file) ? 'empty' : usable(r) ? 'ok' : 'bad';
    row.dataset.state = state;
    const mark = row.querySelector('.try-row-state');
    if (mark) mark.textContent = state === 'ok' ? '✓' : state === 'bad' ? '!' : '';
  }
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
  const left = ready && step !== 3 ? "Your last test is still running: Open your app's console to see it." : ready;
  $('try-kind').textContent = left || (bad ? 'Fix the version marked in red first.' : n ? `${n} version${n > 1 ? 's' : ''}: ${KIND[n]}.` : 'Give version A to start.');
  /** @type {HTMLButtonElement} */ ($('try-build')).disabled = !n || bad || Boolean(polling) || offline;
  /** @type {HTMLButtonElement} */ ($('try-next')).disabled = !n || bad;
  renderPlan();
}

// Three steps, one on screen at a time: Versions, Options, Build. The box never scrolls; the log scrolls inside.
let step = 1;
let built = false; // a build exists (running, ready or failed): step 3 can be opened
function go(n) {
  step = n;
  const d = $('try-dialog');
  d.dataset.step = String(n);
  for (const li of d.querySelectorAll('.try-stepper li')) {
    const k = Number(li.dataset.n);
    li.dataset.state = k < n ? 'done' : k === n ? 'active' : 'todo';
    /** @type {HTMLButtonElement} */ (li.querySelector('button')).disabled = k === 3 && !built && n !== 3;
  }
  $('try-back').hidden = n === 1;
  $('try-next').hidden = n !== 1;
  $('try-example').hidden = n !== 1;
  // One highlighted button per step: Next on step 1 (Build waits for step 2), Build on step 2.
  $('try-build').hidden = n === 1 || (n === 3 && $('try-error').hidden); // step 3: only to try again after a failure
  $('try-next').classList.toggle('btn-primary', n === 1);
  if (n === 2) void suggestGoals();
  $('try-build').textContent = n === 3 ? '↻ Build again' : 'Build and try';
  kindLine();
}

// Goals from the site itself: its pages, read from the folder you chose or the GitHub repository's file list (the
// tryit service asks GitHub; nothing is sent anywhere else). Images and lone Dockerfiles have no pages to read.
const COMMON_GOALS = ['GET /contact*', 'GET /pricing*', 'POST /signup', 'POST /checkout'];
const goalView = { key: '', chips: [] };
function renderChips(goals, fromSite) {
  const pick = (g) => () => ((/** @type {HTMLInputElement} */ ($('try-goal')).value = g), renderPlan());
  // A site with nothing a visitor does that reaches the server: say so, and leave the goal empty (page speed).
  if (fromSite && !goals.length) {
    return void $('try-goal-chips').replaceChildren(h('span', { class: 'try-chips-label' },
      "Your site has no form or page a visitor's action reaches (email links and forms that only run in the browser can't be counted): leave the goal empty to compare page speed."));
  }
  const list = goals.length ? goals : COMMON_GOALS;
  $('try-goal-chips').replaceChildren(
    h('span', { class: 'try-chips-label' }, fromSite ? 'From your site:' : 'Examples:'),
    ...list.map((g) => h('button', { type: 'button', class: 'try-chip', title: `Count ${g} as a win`, on: { click: pick(g) } }, g)));
}
async function suggestGoals() {
  const versions = filled();
  const key = JSON.stringify(versions.map((r) => r.folder?.shared.name ?? r.file?.name ?? r.text.trim()));
  if (key === goalView.key) return renderChips(goalView.chips, goalView.readable);
  goalView.key = key;
  $('try-goal-chips').replaceChildren(h('span', { class: 'try-chips-label' }, 'Reading your site for goals…'));
  const all = [];
  let readable = false;
  for (const r of versions) {
    let paths = [];
    let html = '';
    if (r.folder) {
      paths = r.folder.shared.files.map((x) => x.path);
      const home = r.folder.shared.files.find((x) => /^(public\/|src\/)?index\.html$/i.test(x.path));
      html = home ? await home.f.text().catch(() => '') : '';
    } else {
      const d = detect(r.text);
      if (d?.kind === 'git') {
        const res = await api(`/api/try/repo-files?url=${encodeURIComponent(d.value)}`, { cache: 'no-store' }).catch(() => null);
        const body = res?.ok ? await res.json() : {};
        paths = body.files ?? [];
        html = body.html ?? '';
      } else continue; // an image or a lone Dockerfile: no pages to read
    }
    // What a visitor does on the home page (a form, a download) first, then the site's other pages.
    for (const g of [...goalsFromHtml(html), ...goalsFrom(paths, 6)]) if (!all.includes(g)) all.push(g);
    readable = true;
  }
  if (goalView.key !== key) return; // the versions changed while reading
  goalView.chips = all.slice(0, 8);
  goalView.readable = readable;
  renderChips(goalView.chips, readable);
}

function renderPlan() {
  const list = document.getElementById('try-plan');
  if (!list) return;
  const n = filled().length;
  const goal = /** @type {HTMLInputElement} */ ($('try-goal')).value.trim();
  const what = (r) => (r.folder ? `your folder ${r.folder.shared.name}` : r.file ? r.file.name : detect(r.text)?.label ?? '');
  list.replaceChildren(...(n
    ? [
        ...filled().map((r, i) => h('li', {}, h('span', { class: 'try-letter', 'data-i': String(i) }, LETTERS[i]), `Build ${what(r)}`)),
        h('li', {}, h('span', { class: 'try-plan-icon' }, '⇄'), n === 1 ? 'Run it twice and split visitors 50/50 (A/A)' : `Split visitors ${n === 2 ? '50/50' : 'three ways'} on the flag tryit_release`),
        h('li', {}, h('span', { class: 'try-plan-icon' }, '✓'), goal ? `Count ${goal} as a win; Flagsmith picks the winner` : 'Turnout picks the goal from your running versions (or compares page speed); Flagsmith picks the winner'),
      ]
    : [h('li', { class: 'try-plan-empty' }, 'Give a version in step 1 first.')]));
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

// ---- step 3: one card per version (its stages), the build log, and what stopped it ----------------------------
const STAGE_ICON = { done: '✓', running: '', failed: '✕', todo: '' };
function versionCard(v, i) {
  const failed = v.stages.some((s) => s.status === 'failed');
  const done = v.stages.every((s) => s.status === 'done');
  const running = v.stages.some((s) => s.status === 'running');
  const [word, tone] = failed ? ['Failed', 'bad'] : done ? ['Running', 'good'] : running ? ['Building', 'busy'] : ['Waiting', 'idle'];
  return h('li', { class: 'try-vcard', 'data-i': String(i), 'data-tone': tone },
    h('div', { class: 'try-vcard-head' },
      h('span', { class: 'try-letter' }, LETTERS[i]),
      h('strong', { class: 'try-vcard-name', title: v.name }, v.name),
      h('span', { class: 'try-pill', 'data-tone': tone }, word)),
    h('ol', { class: 'try-stages' },
      ...v.stages.map((s) => h('li', { class: 'try-stage', 'data-status': s.status },
        h('span', { class: 'try-stage-icon', 'aria-hidden': 'true' }, STAGE_ICON[s.status] ?? ''),
        h('span', { class: 'try-stage-text' }, s.title,
          s.detail ? h('span', { class: 'try-stage-detail', title: s.detail }, s.detail) : null)))));
}

// The log is appended to, never redrawn: what you selected or scrolled to stays put.
const logView = { first: '', count: 0 };
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
function renderLog(lines) {
  const box = $('try-log');
  const first = lines[0]?.at ?? '';
  if (first !== logView.first || lines.length < logView.count) {
    box.replaceChildren();
    logView.first = first;
    logView.count = 0;
  }
  const fresh = lines.slice(logView.count);
  if (!fresh.length) return;
  box.append(...fresh.map((l) => h('div', { class: 'try-log-row', 'data-level': l.level },
    h('time', { class: 'try-log-time' }, clock(l.at)),
    h('span', { class: 'try-log-from', 'data-from': l.from }, l.from),
    h('span', { class: 'try-log-text' }, l.text))));
  logView.count = lines.length;
  if (/** @type {HTMLInputElement} */ ($('try-log-follow')).checked) box.scrollTop = box.scrollHeight;
}
function logText() {
  return [...$('try-log').querySelectorAll('.try-log-row')].map((r) => [...r.children].map((c) => c.textContent).join('  ')).join('\n');
}

// The cards are redrawn only when a step changes (their entrance animation played every poll: the box blinked); the
// line under a running step (Docker's latest output) is updated in place.
const progressView = { key: '' };
function renderProgress(versions) {
  const box = $('try-progress');
  const key = JSON.stringify(versions.map((v) => [v.slot, v.name, v.stages.map((x) => x.status)]));
  if (key === progressView.key) {
    versions.forEach((v, i) => v.stages.forEach((x, k) => {
      const li = box.children[i]?.querySelectorAll('.try-stage')[k];
      const text = li?.querySelector('.try-stage-text');
      if (!text) return;
      let detail = text.querySelector('.try-stage-detail');
      if (!x.detail) return void detail?.remove();
      if (!detail) text.append((detail = h('span', { class: 'try-stage-detail' })));
      if (detail.textContent !== x.detail) {
        detail.textContent = x.detail;
        detail.title = x.detail;
      }
    }));
    return;
  }
  const first = !progressView.key;
  progressView.key = key;
  box.classList.toggle('steady', !first);
  box.replaceChildren(...versions.map(versionCard));
}

const errorView = { key: '' };
function renderError(st) {
  const err = $('try-error');
  err.hidden = st.status !== 'failed';
  if (err.hidden) return void (errorView.key = '');
  if (errorView.key === String(st.error) + JSON.stringify(st.needs ?? null)) return; // the same error: no redraw (its shake played every poll)
  errorView.key = String(st.error) + JSON.stringify(st.needs ?? null);
  const m = String(st.error ?? '').match(/^(.+?) \(version ([ABC])\): ([\s\S]*)$/);
  err.replaceChildren(
    h('strong', { class: 'try-error-title' }, m ? `Version ${m[2]} (${m[1]}) couldn't be built` : 'The build stopped'),
    h('p', { class: 'try-error-text' }, m ? m[3] : st.error),
    ...needsCard(st.needs),
    h('p', { class: 'try-error-hint' }, 'The full output is in the build log below. Fix the version and press Build and try again.'));
}

// What a version that didn't start asked for: its settings (added to Settings, empty, for you to fill in) and a
// throwaway database for the test, one click.
let useDatabase = null;
function needsCard(needs) {
  if (!needs) return [];
  const out = [];
  const env = /** @type {HTMLTextAreaElement} */ ($('try-env'));
  const fillable = (needs.settings ?? []).filter((n) => !(needs.database && /^(DATABASE_URL|DB_|POSTGRES|MYSQL)/.test(n)));
  if (fillable.length) {
    out.push(h('p', { class: 'try-error-text' }, `It needs settings: ${fillable.join(', ')}.`),
      h('button', { class: 'btn', type: 'button', onclick: () => {
        const have = new Set(env.value.split(/\r?\n/).map((l) => l.split('=')[0].trim()));
        env.value = [env.value.trim(), ...fillable.filter((n) => !have.has(n)).map((n) => `${n}=`)].filter(Boolean).join('\n');
        go(2);
        env.focus();
      } }, 'Add them to Settings'));
  }
  if (needs.database) {
    out.push(h('p', { class: 'try-error-text' }, `It needs a database (${needs.database}).`),
      h('button', { class: 'btn primary', type: 'button', onclick: () => ((useDatabase = needs.database), void build()) }, `Give it a throwaway ${needs.database} and build again`));
  }
  return out;
}

const RUN_WORD = { building: ['Building…', 'busy'], ready: ['Ready', 'good'], failed: ['Stopped', 'bad'] };

function previews(state) {
  const shop = String(state.shop ?? '').replace(/\/$/, '');
  const list = state.versions.length === 1 ? [state.versions[0], { ...state.versions[0], slot: 'a′', label: 'try:b', name: `${state.versions[0].name} (copy)` }] : state.versions;
  const own = (v) => state.previews?.[v.label] ?? `${shop}/?__turnout_view=${encodeURIComponent(v.label)}`;
  return list.map((v, i) => h('a', { class: 'try-tile', href: own(v), target: '_blank', rel: 'noopener', 'data-i': String(i), title: `Open ${v.name} on its own (never counted)` },
    h('span', { class: 'try-tile-name' }, `${i === 1 && state.versions.length === 1 ? 'A′' : LETTERS[i]} · ${v.name}`),
    h('span', { class: 'try-frame' }, h('iframe', { src: own(v), title: `Preview of ${v.name}`, tabindex: '-1' }))));
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
    built = (st.versions ?? []).length > 0;
    if (st.status === 'building' && step !== 3) go(3);
    const [word, tone] = RUN_WORD[st.status] ?? ['', 'idle'];
    $('try-run-status').textContent = word;
    $('try-run-status').dataset.tone = tone;
    renderProgress(st.versions ?? []);
    renderLog(Array.isArray(st.log) ? st.log.filter((l) => l && typeof l === 'object') : []);
    renderError(st);
    const done = $('try-done');
    done.hidden = st.status !== 'ready';
    if (st.status === 'ready') {
      if (!$('try-previews').childElementCount) $('try-previews').replaceChildren(...previews(st));
      $('try-open-page').hidden = false;
      $('try-done-title').textContent = `Your ${st.kind} test is live`;
      ready = `Ready: the ${st.kind} test is running in Flagsmith.`;
      // A build you just started: once it is ready, go straight to its test page (the bar counts down).
      if (justBuilt) {
        justBuilt = false;
        done.dataset.leaving = 'true';
        $('try-done-text').textContent = "Opening your app's console: traffic, Flagsmith's results and one-button runs…";
        setTimeout(() => location.assign('/app'), 2600);
      } else if (done.dataset.leaving !== 'true') {
        $('try-done-text').textContent = "Open your app's console: one button sends visitors and Flagsmith picks the winner.";
      }
    } else {
      ready = '';
      $('try-previews').replaceChildren();
      $('try-open-page').hidden = true;
    }
    go(step);
    if (st.status === 'building') polling = setTimeout(poll, 1500);
    else polling = 0;
  } catch (error) {
    polling = 0;
    renderError({ status: 'failed', error: error.message });
    go(3);
  }
  kindLine();
}

async function build() {
  let versions;
  try {
    versions = [];
    for (const [i, r] of filled().entries()) versions.push(await versionFor(r, i));
  } catch (error) {
    renderError({ status: 'failed', error: error.message });
    built = true;
    go(3);
    return kindLine();
  }
  const rates = filled().map((r) => Math.min(100, Math.max(0, Number(r.rate) || 0)) / 100);
  $('try-error').hidden = true;
  $('try-done').hidden = true;
  delete $('try-done').dataset.leaving;
  built = true;
  go(3);
  $('try-previews').replaceChildren();
  $('try-open-page').hidden = true;
  const res = await api('/api/try/build', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ versions, goal: /** @type {HTMLInputElement} */ ($('try-goal')).value, rates, env: /** @type {HTMLTextAreaElement} */ ($('try-env')).value, secondary: /** @type {HTMLTextAreaElement} */ ($('try-secondary')).value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 5).map((action) => ({ action })), ...(useDatabase ? { database: useDatabase } : {}) }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    renderError({ status: 'failed', error: body.error ?? `HTTP ${res.status}` });
    built = true;
    go(3);
    return;
  }
  polling = 1;
  justBuilt = true;
  logView.first = '';
  progressView.key = '';
  errorView.key = '';
  built = true;
  go(3);
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
  if (location.hash === '#your-app' && !box.dataset.flashed) {
    box.dataset.flashed = '1';
    box.classList.add('run-try-flash');
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    history.replaceState(null, '', location.pathname + location.search);
  }
  const names = (st.versions ?? []).map((v, i) => `${LETTERS[i]} · ${v.name}`);
  const key = JSON.stringify([st.kind, names]);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(
    h('p', { class: 'run-try-line' }, h('strong', {}, 'Your app (Try it): '), `an ${st.kind} test of ${names.length === 1 ? `${names[0]}, twice` : names.join(st.kind === 'A/B' ? ' against ' : ', ')}.`),
    h('a', { class: 'btn btn-primary run-try-go', href: '/app', title: "Your app's console: the same console, for your versions (flag tryit_release)" }, `▶ Open your app's console (${st.kind} test)`));
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
  open.addEventListener('click', () => {
    /** @type {HTMLDialogElement} */ ($('try-dialog')).showModal();
    render();
    go(built ? 3 : 1);
    void poll();
  });
  // A link from another page (the setup check, What we use): /#try opens Try it.
  if (location.hash === '#try') {
    history.replaceState(null, '', location.pathname + location.search);
    open.click();
  }
  $('try-build').addEventListener('click', async () => {
    await poll(); // started since the box opened?
    if (offline) return;
    ready = '';
    void build();
  });
  $('try-log-copy').addEventListener('click', async () => {
    const btn = $('try-log-copy');
    try {
      await navigator.clipboard.writeText(logText());
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Copy failed';
    }
    setTimeout(() => (btn.textContent = 'Copy'), 1500);
  });
  for (const b of document.querySelectorAll('.try-stepper [data-go]')) b.addEventListener('click', () => go(Number(/** @type {HTMLElement} */ (b).dataset.go)));
  $('try-next').addEventListener('click', () => go(2));
  $('try-back').addEventListener('click', () => go(Math.max(1, step - 1)));
  $('try-goal').addEventListener('input', renderPlan);
  renderChips([], false);
  $('try-example').addEventListener('click', () => {
    for (const r of rows) Object.assign(r, { folder: null, file: null, text: '' });
    rows[0].text = EXAMPLE[0];
    rows[1].text = EXAMPLE[1];
    rows[0].rate = '10';
    rows[1].rate = '18';
    /** @type {HTMLInputElement} */ ($('try-goal')).value = 'GET /pricing.html';
    showC = false;
    render();
  });
}
