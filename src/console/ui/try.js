// The console's "Try it with your app" box: one, two or three versions of your app (a Dockerfile, a public git repo
// or an image), built and run on this machine by the tryit service, then the same test page as judge mode at /try.
// One version makes an A/A test, two an A/B test, three an A/B/C test. Every string goes in through textContent.

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

// Two self-contained Dockerfiles (no other files needed), so anyone can see it work without an app of their own.
const EXAMPLE = [
  `FROM nginx:alpine
RUN printf '%s' '<!doctype html><title>Signup A</title><body style="font-family:sans-serif;background:#f4f6fb;padding:40px"><h1 style="color:#1d4ed8">Version A: the classic page</h1><p>A long sign-up form.</p><p><a href="/pricing.html">Pricing</a> · <a href="/about.html">About</a></p></body>' > /usr/share/nginx/html/index.html \\
 && printf '%s' '<!doctype html><h1>Pricing</h1><a href="/">Home</a>' > /usr/share/nginx/html/pricing.html \\
 && printf '%s' '<!doctype html><h1>About</h1><a href="/">Home</a>' > /usr/share/nginx/html/about.html`,
  `FROM nginx:alpine
RUN printf '%s' '<!doctype html><title>Signup B</title><body style="font-family:sans-serif;background:#ecfdf3;padding:40px"><h1 style="color:#15803d">Version B: the short page</h1><p>One field, one button.</p><p><a href="/pricing.html">Pricing</a> · <a href="/about.html">About</a></p></body>' > /usr/share/nginx/html/index.html \\
 && printf '%s' '<!doctype html><h1>Pricing</h1><a href="/">Home</a>' > /usr/share/nginx/html/pricing.html \\
 && printf '%s' '<!doctype html><h1>About</h1><a href="/">Home</a>' > /usr/share/nginx/html/about.html`,
];

const rows = LETTERS.map((letter, i) => ({ letter, kind: 'dockerfile', value: '', port: '', rate: i === 0 ? '10' : '10' }));
let polling = 0;
let ready = ''; // the line once a build is ready (kept until the versions change)

function rowView(r, i) {
  const field =
    r.kind === 'dockerfile'
      ? h('div', { class: 'try-field' },
          h('textarea', { rows: 4, spellcheck: 'false', placeholder: i ? 'Optional. Paste a Dockerfile, or upload one.' : 'Paste a Dockerfile, or upload one. It must be self-contained (for COPY of your files, use a git repo).', value: r.value, on: { input: (e) => ((r.value = e.target.value), (ready = ''), kindLine()) } }),
          h('label', { class: 'try-upload' }, 'Upload…', h('input', { type: 'file', accept: '.dockerfile,text/plain,*', on: { change: async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            r.value = await file.text();
            render();
          } } })))
      : h('input', { class: 'try-text', spellcheck: 'false', value: r.value, placeholder: r.kind === 'git' ? 'a public git URL: github.com/you/app.git, with https:// (optionally #branch:folder)' : 'an image, such as nginx:alpine or myapp:1.1', on: { input: (e) => ((r.value = e.target.value), kindLine()) } });
  return h('div', { class: 'try-row', 'data-i': String(i) },
    h('span', { class: 'try-letter' }, r.letter),
    h('div', { class: 'try-main' },
      h('div', { class: 'try-kinds', role: 'group', 'aria-label': `Version ${r.letter}: what you give` },
        ...[['dockerfile', 'Dockerfile'], ['git', 'Git repo'], ['image', 'Image']].map(([k, label]) =>
          h('button', { type: 'button', class: 'try-kind', 'aria-pressed': String(r.kind === k), on: { click: () => ((r.kind = k), render()) } }, label))),
      field),
    h('div', { class: 'try-side' },
      h('label', {}, 'Port', h('input', { class: 'try-num', type: 'number', min: 1, max: 65535, placeholder: 'auto', value: r.port, title: "The port your app listens on (default: the image's EXPOSE, else 80)", on: { input: (e) => (r.port = e.target.value) } })),
      h('label', { title: 'Simulated visitors convert at this rate on this version (an input you choose, not evidence). Real differences in page speed and errors are measured as they are.' }, 'Pretend %', h('input', { class: 'try-num', type: 'number', min: 0, max: 100, step: 1, value: r.rate, on: { input: (e) => (r.rate = e.target.value) } }))));
}

function filled() {
  return rows.filter((r) => r.value.trim());
}
function kindLine() {
  const n = filled().length;
  $('try-kind').textContent = ready || (n ? `${n} version${n > 1 ? 's' : ''}: ${KIND[n]}.` : 'Give at least version A.');
  /** @type {HTMLButtonElement} */ ($('try-build')).disabled = !n || Boolean(polling);
}
function render() {
  $('try-versions').replaceChildren(...rows.map(rowView));
  kindLine();
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
    const st = await res.json();
    if (!res.ok) throw new Error(st.error ?? `HTTP ${res.status}`);
    const last = st.status === 'building' ? (st.log ?? []).filter((l) => !l.startsWith('  ')).at(-1) : null;
    $('try-progress').replaceChildren(...(st.versions ?? []).map(stageList), last ? h('li', { class: 'try-now' }, last) : null);
    const err = $('try-error');
    err.hidden = st.status !== 'failed';
    err.textContent = st.status === 'failed' ? `Stopped: ${st.error}` : '';
    if (st.status === 'ready') {
      const fresh = !$('try-previews').childElementCount;
      $('try-previews').replaceChildren(...previews(st));
      $('try-open-page').hidden = false;
      ready = `Ready: the ${st.kind} test is running in Flagsmith. Open the test page: Play it for me runs it (simulated visitors, then Flagsmith's results), as in judge mode.`;
      if (fresh) $('try-previews').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
  const versions = filled().map((r) => ({ kind: r.kind, value: r.value, ...(Number(r.port) > 0 ? { port: Number(r.port) } : {}) }));
  const rates = filled().map((r) => Math.min(100, Math.max(0, Number(r.rate) || 0)) / 100);
  $('try-error').hidden = true;
  $('try-previews').replaceChildren();
  $('try-open-page').hidden = true;
  const res = await api('/api/try/build', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ versions, goal: /** @type {HTMLInputElement} */ ($('try-goal')).value, rates }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    $('try-error').hidden = false;
    $('try-error').textContent = body.error ?? `HTTP ${res.status}`;
    return;
  }
  polling = 1;
  kindLine();
  void poll();
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
    void poll();
  });
  $('try-build').addEventListener('click', () => {
    ready = '';
    void build();
  });
  $('try-example').addEventListener('click', () => {
    rows[0].kind = rows[1].kind = 'dockerfile';
    rows[0].value = EXAMPLE[0];
    rows[1].value = EXAMPLE[1];
    rows[2].value = '';
    rows[0].rate = '10';
    rows[1].rate = '18';
    /** @type {HTMLInputElement} */ ($('try-goal')).value = 'GET /pricing.html';
    render();
  });
}
