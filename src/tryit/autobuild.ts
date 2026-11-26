// Any repo runs (docs/PLAN.md step 2): a Dockerfile for a folder that has none, the settings an app's error asks for,
// and a throwaway database for the test. The repo's own Dockerfile always wins.
import { readFileSync, writeFileSync } from 'node:fs';

type Read = (path: string) => string | null;

/** A Dockerfile for a project that has none, from what the project is (Node, Python, Go, PHP, Ruby, plain HTML); null: can't tell. */
export function generatedDockerfile(files: string[], read: Read): string | null {
  const has = (p: string) => files.includes(p);
  if (has('package.json')) {
    let pkg: { scripts?: Record<string, string>; main?: string } = {};
    try {
      pkg = JSON.parse(read('package.json') ?? '{}');
    } catch {}
    const s = pkg.scripts ?? {};
    const build = s.build ? 'RUN npm run build\n' : '';
    const start = s.start ? '["npm", "start"]' : `["node", "${pkg.main ?? (has('server.js') ? 'server.js' : 'index.js')}"]`;
    // A build with no start script is a static site: serve what it built.
    if (!s.start && s.build && !pkg.main) {
      return `FROM node:22-alpine AS build\nWORKDIR /app\nCOPY . .\nRUN npm install --no-audit --no-fund\n${build}FROM nginx:1.27-alpine\nCOPY --from=build /app/dist /usr/share/nginx/html\n`;
    }
    return `FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nRUN npm install --no-audit --no-fund\n${build}ENV PORT=3000\nEXPOSE 3000\nCMD ${start}\n`;
  }
  if (has('requirements.txt') || has('pyproject.toml')) {
    const reqs = (read('requirements.txt') ?? '').toLowerCase();
    const install = has('requirements.txt') ? 'RUN pip install --no-cache-dir -r requirements.txt' : 'RUN pip install --no-cache-dir .';
    let cmd = '["python", "app.py"]';
    if (has('manage.py')) cmd = '["python", "manage.py", "runserver", "0.0.0.0:8000", "--noreload"]';
    else if (/\bflask\b/.test(reqs)) cmd = `["python", "-m", "flask", "--app", "${has('app.py') ? 'app' : has('main.py') ? 'main' : 'wsgi'}", "run", "--host=0.0.0.0", "--port=8000"]`;
    else if (/\b(fastapi|uvicorn)\b/.test(reqs)) cmd = `["python", "-m", "uvicorn", "${has('main.py') ? 'main' : 'app'}:app", "--host", "0.0.0.0", "--port", "8000"]`;
    return `FROM python:3.12-slim\nWORKDIR /app\nCOPY . .\n${install}\nEXPOSE 8000\nCMD ${cmd}\n`;
  }
  if (has('go.mod')) return 'FROM golang:1.22-alpine AS build\nWORKDIR /src\nCOPY . .\nRUN go build -o /app .\nFROM alpine:3.20\nCOPY --from=build /app /app\nENV PORT=8080\nEXPOSE 8080\nCMD ["/app"]\n';
  if (has('Gemfile')) return 'FROM ruby:3.3-slim\nWORKDIR /app\nCOPY . .\nRUN bundle install\nEXPOSE 4567\nCMD ["ruby", "app.rb", "-o", "0.0.0.0", "-p", "4567"]\n';
  if (files.some((f) => /^[^/]+\.php$/i.test(f)) || has('composer.json')) return 'FROM php:8.3-apache\nCOPY . /var/www/html/\n';
  if (has('index.html')) return 'FROM nginx:1.27-alpine\nCOPY . /usr/share/nginx/html\n';
  return null;
}

/** The settings an app's error names: "DATABASE_URL is not set", "KeyError: 'SECRET_KEY'", "missing env STRIPE_KEY". */
export function missingSettings(log: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /\b([A-Z][A-Z0-9_]{2,})\b[^\n]{0,40}\b(?:is not set|not set|is required|is missing|missing|undefined|must be set|not defined|not found in (?:the )?environment)/g,
    /\b(?:missing|required|set|define|provide)\b[^\n]{0,30}?\b(?:env(?:ironment)?(?: variable)?s?|setting)\b[^\n]{0,10}?[`'"]?([A-Z][A-Z0-9_]{2,})\b/gi,
    /KeyError: ['"]([A-Z][A-Z0-9_]{2,})['"]/g,
    /\b(DATABASE_URL|REDIS_URL|MONGO(?:DB)?_URI|POSTGRES_URL)\b/g,
  ];
  for (const p of patterns) for (const m of log.matchAll(p)) if (!/^(ERROR|WARN|INFO|DEBUG|HTTP|GET|POST|NODE_ENV|PATH|HOME)$/.test(m[1]!)) names.add(m[1]!);
  return [...names].slice(0, 10);
}

/** A database the app wants, from the setting names it asked for: postgres, mysql, or null. */
export function wantsDatabase(names: string[], log = ''): 'postgres' | 'mysql' | null {
  if (!names.some((n) => /DATABASE|DB_|POSTGRES|MYSQL/.test(n)) && !/ECONNREFUSED[^\n]*:(5432|3306)/.test(log)) return null;
  return /mysql|3306/i.test(log) || names.some((n) => /MYSQL/.test(n)) ? 'mysql' : 'postgres';
}

/** The throwaway database's container and the settings that point an app at it. */
export function databaseFor(kind: 'postgres' | 'mysql'): { image: string; env: string[]; appEnv: string[] } {
  if (kind === 'mysql') {
    return {
      image: 'mysql:8.4',
      env: ['MYSQL_ROOT_PASSWORD=turnout', 'MYSQL_DATABASE=app'],
      appEnv: ['DATABASE_URL=mysql://root:turnout@try-db:3306/app', 'MYSQL_HOST=try-db', 'DB_HOST=try-db', 'DB_PORT=3306', 'DB_USER=root', 'DB_PASSWORD=turnout', 'DB_NAME=app'],
    };
  }
  return {
    image: 'postgres:16-alpine',
    env: ['POSTGRES_PASSWORD=turnout', 'POSTGRES_DB=app'],
    appEnv: ['DATABASE_URL=postgres://postgres:turnout@try-db:5432/app', 'POSTGRES_URL=postgres://postgres:turnout@try-db:5432/app', 'DB_HOST=try-db', 'DB_PORT=5432', 'DB_USER=postgres', 'DB_PASSWORD=turnout', 'DB_NAME=app'],
  };
}

// --- A tar file, read and added to without unpacking it ---

/** The files in a tar archive, with a reader for small ones (package.json, requirements.txt). */
export function tarIndex(buf: Buffer): { files: string[]; read: Read } {
  const files: string[] = [];
  const bodies = new Map<string, Buffer>();
  let at = 0;
  let longName: string | null = null;
  while (at + 512 <= buf.length) {
    const h = buf.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
    const type = String.fromCharCode(h[156]!);
    const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    let name = longName ?? h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    if (!longName && prefix && h.subarray(257, 262).toString('ascii') === 'ustar' && h[262] === 0) name = `${prefix}/${name}`;
    longName = null;
    const body = buf.subarray(at + 512, at + 512 + size);
    if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '');
    else if (type === '0' || type === '\0') {
      const clean = name.replace(/^\.\//, '');
      files.push(clean);
      if (size < 256 * 1024) bodies.set(clean, Buffer.from(body));
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return { files, read: (p) => bodies.get(p)?.toString('utf8') ?? null };
}

/** Adds one file to a tar archive on disk (before its end blocks). */
export function tarAppend(file: string, name: string, content: string): void {
  const buf = readFileSync(file);
  let end = 0;
  while (end + 512 <= buf.length && !buf.subarray(end, end + 512).every((b) => b === 0)) {
    const size = parseInt(buf.subarray(end + 124, end + 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
    end += 512 + Math.ceil(size / 512) * 512;
  }
  const data = Buffer.from(content);
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  h.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136);
  h.write('        ', 148);
  h.write('0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  writeFileSync(file, Buffer.concat([buf.subarray(0, end), h, data, Buffer.alloc((512 - (data.length % 512)) % 512), Buffer.alloc(1024)]));
}
