import assert from 'node:assert/strict';
import { settle } from './settle.ts';
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
    metrics: [{ event: 'add_to_cart', when: { method: 'POST', path: '/cart/add', status: '2xx,303' } }],
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
  await settle(flags);

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
  await settle(flags);
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
  assert.equal(plain.headers.get('x-turnout-variant'), null);
  const debug = await fetch(`${base}/`, { headers: { accept: 'text/html', cookie: `${ID_COOKIE}=${id}`, 'x-turnout-debug': 'dbg' } });
  assert.equal(debug.headers.get('x-turnout-variant'), 'v2');
  assert.equal(debug.headers.get('x-turnout-enrolled'), 'true');
});

test('/__turnout/receipt answers from the proxy, never the app, and records no exposure', async () => {
  const id = '66666666-6666-4666-8666-666666666666';
  flags.variants.set(id, 'v2');
  const before = flags.exposures.length;
  const res = await fetch(`${base}/__turnout/receipt`, { headers: { cookie: `${ID_COOKIE}=${id}` } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { variant: 'v2', release: 'shop:1.5', enrolled: true, receipt: null });
  assert.equal(flags.exposures.length, before);
  const first = await fetch(`${base}/__turnout/receipt`); // no cookie yet: 200, no visitor (no red error on a first load)
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { visitor: null, variant: null, release: null, enrolled: false, receipt: null });
  assert.equal((await fetch(`${base}/__turnout/anything`)).status, 404);
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
  const wrong = await fetch(`${base}/__turnout/preview?token=nope`, { redirect: 'manual' });
  assert.equal(wrong.status, 403);

  const join = await fetch(`${base}/__turnout/preview?token=tok123`, { redirect: 'manual' });
  assert.equal(join.status, 303);
  const cookie = join.headers.get('set-cookie') ?? '';
  assert.match(cookie, /^tn_preview=[A-Za-z0-9_-]{43}; Path=\/; .*HttpOnly/);
  assert.ok(!cookie.includes('tok123'), 'the cookie holds a MAC, never the token');
  const mark = cookie.split(';')[0]!;

  const id = '88888888-8888-4888-8888-888888888888';
  await page(`${ID_COOKIE}=${id}; ${mark}`);
  assert.deepEqual(flags.traits.get(id), { preview: 'true' });
  await page(`${ID_COOKIE}=${id}; tn_preview=tok123`);
  assert.equal(flags.traits.get(id), undefined, 'the raw token is not accepted as a cookie');
  await fetch(`${base}/__turnout/receipt`, { headers: { cookie: `${ID_COOKIE}=${id}; ${mark}` } });
  assert.deepEqual(flags.traits.get(id), { preview: 'true' }, 'the receipt reports what the pages serve');

  const leave = await fetch(`${base}/__turnout/preview/off`, { redirect: 'manual' });
  assert.match(leave.headers.get('set-cookie') ?? '', /^tn_preview=; .*Max-Age=0/);
});

test('a secondary metric (add_to_cart) is tracked from its HTTP rule, and is not a conversion', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  flags.tracked = [];
  await page(`${ID_COOKIE}=${id}`);
  await fetch(`${base}/cart/add`, { method: 'POST', headers: { cookie: `${ID_COOKIE}=${id}` } });
  await settle(flags);
  assert.ok(flags.tracked.some((t) => t.event === 'add_to_cart' && t.identity === id));
  assert.ok(!flags.tracked.some((t) => t.event === 'order_placed'));
});

test('the release request header reaches the app only for preview browsers and debug requests, never from a client', async () => {
  const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const echo = async (headers: Record<string, string>) =>
    (await (await fetch(`${base}/echo`, { headers: { cookie: `${ID_COOKIE}=${id}`, ...headers } })).json()) as Record<string, string>;
  assert.equal((await echo({}))['x-turnout-release'], undefined);
  assert.equal((await echo({ 'x-turnout-release': 'spoofed' }))['x-turnout-release'], undefined, 'a client copy is stripped');
  assert.equal((await echo({ 'x-turnout-debug': 'dbg' }))['x-turnout-release'], 'shop:1.4');
  const join = await fetch(`${base}/__turnout/preview?token=tok123`, { redirect: 'manual' });
  const mark = (join.headers.get('set-cookie') ?? '').split(';')[0]!;
  const res = await fetch(`${base}/echo`, { headers: { cookie: `${ID_COOKIE}=${id}; ${mark}` } });
  assert.equal(((await res.json()) as Record<string, string>)['x-turnout-release'], 'shop:1.4');
});

test('every proxied request reaches the traffic feed', () => {
  assert.ok(traffic.some((e) => e.variant === 'v2' && e.document));
  assert.ok(traffic.some((e) => e.converted && e.status === 201));
});

test('the health endpoint probes each release container only for the debug token', async () => {
  const plain: any = await (await fetch(`${base}/__turnout/health`)).json();
  assert.equal(plain.ok, true);
  assert.equal(plain.upstreams, undefined, 'a public request never fans out to the apps');
  const wrong: any = await (await fetch(`${base}/__turnout/health`, { headers: { 'x-turnout-debug': 'nope' } })).json();
  assert.equal(wrong.upstreams, undefined);

  const res = await fetch(`${base}/__turnout/health`, { headers: { 'x-turnout-debug': 'dbg' } });
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
    const body: any = await (await fetch(`${pBase}/__turnout/health`, { headers: { 'x-turnout-debug': 'dbg' } })).json();
    assert.equal(body.upstreams['shop:1.4'].ok, false);
    assert.equal(body.upstreams['shop:1.4'].error, 'ECONNREFUSED');
  } finally {
    p.close();
  }
});

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';

test("a browser's first page load is routed and counted, so a one-page visit (a bounce) is in the data", async () => {
  flags.tracked = [];
  const res = await fetch(`${base}/`, { headers: { accept: 'text/html', 'user-agent': BROWSER_UA } });
  await res.text();
  await settle(flags);
  const id = (res.headers.get('set-cookie') ?? '').match(new RegExp(`${ID_COOKIE}=([0-9a-f-]{36})`))?.[1];
  assert.ok(id, 'the first response sets the ID cookie');
  assert.ok(flags.exposures.includes(id), 'exposure recorded on the first page load');
  assert.ok(flags.tracked.some((t) => t.event === 'doc_latency_ms' && t.identity === id), 'first page counts for the guardrail');
  // The same visitor coming back keeps the same identity (the cookie from the first response).
  await (await page(`${ID_COOKIE}=${id}`)).text();
  assert.equal(flags.exposures.filter((e) => e === id).length, 2);
});

test('without the cookie, API calls, assets and non-browser clients never become identities', async () => {
  const before = flags.exposures.length;
  flags.tracked = [];
  await (await fetch(`${base}/checkout`, { method: 'POST', headers: { 'user-agent': BROWSER_UA } })).text();
  await (await fetch(`${base}/app.js`, { headers: { 'user-agent': BROWSER_UA } })).text();
  await (await fetch(`${base}/`, { headers: { accept: 'text/html', 'user-agent': 'node' } })).text();
  await settle(flags);
  assert.equal(flags.exposures.length, before);
  assert.equal(flags.tracked.length, 0);
});

test("Turnout's own check (debug token, no cookie) never counts; a simulated visitor counts from its first page", async () => {
  const headers = { accept: 'text/html', 'sec-fetch-dest': 'document', 'user-agent': 'Mozilla/5.0 TurnoutSimulatedVisitor/1.0', 'x-turnout-debug': 'dbg' };
  const before = flags.exposures.length;
  await (await fetch(`${base}/`, { headers })).text();
  assert.equal(flags.exposures.length, before, 'a probe is not a visitor');
  await (await fetch(`${base}/`, { headers: { ...headers, 'x-turnout-visitor': '1' } })).text();
  assert.equal(flags.exposures.length, before + 1, 'a one-page simulated visit is in the data');
});

test('the click script: added to pages only when asked for, and clicks reported by label', async () => {
  const http = await import('node:http');
  const { createProxy, CLICK_SCRIPT } = await import('../src/proxy/server.ts');
  const { parseConfig } = await import('../src/config.ts');
  const app = http.createServer((_q, r) => r.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Hi</h1>'));
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const appUrl = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const clicks: unknown[] = [];
  const flags = { assign: async () => ({ variant: 'control', release: 'v1', enrolled: false }), track: () => {}, ready: () => true };
  const config = parseConfig({ flag: 'f', releases: { v1: appUrl }, guardrails: [] });
  const proxy = createProxy({ config, flags, onClick: (c: unknown) => clicks.push(c) } as never);
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  try {
    const page = await (await fetch(`${base}/`, { headers: { accept: 'text/html' } })).text();
    assert.match(page, /<h1>Hi<\/h1><script src="\/__turnout\/clicks.js" defer><\/script>$/);
    assert.equal(await (await fetch(`${base}/__turnout/clicks.js`)).text(), CLICK_SCRIPT);
    const sent = await fetch(`${base}/__turnout/click`, { method: 'POST', body: JSON.stringify({ kind: 'button', label: 'Sign up', target: '' }) });
    assert.equal(sent.status, 204);
    assert.equal((clicks[0] as { label: string }).label, 'Sign up');
    assert.doesNotMatch(CLICK_SCRIPT, /\.value\b(?!\s*\|\|)/); // a button's own value as its label, never a field's
    // A counted visitor's click carries the version they were served.
    const visit = await fetch(`${base}/`, { headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 Chrome/120' } });
    const cookie = (visit.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    assert.ok(cookie);
    await fetch(`${base}/__turnout/click`, { method: 'POST', headers: { cookie }, body: JSON.stringify({ kind: 'link', label: 'Pricing', target: '/pricing' }) });
    assert.equal((clicks[1] as { release: string }).release, 'v1');
  } finally {
    proxy.close();
    app.close();
  }
});

test('a GET whose connection the app resets is sent once more, not answered 502', async () => {
  const { createProxy } = await import('../src/proxy/server.ts');
  let n = 0;
  const app = http.createServer((q, r) => (++n === 1 ? q.socket.destroy() : r.writeHead(200, { 'content-type': 'text/plain' }).end('ok')));
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const flags = { assign: async () => ({ variant: 'control', release: 'v1', enrolled: false }), track: () => {}, ready: () => true };
  const proxy = createProxy({ config: parseConfig({ flag: 'f', releases: { v1: appUrl }, guardrails: [] }), flags } as never);
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
  try {
    const res = await fetch(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}/`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
    assert.equal(n, 2);
  } finally {
    proxy.close();
    app.close();
  }
});
