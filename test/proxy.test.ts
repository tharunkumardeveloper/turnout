import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { createProxy, ID_COOKIE, type Assignment, type FlagSource, type TrafficEvent } from '../src/proxy/server.ts';

const RELEASE: Record<string, string> = { control: 'shop:1.4', v2: 'shop:1.5' };
type Tracked = { event: string; identity: string; value?: number };

class FakeFlags implements FlagSource {
  variants = new Map<string, string>();
  releases = new Map<string, string>(); // overrides the flag value a visitor gets
  exposures: string[] = [];
  tracked: Tracked[] = [];
  failing = false;

  traits = new Map<string, Record<string, string> | undefined>();

  async assign(identity: string, opts: { recordExposure: boolean; traits?: Record<string, string> }): Promise<Assignment> {
    this.traits.set(identity, opts.traits);
    if (this.failing) throw new Error('flagsmith down');
    const variant = this.variants.get(identity) ?? 'control';
    if (opts.recordExposure) this.exposures.push(identity);
    return { variant, release: this.releases.get(identity) ?? RELEASE[variant], enrolled: true };
  }

  track(event: string, identity: string, value?: number): void {
    this.tracked.push(value === undefined ? { event, identity } : { event, identity, value });
  }
}

function upstream(name: string): http.Server {
  return http.createServer((req, res) => {
    if (req.url === '/boom') {
      res.writeHead(500).end();
      return;
    }
    if (req.url === '/echo') {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'x-secret', 'x-secret': 'hop', 'keep-alive': 'timeout=5' });
      res.end(JSON.stringify(req.headers));
      return;
    }
    if (req.url === '/redir') {
      res.writeHead(302, { location: `http://${req.headers.host}/next?a=1` }).end();
      return;
    }
    if (req.url === '/slow') return; // never answers
    const status = req.method === 'POST' && req.url === '/checkout' ? 201 : 200;
    res.writeHead(status, { 'content-type': 'text/html', 'cache-control': 'public, max-age=60' });
    res.end(name);
  });
}

const listen = (server: http.Server) =>
  new Promise<string>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
  );

const oldShop = upstream('shop 1.4');
const newShop = upstream('shop 1.5');
const flags = new FakeFlags();
const traffic: TrafficEvent[] = [];
let proxy: http.Server;
let base = '';

before(async () => {
  const config = parseConfig({
    flag: 'shop_release',
    releases: { 'shop:1.4': await listen(oldShop), 'shop:1.5': await listen(newShop) },
    goal: { event: 'order_placed', when: { method: 'POST', path: '/checkout', status: '2xx' } },
    guardrails: ['doc_latency_ms', 'server_error'],
  });
  proxy = createProxy({
    config,
    flags,
    onTraffic: (e) => traffic.push(e),
    previewToken: 'tok123',
    debugToken: 'dbg',
    upstreamTimeoutMs: 300,
    log: () => {},
    warn: () => {},
  });
  base = await listen(proxy);
});

after(() => {
  for (const s of [proxy, oldShop, newShop]) s.close();
});

const page = (cookie?: string) =>
  fetch(`${base}/`, { headers: { accept: 'text/html', ...(cookie ? { cookie } : {}) } });

test('a new visitor gets an ID cookie and control', async () => {
  const res = await page();
  assert.equal(await res.text(), 'shop 1.4');
  assert.match(res.headers.get('set-cookie') ?? '', new RegExp(`^${ID_COOKIE}=[0-9a-f-]{36}; Path=/`));
  assert.match(res.headers.get('cache-control') ?? '', /^private/);
  assert.match(res.headers.get('vary') ?? '', /Cookie/);
});

test('routes by the variant Flagsmith assigns, and keeps the cookie', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  flags.variants.set(id, 'v2');
  const res = await page(`${ID_COOKIE}=${id}`);
  assert.equal(await res.text(), 'shop 1.5');
  assert.equal(res.headers.get('set-cookie'), null);
  assert.ok(flags.exposures.includes(id));
});

test('records conversions, latency and errors for the right identity', async () => {
  const id = '22222222-2222-4222-8222-222222222222';
  flags.tracked = [];
  await page(`${ID_COOKIE}=${id}`);
  await fetch(`${base}/checkout`, { method: 'POST', headers: { cookie: `${ID_COOKIE}=${id}` } });
  await fetch(`${base}/boom`, { headers: { accept: 'text/html', cookie: `${ID_COOKIE}=${id}` } });
  await new Promise((r) => setTimeout(r, 20));

  const names = flags.tracked.map((t) => `${t.event}:${t.value ?? ''}`);
  assert.ok(names.includes('order_placed:'));
  assert.ok(names.includes('server_error:0'));
  assert.ok(names.includes('server_error:1'));
  assert.ok(flags.tracked.some((t) => t.event === 'doc_latency_ms' && typeof t.value === 'number'));
  assert.ok(flags.tracked.every((t) => t.identity === id));
});

test('assets and API calls are routed but record no exposure', async () => {
  const id = '33333333-3333-4333-8333-333333333333';
  await fetch(`${base}/app.js`, { headers: { cookie: `${ID_COOKIE}=${id}` } });
  assert.ok(!flags.exposures.includes(id));
});

test('bots get control and are never tracked', async () => {
  flags.tracked = [];
  const res = await fetch(`${base}/`, { headers: { accept: 'text/html', 'user-agent': 'Googlebot/2.1' } });
  assert.equal(await res.text(), 'shop 1.4');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(flags.tracked.length, 0);
});

test('if Flagsmith fails, visitors get control', async () => {
  flags.failing = true;
  const id = '44444444-4444-4444-8444-444444444444';
  flags.variants.set(id, 'v2');
  const res = await page(`${ID_COOKIE}=${id}`);
  assert.equal(await res.text(), 'shop 1.4');
  flags.failing = false;
});

test('reports the variant only when asked to debug', async () => {
  const id = '55555555-5555-4555-8555-555555555555';
  flags.variants.set(id, 'v2');
  const plain = await page(`${ID_COOKIE}=${id}`);
  assert.equal(plain.headers.get('x-switchyard-variant'), null);
  const debug = await fetch(`${base}/`, { headers: { accept: 'text/html', cookie: `${ID_COOKIE}=${id}`, 'x-switchyard-debug': 'dbg' } });
  assert.equal(debug.headers.get('x-switchyard-variant'), 'v2');
  assert.equal(debug.headers.get('x-switchyard-enrolled'), 'true');
});

test('/__switchyard/receipt answers from the proxy, never the app, and records no exposure', async () => {
  const id = '66666666-6666-4666-8666-666666666666';
  flags.variants.set(id, 'v2');
  const before = flags.exposures.length;
  const res = await fetch(`${base}/__switchyard/receipt`, { headers: { cookie: `${ID_COOKIE}=${id}` } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { variant: 'v2', release: 'shop:1.5', enrolled: true, receipt: null });
  assert.equal(flags.exposures.length, before);
  assert.equal((await fetch(`${base}/__switchyard/receipt`)).status, 404); // no cookie yet
  assert.equal((await fetch(`${base}/__switchyard/anything`)).status, 404);
});

test('a flag value outside the allowlist only ever reaches the fallback release', async () => {
  for (const value of ['http://attacker.example', 'shop:9.9', '']) {
    const id = '77777777-7777-4777-8777-77777777777' + String(value.length % 10);
    flags.variants.set(id, 'v2');
    flags.releases.set(id, value);
    assert.equal(await (await page(`${ID_COOKIE}=${id}`)).text(), 'shop 1.4', `value "${value}"`);
  }
});

test('a preview link puts the browser in the preview segment; a wrong token does not', async () => {
  const wrong = await fetch(`${base}/__switchyard/preview?token=nope`, { redirect: 'manual' });
  assert.equal(wrong.status, 403);

  const join = await fetch(`${base}/__switchyard/preview?token=tok123`, { redirect: 'manual' });
  assert.equal(join.status, 303);
  const cookie = join.headers.get('set-cookie') ?? '';
  assert.match(cookie, /^sy_preview=[A-Za-z0-9_-]{43}; Path=\/; .*HttpOnly/);
  assert.ok(!cookie.includes('tok123'), 'the cookie holds a MAC, never the token');
  const mark = cookie.split(';')[0]!;

  const id = '88888888-8888-4888-8888-888888888888';
  await page(`${ID_COOKIE}=${id}; ${mark}`);
  assert.deepEqual(flags.traits.get(id), { preview: 'true' });
  await page(`${ID_COOKIE}=${id}; sy_preview=tok123`);
  assert.equal(flags.traits.get(id), undefined, 'the raw token is not accepted as a cookie');
  await fetch(`${base}/__switchyard/receipt`, { headers: { cookie: `${ID_COOKIE}=${id}; ${mark}` } });
  assert.deepEqual(flags.traits.get(id), { preview: 'true' }, 'the receipt reports what the pages serve');

  const leave = await fetch(`${base}/__switchyard/preview/off`, { redirect: 'manual' });
  assert.match(leave.headers.get('set-cookie') ?? '', /^sy_preview=; .*Max-Age=0/);
});

test('every proxied request reaches the traffic feed', () => {
  assert.ok(traffic.some((e) => e.variant === 'v2' && e.document));
  assert.ok(traffic.some((e) => e.converted && e.status === 201));
});

test('the health endpoint probes each release container only for the debug token', async () => {
  const plain: any = await (await fetch(`${base}/__switchyard/health`)).json();
  assert.equal(plain.ok, true);
  assert.equal(plain.upstreams, undefined, 'a public request never fans out to the apps');
  const wrong: any = await (await fetch(`${base}/__switchyard/health`, { headers: { 'x-switchyard-debug': 'nope' } })).json();
  assert.equal(wrong.upstreams, undefined);

  const res = await fetch(`${base}/__switchyard/health`, { headers: { 'x-switchyard-debug': 'dbg' } });
  const body: any = await res.json();
  assert.deepEqual(Object.keys(body.upstreams).sort(), ['shop:1.4', 'shop:1.5']);
  for (const probe of Object.values(body.upstreams) as { ok: boolean; status: number; ms: number }[]) {
    assert.equal(probe.ok, true);
    assert.equal(probe.status, 200);
    assert.equal(typeof probe.ms, 'number');
  }
});

test('a release container that is down is reported, not thrown', async () => {
  const down = http.createServer();
  const url = await listen(down);
  down.close();
  const config = parseConfig({
    flag: 'shop_release',
    releases: { 'shop:1.4': url },
    goal: { event: 'order_placed', when: { method: 'POST', path: '/checkout', status: '2xx' } },
  });
  const p = createProxy({ config, flags, debugToken: 'dbg', log: () => {}, warn: () => {} });
  const pBase = await listen(p);
  try {
    const body: any = await (await fetch(`${pBase}/__switchyard/health`, { headers: { 'x-switchyard-debug': 'dbg' } })).json();
    assert.equal(body.upstreams['shop:1.4'].ok, false);
    assert.equal(body.upstreams['shop:1.4'].error, 'ECONNREFUSED');
  } finally {
    p.close();
  }
});
