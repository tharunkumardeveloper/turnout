// The proxy's edges: request targets, data quality, headers, timeouts, upgrades, cold starts.
import assert from 'node:assert/strict';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { createProxy, ID_COOKIE, originForm, type Assignment, type FlagSource } from '../src/proxy/server.ts';

const listen = (server: http.Server) =>
  new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

function app(name: string): http.Server {
  return http.createServer((req, res) => {
    if (req.url === '/echo') {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'x-secret', 'x-secret': 'hop', 'keep-alive': 'timeout=99' });
      res.end(JSON.stringify(req.headers));
      return;
    }
    if (req.url === '/redir') {
      res.writeHead(302, { location: `http://${req.headers.host}/next?a=1` }).end();
      return;
    }
    if (req.url === '/slow') return; // never answers
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(name);
  });
}

const config = (a: string, b: string, guardrails: string[] = ['doc_latency_ms', 'server_error']) =>
  parseConfig({
    flag: 'shop_release',
    releases: { 'shop:1.4': a, 'shop:1.5': b },
    goal: { event: 'order_placed', when: { method: 'POST', path: '/checkout', status: '2xx' } },
    guardrails,
  });

class Flags implements FlagSource {
  exposures: string[] = [];
  tracked: string[] = [];
  async assign(identity: string, opts: { recordExposure: boolean }): Promise<Assignment> {
    if (opts.recordExposure) this.exposures.push(identity);
    return { variant: 'control', release: 'shop:1.4', enrolled: true };
  }
  track(event: string, identity: string): void {
    this.tracked.push(`${event}:${identity}`);
  }
}

const servers: http.Server[] = [];
const flags = new Flags();
let base = '';

before(async () => {
  const a = app('shop 1.4');
  const b = app('shop 1.5');
  servers.push(a, b);
  const proxy = createProxy({ config: config(await listen(a), await listen(b)), flags, upstreamTimeoutMs: 300, log: () => {}, warn: () => {} });
  servers.push(proxy);
  base = await listen(proxy);
});
after(() => servers.forEach((s) => s.close()));

// A raw request line, so the target reaches the proxy exactly as written (fetch would normalise it).
function raw(target: string, extra = ''): Promise<string> {
  const { port, hostname } = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), hostname, () => {
      socket.write(`GET ${target} HTTP/1.1\r\nhost: ${hostname}:${port}\r\nuser-agent: Mozilla/5.0\r\naccept: text/html\r\nconnection: close\r\n${extra}\r\n`);
    });
    let out = '';
    socket.on('data', (d) => (out += d));
    socket.on('end', () => resolve(out));
    socket.on('error', reject);
  });
}

const page = (cookie?: string) => fetch(`${base}/`, { headers: { accept: 'text/html', ...(cookie ? { cookie } : {}) } });

test('originForm accepts only /path?query', () => {
  assert.deepEqual(originForm('/a/b?c=1'), { pathname: '/a/b', search: '?c=1' });
  for (const bad of ['//flagsmith:8000/version/', '//', 'http://evil/', '/\\evil', '*', '', 'evil:80']) assert.equal(originForm(bad), null, bad);
});

test('refuses request targets that would pick the host, and stays up', async () => {
  const { host } = new URL(base);
  for (const target of [`//${host}/version/`, '//', `http://${host}/`, '/\\evil.example/', '*']) {
    const res = await raw(target);
    assert.match(res, /^HTTP\/1\.1 400/, target);
    assert.ok(!res.includes('shop 1.'), `${target} must not reach an app`);
  }
  assert.equal(await (await page()).text(), 'shop 1.4');
});

test('a first request records no exposure and no events; the cookie round-trip does', async () => {
  const before = { exposures: flags.exposures.length, tracked: flags.tracked.length };
  const first = await page();
  const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0]!;
  await first.text();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(flags.exposures.length, before.exposures);
  assert.equal(flags.tracked.length, before.tracked);
  await (await page(cookie)).text();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(flags.exposures.length, before.exposures + 1);
  assert.ok(flags.tracked.length > before.tracked);
});

test('HEAD records no exposure', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await fetch(`${base}/`, { method: 'HEAD', headers: { accept: 'text/html', cookie: `${ID_COOKIE}=${id}` } });
  assert.ok(!flags.exposures.includes(id));
});

test("hop-by-hop headers and Turnout's cookies never reach the app or the visitor", async () => {
  const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const res = await fetch(`${base}/echo`, {
    headers: { cookie: `${ID_COOKIE}=${id}; app=1; tn_preview=x`, 'x-turnout-debug': 'dbg', 'proxy-authorization': 'Basic x' },
  });
  const seen = (await res.json()) as Record<string, string>;
  assert.equal(seen.cookie, 'app=1');
  assert.equal(seen['proxy-authorization'], undefined);
  assert.equal(seen['x-turnout-debug'], undefined);
  assert.equal(seen['x-forwarded-proto'], 'http');
  assert.equal(res.headers.get('x-secret'), null, 'headers named in Connection are stripped');
  assert.notEqual(res.headers.get('keep-alive'), 'timeout=99', "the app's keep-alive is its own connection's");
});

test('without a debug token, the variant headers are never sent', async () => {
  const res = await fetch(`${base}/`, { headers: { accept: 'text/html', 'x-turnout-debug': '1' } });
  assert.equal(res.headers.get('x-turnout-variant'), null);
});

test("redirects to the app's own host stay on the visitor's", async () => {
  const res = await fetch(`${base}/redir`, { redirect: 'manual' });
  assert.equal(res.headers.get('location'), '/next?a=1');
});

test('an app that never answers gets a 504', async () => {
  assert.equal((await fetch(`${base}/slow`)).status, 504);
});

test('WebSocket upgrades get a 501 instead of hanging', async () => {
  assert.match(await raw('/socket', 'upgrade: websocket\r\nconnection: upgrade\r\n'), /^HTTP\/1\.1 501/);
});

test('/__turnout/health reports the live release', async () => {
  const health = (await (await fetch(`${base}/__turnout/health`)).json()) as { ok: boolean; liveRelease: string };
  assert.equal(health.ok, true);
  assert.equal(health.liveRelease, 'shop:1.4');
});

test('cookies get Secure behind TLS', async () => {
  const res = await fetch(`${base}/`, { headers: { accept: 'text/html', 'x-forwarded-proto': 'https' } });
  assert.match(res.headers.get('set-cookie') ?? '', /; Secure/);
});

describe('cold start and slow flags', () => {
  test('serves the remembered live release before Flagsmith is ready, and never waits past the deadline', async () => {
    const a = app('shop 1.4');
    const b = app('shop 1.5');
    let ready = false;
    let calls = 0;
    const slow: FlagSource = {
      ready: () => ready,
      assign: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 2000));
        return { variant: 'control', release: 'shop:1.4', enrolled: true };
      },
      track: () => {},
    };
    const p = createProxy({
      config: config(await listen(a), await listen(b), []),
      flags: slow,
      assignTimeoutMs: 100,
      memory: { load: () => 'shop:1.5', save: () => {} },
      log: () => {},
      warn: () => {},
    });
    const url = await listen(p);
    const get = () => fetch(`${url}/`, { headers: { accept: 'text/html', cookie: `${ID_COOKIE}=cccccccc-cccc-4ccc-8ccc-cccccccccccc` } });

    assert.equal(await (await get()).text(), 'shop 1.5', 'not ready: the remembered live release');
    assert.equal(calls, 0, 'not ready: the SDK is not asked');

    ready = true;
    const started = performance.now();
    assert.equal(await (await get()).text(), 'shop 1.5');
    assert.ok(performance.now() - started < 1000, 'the deadline, not the 2 s flag, decides');
    assert.equal(calls, 1);
    for (const s of [p, a, b]) s.close();
  });

  test('remembers the release that visitors outside the experiment get', async () => {
    const a = app('shop 1.4');
    const b = app('shop 1.5');
    const saved: string[] = [];
    const shipped: FlagSource = { assign: async () => ({ variant: 'v2', release: 'shop:1.5', enrolled: false }), track: () => {} };
    const p = createProxy({
      config: config(await listen(a), await listen(b), []),
      flags: shipped,
      memory: { load: () => undefined, save: (r) => saved.push(r) },
      log: () => {},
      warn: () => {},
    });
    const url = await listen(p);
    await (await fetch(`${url}/`, { headers: { accept: 'text/html' } })).text();
    await (await fetch(`${url}/`, { headers: { accept: 'text/html' } })).text();
    // a bot now gets the shipped release, not the config's first
    assert.equal(await (await fetch(`${url}/`, { headers: { accept: 'text/html', 'user-agent': 'Googlebot' } })).text(), 'shop 1.5');
    assert.deepEqual(saved, ['shop:1.5'], 'saved once');
    for (const s of [p, a, b]) s.close();
  });
});

test('release hostnames are resolved once and served from the cache, in both lookup forms', async () => {
  const { upstreamLookup } = await import('../src/proxy/server.ts');
  const one = await new Promise<string>((r, j) => upstreamLookup('localhost', { family: 4 }, (e, a) => (e ? j(e) : r(a as string))));
  assert.equal(one, '127.0.0.1');
  const t = performance.now();
  const all = await new Promise<{ address: string }[]>((r, j) => upstreamLookup('localhost', { family: 4, all: true }, (e, a) => (e ? j(e) : r(a as unknown as { address: string }[]))));
  assert.equal(all[0]!.address, '127.0.0.1');
  assert.ok(performance.now() - t < 5, 'answered from the cache');
});

test('view switch: a browser can look at any allowlisted release, is never counted, and can go back', async () => {
  const { createProxy, VIEW_COOKIE, ID_COOKIE } = await import('../src/proxy/server.ts');
  const { parseConfig } = await import('../src/config.ts');
  const apps = await Promise.all(['A', 'B'].map(async (name) => {
    const s = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(`${name} cookie=${req.headers.cookie ?? ''}`));
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
  }));
  const exposures: string[] = [];
  const tracked: string[] = [];
  const flags = {
    async assign(id: string, o: { recordExposure: boolean }) { if (o.recordExposure) exposures.push(id); return { variant: 'control', release: 'app:a', enrolled: true }; },
    track: (e: string) => void tracked.push(e),
  };
  const config = parseConfig({ flag: 'f', releases: { 'app:a': apps[0]!.url, 'app:b': apps[1]!.url }, guardrails: ['doc_latency_ms', 'server_error'] });
  const proxy = createProxy({ config, flags, viewSwitch: true, log: () => {}, warn: () => {} });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  try {
    const set = await fetch(`${base}/__turnout/view?release=app%3Ab`, { redirect: 'manual' });
    assert.equal(set.status, 303);
    const view = set.headers.get('set-cookie')!.split(';')[0]!;
    assert.ok(view.startsWith(`${VIEW_COOKIE}=`));
    const ua = { 'user-agent': 'Mozilla/5.0 x', accept: 'text/html' };
    const page = await (await fetch(`${base}/`, { headers: { ...ua, cookie: `${view}; ${ID_COOKIE}=11111111-1111-4111-8111-111111111111` } })).text();
    assert.match(page, /^B /, 'served the chosen release');
    assert.doesNotMatch(page, /tn_view|tn_id/, 'Turnout cookies never reach the app');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual([exposures, tracked], [[], []], 'looking is never counted');
    const receipt = (await (await fetch(`${base}/__turnout/receipt`, { headers: { cookie: view } })).json()) as { release: string; viewing: boolean; enrolled: boolean };
    assert.deepEqual([receipt.release, receipt.viewing, receipt.enrolled], ['app:b', true, false]);
    assert.equal((await fetch(`${base}/__turnout/view?release=evil`, { redirect: 'manual' })).status, 400, 'only allowlisted releases');
    const off = await fetch(`${base}/__turnout/view/off`, { redirect: 'manual' });
    assert.match(off.headers.get('set-cookie')!, /Max-Age=0/);
  } finally {
    proxy.close();
    for (const a of apps) a.s.close();
  }
});

test('view switch is off unless enabled', async () => {
  const { createProxy } = await import('../src/proxy/server.ts');
  const { parseConfig } = await import('../src/config.ts');
  const proxy = createProxy({ config: parseConfig({ flag: 'f', releases: { a: 'http://127.0.0.1:9' } }), flags: { async assign() { return { variant: 'control', release: 'a', enrolled: false }; }, track() {} }, log: () => {}, warn: () => {} });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  try {
    assert.equal((await fetch(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}/__turnout/view?release=a`, { redirect: 'manual' })).status, 404);
  } finally {
    proxy.close();
  }
});

test('page-level view (?__turnout_view=): that release for this page, uncounted, the parameter never reaches the app', async () => {
  const { createProxy, VIEW_PARAM } = await import('../src/proxy/server.ts');
  const { parseConfig } = await import('../src/config.ts');
  const app = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(`B url=${req.url}`));
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  const appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const exposures: string[] = [];
  const flags = { async assign(id: string, o: { recordExposure: boolean }) { if (o.recordExposure) exposures.push(id); return { variant: 'control', release: 'app:a', enrolled: true }; }, track() {} };
  const config = parseConfig({ flag: 'f', releases: { 'app:a': 'http://127.0.0.1:9', 'app:b': appUrl } });
  const proxy = createProxy({ config, flags, viewSwitch: true, log: () => {}, warn: () => {} });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}/?x=1&${VIEW_PARAM}=app%3Ab`, { headers: { 'user-agent': 'Mozilla/5.0 x', accept: 'text/html' } });
    assert.equal(await res.text(), 'B url=/?x=1');
    assert.equal(res.headers.get('set-cookie'), null, 'a preview never becomes a visitor');
    assert.deepEqual(exposures, []);
  } finally {
    proxy.close();
    app.close();
  }
});

test("a viewed page's assets, API calls and links follow its release (Referer), uncounted; other hosts' Referers don't", async () => {
  const { createProxy, VIEW_PARAM, refererView } = await import('../src/proxy/server.ts');
  const { parseConfig } = await import('../src/config.ts');
  const apps = await Promise.all(['A', 'B'].map(async (name) => {
    const s = http.createServer((req, res) => res.writeHead(200, { 'content-type': req.url?.endsWith('.css') ? 'text/css' : 'text/html' }).end(`${name} ${req.url}`));
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
  }));
  const exposures: string[] = [];
  const tracked: string[] = [];
  const flags = {
    async assign(id: string, o: { recordExposure: boolean }) { if (o.recordExposure) exposures.push(id); return { variant: 'control', release: 'app:a', enrolled: true }; },
    track: (e: string) => void tracked.push(e),
  };
  const config = parseConfig({ flag: 'f', releases: { 'app:a': apps[0]!.url, 'app:b': apps[1]!.url }, guardrails: ['doc_latency_ms', 'server_error'] });
  const proxy = createProxy({ config, flags, viewSwitch: true, log: () => {}, warn: () => {} });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  const base = `http://${host}`;
  const viewed = `${base}/?${VIEW_PARAM}=app%3Ab`;
  try {
    // The page's stylesheet: release B's, and no visitor cookie.
    const css = await fetch(`${base}/assets/app.css`, { headers: { 'user-agent': 'Mozilla/5.0 x', referer: viewed, 'sec-fetch-dest': 'style' } });
    assert.equal(await css.text(), 'B /assets/app.css');
    assert.equal(css.headers.get('set-cookie'), null, 'an asset of a preview never makes a visitor');
    // A link clicked on the viewed page: redirected to the same page with the view in its address.
    const link = await fetch(`${base}/products?id=2`, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 x', accept: 'text/html', 'sec-fetch-dest': 'document', referer: viewed } });
    assert.equal(link.status, 302);
    assert.equal(link.headers.get('location'), `/products?id=2&${VIEW_PARAM}=app%3Ab`);
    // A form posted from the viewed page: release B, not counted.
    const post = await fetch(`${base}/checkout`, { method: 'POST', headers: { 'user-agent': 'Mozilla/5.0 x', referer: viewed }, body: 'x=1' });
    assert.equal(await post.text(), 'B /checkout');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual([exposures, tracked], [[], []], 'nothing from a preview is counted');
    // Another site's Referer naming a view changes nothing: a normal visitor.
    const other = await fetch(`${base}/`, { headers: { 'user-agent': 'Mozilla/5.0 x', accept: 'text/html', 'sec-fetch-dest': 'document', referer: `http://evil.example/?${VIEW_PARAM}=app%3Ab` } });
    assert.equal(await other.text(), 'A /');
    assert.equal(refererView(`http://evil.example/?${VIEW_PARAM}=x`, host), undefined);
    assert.equal(refererView('not a url', host), undefined);
  } finally {
    proxy.close();
    for (const a of apps) a.s.close();
  }
});
