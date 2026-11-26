// Plug-and-play: Turnover in front of different kinds of apps it knows nothing about (two static sites, an SPA with
// a JSON API, a POST form with CSRF-style Origin checks, a release mounted under a path), all as real local HTTP
// servers. See docs/PLUG_AND_PLAY.md for the same matrix run against containers and public websites.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { after, before, test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { createProxy, hostOnlyCookie, ID_COOKIE, type Assignment, type FlagSource } from '../src/proxy/server.ts';

// Half the visitors get v2, by a stable hash of their id, like Flagsmith's split.
class SplitFlags implements FlagSource {
  tracked: { event: string; identity: string }[] = [];
  exposures: string[] = [];
  labels: [string, string];
  constructor(labels: [string, string]) {
    this.labels = labels;
  }
  async assign(identity: string, opts: { recordExposure: boolean }): Promise<Assignment> {
    if (opts.recordExposure) this.exposures.push(identity);
    const v2 = [...identity].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 2 === 1;
    return { variant: v2 ? 'v2' : 'control', release: this.labels[v2 ? 1 : 0], enrolled: true };
  }
  track(event: string, identity: string): void {
    this.tracked.push({ event, identity });
  }
}

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

// One app, in two releases: what it answers depends on `name`.
function app(name: string, seen: Seen[]): http.Server {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const url = new URL(req.url ?? '/', 'http://x');
      const self = `http://${req.headers.host}`;
      // POST form: refuses a foreign Origin, as CSRF middleware does, then redirects (Post/Redirect/Get).
      if (req.method === 'POST' && url.pathname.endsWith('/signup')) {
        if (req.headers.origin && req.headers.origin !== self) return void res.writeHead(403).end('bad origin');
        return void res.writeHead(303, { location: `${self}${url.pathname.replace(/signup$/, 'thanks')}` }).end();
      }
      if (url.pathname.endsWith('/api/items')) {
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `sess=${name}; Domain=app.example; Path=/; HttpOnly` });
        return void res.end(JSON.stringify({ release: name }));
      }
      if (url.pathname.endsWith('/assets/app.js')) {
        res.writeHead(200, { 'content-type': 'text/javascript', 'content-encoding': 'gzip' });
        return void res.end(gzipSync(`console.log(${JSON.stringify(name)})`));
      }
      // SPA: every other path is the same shell (client-side routing).
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><script src="assets/app.js"></script>${name}</html>`);
    });
  });
}

const listen = (s: http.Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

const seenA: Seen[] = [];
const seenB: Seen[] = [];
const a = app('site-a', seenA);
const b = app('site-b', seenB);
let flags: SplitFlags;
let proxy: http.Server;
let base = '';
let urlA = '';
let urlB = '';

before(async () => {
  urlA = await listen(a);
  urlB = await listen(b);
  flags = new SplitFlags(['a', 'b']);
  // Release b sits under a path, like a docs page of a bigger site.
  const config = parseConfig({
    flag: 'site_release',
    releases: { a: urlA, b: `${urlB}/v2/` },
    goal: { event: 'signup', when: { method: 'POST', path: '/signup', status: '2xx,303' } },
    guardrails: ['doc_latency_ms', 'server_error'],
  });
  proxy = createProxy({ config, flags, log: () => {}, warn: () => {} });
  base = await listen(proxy);
});
after(() => {
  for (const s of [proxy, a, b]) s.close();
});

const page = { accept: 'text/html', 'user-agent': 'Mozilla/5.0' };

async function visitor(): Promise<{ id: string; cookie: string; first: string }> {
  const res = await fetch(`${base}/`, { headers: page });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
  return { id: cookie.split('=')[1]!, cookie, first: await res.text() };
}

test('both releases are served, and each visitor keeps theirs', async () => {
  const served = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const v = await visitor();
    const release = v.first.includes('site-a') ? 'site-a' : 'site-b';
    served.add(release);
    for (const path of ['/', '/pricing', '/deep/route?x=1']) {
      const text = await (await fetch(`${base}${path}`, { headers: { ...page, cookie: v.cookie } })).text();
      assert.ok(text.includes(release), `${path} switched release`);
    }
  }
  assert.deepEqual([...served].sort(), ['site-a', 'site-b']);
});

test('a release under a path gets the prefix on requests and loses it on redirects', async () => {
  seenB.length = 0;
  let v = await visitor();
  while (!v.first.includes('site-b')) v = await visitor();
  await fetch(`${base}/pricing?q=1`, { headers: { ...page, cookie: v.cookie } });
  assert.equal(seenB.at(-1)?.url, '/v2/pricing?q=1');
  const res = await fetch(`${base}/signup`, { method: 'POST', redirect: 'manual', headers: { cookie: v.cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=x' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/thanks'); // not /v2/thanks, which would become /v2/v2/thanks
});

test('the app sees its own Host, Origin and Referer, so CSRF-style checks pass', async () => {
  seenA.length = 0;
  let v = await visitor();
  while (!v.first.includes('site-a')) v = await visitor();
  const res = await fetch(`${base}/signup`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: v.cookie, origin: base, referer: `${base}/pricing?plan=pro`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'email=a%40b.c',
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/thanks');
  const post = seenA.at(-1)!;
  assert.equal(post.headers.host, new URL(urlA).host);
  assert.equal(post.headers.origin, urlA);
  assert.equal(post.headers.referer, `${urlA}/pricing?plan=pro`);
  assert.equal(post.headers['x-forwarded-host'], new URL(base).host);
  assert.equal(post.body, 'email=a%40b.c');
  assert.ok(flags.tracked.some((t) => t.event === 'signup' && t.identity === v.id), 'the 303 counted as the goal');
});

test('a foreign Origin is passed through untouched', async () => {
  const v = await visitor();
  const res = await fetch(`${base}/signup`, { method: 'POST', redirect: 'manual', headers: { cookie: v.cookie, origin: 'https://evil.example' }, body: '' });
  assert.equal(res.status, 403);
});

test('SPA: compressed assets and JSON API calls go to the visitor\'s release, app cookies become host-only', async () => {
  const v = await visitor();
  const release = v.first.includes('site-a') ? 'site-a' : 'site-b';
  const js = await fetch(`${base}/assets/app.js`, { headers: { cookie: v.cookie } });
  assert.equal(js.headers.get('content-encoding'), 'gzip');
  assert.ok((await js.text()).includes(release)); // fetch decompresses: the bytes went through intact
  const api = await fetch(`${base}/api/items`, { headers: { cookie: v.cookie, accept: 'application/json' } });
  assert.deepEqual(await api.json(), { release });
  const setCookie = api.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /sess=/);
  assert.doesNotMatch(setCookie, /domain=/i);
  // API calls and assets aren't page loads: no exposure from them.
  const exposuresBefore = flags.exposures.filter((x) => x === v.id).length;
  await fetch(`${base}/api/items`, { headers: { cookie: v.cookie } });
  assert.equal(flags.exposures.filter((x) => x === v.id).length, exposuresBefore);
});

test('hostOnlyCookie drops only the Domain attribute', () => {
  assert.equal(hostOnlyCookie('a=1; Domain=.example.com; Path=/; Secure'), 'a=1; Path=/; Secure');
  assert.equal(hostOnlyCookie('a=domain=x; Path=/'), 'a=domain=x; Path=/');
  assert.equal(hostOnlyCookie('domain=1; Path=/'), 'domain=1; Path=/');
});

test('hostOnlyCookie drops Secure for plain-http visitors, except on __Secure- and __Host- cookies', () => {
  assert.equal(hostOnlyCookie('s=1; path=/; HttpOnly; secure; SameSite=Lax', true), 's=1; path=/; HttpOnly; SameSite=Lax');
  assert.equal(hostOnlyCookie('s=1; Secure', false), 's=1; Secure');
  assert.equal(hostOnlyCookie('__Host-s=1; Secure; Path=/', true), '__Host-s=1; Secure; Path=/');
});

test('the visitor cookie is set once and never reaches the app', async () => {
  const v = await visitor();
  seenA.length = seenB.length = 0;
  await fetch(`${base}/`, { headers: { ...page, cookie: `${v.cookie}; theirs=1` } });
  const got = [...seenA, ...seenB].at(-1)!;
  assert.equal(got.headers.cookie, 'theirs=1');
  assert.ok(!got.headers.cookie?.includes(ID_COOKIE));
});
