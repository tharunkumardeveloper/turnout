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

/** A tar archive (as Blob parts) of files; a name over 99 bytes goes first as a GNU long-name entry, which Docker reads. */
export function tarParts(entries, now = Date.now()) {
  const enc = new TextEncoder();
  const parts = [];
  const header = (nameBytes, size, type) => {
    const b = new Uint8Array(512);
    const put = (s, at, len) => b.set(enc.encode(s).subarray(0, len), at);
    b.set(nameBytes.subarray(0, 100), 0);
    put('0000644\0', 100, 8);
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
  for (const { path, size, data } of entries) {
    const name = enc.encode(path);
    if (name.length > 99) parts.push(header(enc.encode('././@LongLink'), name.length + 1, 'L'), name, new Uint8Array(1), pad(name.length + 1));
    parts.push(header(name.subarray(0, 99), size, '0'), data, pad(size));
  }
  parts.push(new Uint8Array(1024));
  return parts;
}

