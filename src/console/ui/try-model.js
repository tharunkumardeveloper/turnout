// Try it's pure parts, tested on their own: what a pasted text is, whether a Dockerfile needs its folder, which
// Dockerfiles a chosen folder holds, and the tar archive a folder is sent as.

// Never sent: what makes a folder big and is rebuilt inside the image anyway.
export const SKIP = /(^|\/)(node_modules|\.git|\.next|\.nuxt|\.turbo|\.cache|venv|\.venv|__pycache__|\.pytest_cache)(\/|$)/;


/** What a pasted text is: a Dockerfile, a git repository or an image name (kind null: can't tell). */
const SCHEME = 'https:'; // written apart so the page holds no remote URL (they are the user's, sent to Docker)
export function detect(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  if (/^\s*FROM\s+\S+/im.test(t)) return { kind: 'dockerfile', value: t, label: 'a Dockerfile', copies: copiesFiles(t) };
  const url = t.match(/^(?:https?:\/\/)?(?:www\.)?(github\.com|gitlab\.com|bitbucket\.org)\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?(#.*)?$/i);
  if (url) return { kind: 'git', value: `${SCHEME}//${url[1].toLowerCase()}/${url[2]}/${url[3]}.git${url[4] ?? ''}`, label: `a git repository (${url[2]}/${url[3]})` };
  if (/^(https:\/\/|git@)\S+$/.test(t)) return { kind: 'git', value: t, label: 'a git repository' };
  if (/^[\w.\-/:@]+$/.test(t)) return { kind: 'image', value: t, label: `a Docker image (${t})` };
  return { kind: null, label: 'not something Turnout recognises: paste a Dockerfile, a GitHub link or an image name' };
}
/** True when a Dockerfile copies files from your project (so it needs its folder). */
export function copiesFiles(dockerfile) {
  return dockerfile.split(/\r?\n/).some((line) => {
    const m = line.match(/^\s*(COPY|ADD)\s+(.*)$/i);
    if (!m || /--from=/i.test(m[2])) return false;
    const src = m[2].replace(/--\S+\s*/g, '').trim().replace(/^\[\s*"?/, '').split(/[\s",]+/)[0] ?? '';
    return !/^https?:\/\//i.test(src);
  });
}
/** Dockerfiles at the top of a chosen folder: Dockerfile first, then Dockerfile.* and *.Dockerfile. */
export function dockerfilesIn(paths) {
  const top = paths.filter((p) => !p.includes('/') && /^Dockerfile(\..+)?$|\.Dockerfile$/i.test(p));
  return top.sort((a, b) => (a === 'Dockerfile' ? -1 : b === 'Dockerfile' ? 1 : a.localeCompare(b)));
}

/** A tar archive (as Blob parts) of files; a name over 99 bytes goes first as a GNU long-name entry, which Docker reads.
 *  An entry's mode (e.g. 0o755) is kept when given, so scripts like bin/rails stay executable; otherwise 0644. */
export function tarParts(entries, now = Date.now()) {
  const enc = new TextEncoder();
  const parts = [];
  const header = (nameBytes, size, type, mode = 0o644) => {
    const b = new Uint8Array(512);
    const put = (s, at, len) => b.set(enc.encode(s).subarray(0, len), at);
    b.set(nameBytes.subarray(0, 100), 0);
    put(`${(mode & 0o777).toString(8).padStart(7, '0')}\0`, 100, 8);
    put('0000000\0', 108, 8);
    put('0000000\0', 116, 8);
    put(`${size.toString(8).padStart(11, '0')}\0`, 124, 12);
    put(`${Math.floor(now / 1000).toString(8).padStart(11, '0')}\0`, 136, 12);
    put('        ', 148, 8);
    put(type, 156, 1);
    put('ustar  \0', 257, 8);
    let sum = 0;
    for (const x of b) sum += x;
    put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    return b;
  };
  const pad = (n) => new Uint8Array((512 - (n % 512)) % 512);
  for (const { path, size, data, mode } of entries) {
    const name = enc.encode(path);
    if (name.length > 99) parts.push(header(enc.encode('././@LongLink'), name.length + 1, 'L'), name, new Uint8Array(1), pad(name.length + 1));
    parts.push(header(name.subarray(0, 99), size, '0', mode), data, pad(size));
  }
  parts.push(new Uint8Array(1024));
  return parts;
}


// Goals that fit the site: its pages, from its files. Static pages (about.html), Next.js (app/contact/page.tsx,
// pages/pricing.tsx), Astro/SvelteKit-style routes (src/pages/…, src/routes/…/+page.svelte). The pages people act on
// (contact, pricing, sign-up, checkout…) come first; the home page is never a goal (everyone sees it).
const ACT = ['contact', 'pricing', 'signup', 'sign-up', 'register', 'checkout', 'cart', 'subscribe', 'book', 'demo', 'hire', 'quote', 'download', 'donate', 'login', 'projects', 'portfolio', 'blog', 'about', 'services', 'resume'];
const SKIP_DIRS = /(^|\/)(node_modules|\.git|\.next|dist|build|out|public\/(?:assets|static)|static|assets|vendor|coverage|test|tests|__tests__|docs?)\//i;

/** One file path → the page it serves, or null. */
export function routeOf(path) {
  const p = String(path).split('\\').join('/');
  if (SKIP_DIRS.test(p)) return null;
  if (/(^|\/)_[^/]*\//.test(p) && !/^(src\/)?(app|pages)\//.test(p)) return null; // _includes/, _layouts/ (Jekyll): fragments, not pages
  let m;
  if ((m = p.match(/^(?:src\/)?app\/(.*?)\/?page\.(?:t|j)sx?$/))) return '/' + m[1];
  if ((m = p.match(/^(?:src\/)?pages\/(.+?)\.(?:t|j)sx?$|^(?:src\/)?pages\/(.+?)\.(?:astro|md|mdx|vue|svelte)$/))) {
    const r = m[1] ?? m[2];
    if (/^(_|api\/)/.test(r) || /\/_/.test(r)) return null;
    return '/' + r.replace(/(^|\/)index$/, '');
  }
  if ((m = p.match(/^src\/routes\/(.*?)\/?\+page\.(?:svelte|ts|js)$/))) return '/' + m[1];
  if ((m = p.match(/^(?:templates\/|src\/)?([\w./-]*?)\.html?$/i)) && !/(^|\/)(templates|layouts?|partials|includes|components)\//i.test(p)) {
    // about.html → /about.html; projects/index.html → /projects (its folder); index.html → / (the home page)
    if (/(^|\/)index$/i.test(m[1])) return '/' + m[1].replace(/(^|\/)index$/i, '');
    return '/' + m[1] + '.html';
  }
  return null;
}

/** Goal suggestions for a version: "GET /contact", most useful first, at most `max`. Dynamic parts become *. */
export function goalsFrom(paths, max = 6) {
  const routes = new Map();
  for (const p of paths) {
    const r = routeOf(p);
    if (r == null) continue;
    const clean = r.replace(/\/\([^)]*\)/g, '').replace(/\[{1,2}\.{0,3}[^\]]+\]{1,2}/g, '*').replace(/\/+$/, '') || '/';
    if (clean === '/' || /\/(404|500|_not-found|not-found)(\.html)?$/.test(clean)) continue;
    const rank = ACT.findIndex((w) => clean.toLowerCase().includes(w));
    routes.set(clean, Math.min(routes.get(clean) ?? 99, rank < 0 ? 50 + clean.split('/').length : rank));
  }
  return [...routes].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).slice(0, max).map(([r]) => `GET ${r.replace(/\.html$/, '.html')}${r.includes('*') || r.endsWith('.html') ? '' : '*'}`);
}

/**
 * Goals from a page's own HTML: what a visitor can do there that reaches the server. A form that posts somewhere
 * ("POST /contact"), a file to download ("GET /docs/cv.pdf"), a link to another page. Not mailto:, tel:, #anchors,
 * javascript: forms or other sites: those never reach Turnout, so they can't be counted.
 */
export function goalsFromHtml(html) {
  const out = [];
  const add = (g, rank) => { if (!out.some((x) => x.g === g)) out.push({ g, rank }); };
  const local = (u) => {
    const v = String(u ?? '').trim();
    if (!v || /^(#|mailto:|tel:|javascript:|data:|https?:|\/\/)/i.test(v)) return null;
    const path = ('/' + v.replace(/^\.?\//, '')).replace(/[?#].*$/, '').replace(/\/{2,}/g, '/');
    return /\.(css|js|mjs|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|map|json|xml|txt)$/i.test(path) ? null : path;
  };
  for (const m of String(html).matchAll(/<form\b([^>]*)>/gi)) {
    const attrs = m[1];
    const action = (attrs.match(/\baction\s*=\s*["']?([^"'\s>]*)/i) ?? [])[1];
    const method = ((attrs.match(/\bmethod\s*=\s*["']?(\w+)/i) ?? [])[1] ?? 'GET').toUpperCase();
    const path = action === '' || action === undefined ? null : local(action);
    if (path) add(`${method === 'POST' ? 'POST' : 'GET'} ${path}`, 0);
  }
  for (const m of String(html).matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
    const path = local(m[1]);
    if (!path || path === '/' || path === '/index.html') continue;
    if (/\.(pdf|docx?|zip|pptx?|xlsx?)$/i.test(path)) add(`GET ${path}`, 1);
    else {
      const rank = ACT.findIndex((w) => path.toLowerCase().includes(w));
      add(`GET ${path}${path.endsWith('.html') ? '' : '*'}`, rank < 0 ? 60 : 2 + rank);
    }
  }
  return out.sort((a, b) => a.rank - b.rank).map((x) => x.g);
}
