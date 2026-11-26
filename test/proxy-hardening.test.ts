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

test("hop-by-hop headers and Switchyard's cookies never reach the app or the visitor", async () => {
  const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const res = await fetch(`${base}/echo`, {
    headers: { cookie: `${ID_COOKIE}=${id}; app=1; sy_preview=x`, 'x-switchyard-debug': 'dbg', 'proxy-authorization': 'Basic x' },
  });
  const seen = (await res.json()) as Record<string, string>;
  assert.equal(seen.cookie, 'app=1');
  assert.equal(seen['proxy-authorization'], undefined);
  assert.equal(seen['x-switchyard-debug'], undefined);
  assert.equal(seen['x-forwarded-proto'], 'http');
  assert.equal(res.headers.get('x-secret'), null, 'headers named in Connection are stripped');
  assert.notEqual(res.headers.get('keep-alive'), 'timeout=99', "the app's keep-alive is its own connection's");
});

test('without a debug token, the variant headers are never sent', async () => {
  const res = await fetch(`${base}/`, { headers: { accept: 'text/html', 'x-switchyard-debug': '1' } });
  assert.equal(res.headers.get('x-switchyard-variant'), null);
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

test('/__switchyard/health reports the live release', async () => {
  const health = (await (await fetch(`${base}/__switchyard/health`)).json()) as { ok: boolean; liveRelease: string };
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
