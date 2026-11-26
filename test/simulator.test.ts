// End to end without Flagsmith: simulated visitors → the real proxy → the real demo shop (both releases).
// Proves the conversion rule fires exactly once per real order, in both checkout flows.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { checkoutFlow, mulberry32, simulate } from '../demo/simulator/simulate.ts';
import { createShop } from '../demo/shop/server.ts';
import { parseConfig } from '../src/config.ts';
import { createProxy, type Assignment, type FlagSource } from '../src/proxy/server.ts';

const listen = (server: http.Server) =>
  new Promise<string>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
  );

class SplitFlags implements FlagSource {
  assigned = new Map<string, string>();
  exposures = 0;
  conversions = new Map<string, number>();
  private n = 0;
  private releases: Record<string, string>;

  constructor(releases: Record<string, string>) {
    this.releases = releases;
  }

  async assign(identity: string, opts: { recordExposure: boolean }): Promise<Assignment> {
    let variant = this.assigned.get(identity);
    if (!variant) {
      variant = this.n++ % 2 === 0 ? 'control' : 'v2';
      this.assigned.set(identity, variant);
    }
    if (opts.recordExposure) this.exposures++;
    return { variant, release: this.releases[variant], enrolled: true };
  }

  track(event: string, identity: string): void {
    if (event !== 'order_placed') return;
    const variant = this.assigned.get(identity)!;
    this.conversions.set(variant, (this.conversions.get(variant) ?? 0) + 1);
  }
}

const oldShop = createShop({ version: '1.4' });
const newShop = createShop({ version: '1.5' });
const newerShop = createShop({ version: '1.6' });
// Before a release: control is shop 1.4, v2 is shop 1.5.
const flags = new SplitFlags({ control: 'shop:1.4', v2: 'shop:1.5' });
// After releasing 1.5 and starting the next experiment: control is shop 1.5, v2 is shop 1.6.
const nextFlags = new SplitFlags({ control: 'shop:1.5', v2: 'shop:1.6' });
const nextTraffic: { release: string; method: string; path: string }[] = [];
let proxy: http.Server;
let nextProxy: http.Server;
let target = '';
let nextTarget = '';

before(async () => {
  const config = parseConfig({
    flag: 'shop_release',
    releases: { 'shop:1.4': await listen(oldShop), 'shop:1.5': await listen(newShop), 'shop:1.6': await listen(newerShop) },
    goal: { event: 'order_placed', when: { method: 'POST', path: '/checkout', status: '2xx' } },
    guardrails: ['doc_latency_ms', 'server_error'],
  });
  proxy = createProxy({ config, flags, debugToken: '1', log: () => {}, warn: () => {} });
  target = await listen(proxy);
  nextProxy = createProxy({ config, flags: nextFlags, onTraffic: (e) => nextTraffic.push(e), debugToken: '1', log: () => {}, warn: () => {} });
  nextTarget = await listen(nextProxy);
});

after(() => {
  for (const s of [proxy, nextProxy, oldShop, newShop, newerShop]) s.close();
});

test('the checkout flow follows the release, not the variant key', () => {
  assert.equal(checkoutFlow('shop:1.4'), 'multi-step');
  assert.equal(checkoutFlow('shop:1.5'), 'one-page');
  assert.equal(checkoutFlow('shop:1.6'), 'one-page');
});

test('concurrent visitors keep the true rates apart (one stream per visitor)', async () => {
  // With one generator shared by 20 concurrent visitors, 20% vs 60% came out near 40% each.
  const report = await simulate({ target, visitors: 600, rates: { control: 0.2, v2: 0.6 }, concurrency: 20, seed: 3, log: () => {} });
  const rate = (k: string) => report.byVariant[k]!.orders / report.byVariant[k]!.visitors;
  assert.ok(rate('v2') - rate('control') > 0.25, `control ${rate('control').toFixed(2)}, v2 ${rate('v2').toFixed(2)}`);
  await new Promise((r) => setTimeout(r, 50));
  flags.conversions.clear(); // the shared fake's counters belong to the next test
  flags.exposures = 0;
});

test('the seeded PRNG is repeatable', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});

test('every simulated order is counted once, as order_placed, for the release that took it', async () => {
  const report = await simulate({
    target,
    visitors: 60,
    rates: { control: 0.5, v2: 0.5 },
    concurrency: 6,
    seed: 7,
    log: () => {},
  });
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(report.failedOrders, 0);
  assert.equal(report.byVariant.control!.visitors + report.byVariant.v2!.visitors, 60);
  assert.deepEqual(report.byRelease['shop:1.4'], report.byVariant.control);
  assert.deepEqual(report.byRelease['shop:1.5'], report.byVariant.v2);
  assert.ok(report.byVariant.control!.orders > 0, 'shop 1.4 multi-step checkout placed orders');
  assert.ok(report.byVariant.v2!.orders > 0, 'shop 1.5 one-page checkout placed orders');
  assert.equal(flags.conversions.get('control'), report.byVariant.control!.orders);
  assert.equal(flags.conversions.get('v2'), report.byVariant.v2!.orders);
  assert.ok(flags.exposures >= 60, 'every landing page records an exposure');
});

test('a rate of 0 places no orders', async () => {
  const report = await simulate({ target, visitors: 10, rates: { control: 0, v2: 0 }, concurrency: 2, seed: 1, log: () => {} });
  assert.equal((report.byVariant.control?.orders ?? 0) + (report.byVariant.v2?.orders ?? 0), 0);
});

test('after a release, control on shop 1.5 checks out on one page and v2 on shop 1.6 too', async () => {
  const report = await simulate({
    target: nextTarget,
    visitors: 40,
    rates: { control: 0.6, v2: 0.6 },
    concurrency: 4,
    seed: 11,
    log: () => {},
  });
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(report.failedOrders, 0);
  assert.deepEqual(Object.keys(report.byRelease).sort(), ['shop:1.5', 'shop:1.6']);
  assert.deepEqual(report.byRelease['shop:1.5'], report.byVariant.control);
  assert.deepEqual(report.byRelease['shop:1.6'], report.byVariant.v2);
  assert.ok(report.byVariant.control!.orders > 0 && report.byVariant.v2!.orders > 0);
  assert.equal(nextFlags.conversions.get('control'), report.byVariant.control!.orders);
  assert.equal(nextFlags.conversions.get('v2'), report.byVariant.v2!.orders);
  // No visitor walked the 1.4 multi-step flow on a one-page release.
  assert.equal(nextTraffic.filter((e) => e.path.startsWith('/checkout/')).length, 0);
  assert.ok(nextTraffic.some((e) => e.method === 'POST' && e.path === '/checkout'));
});

test('the goal flow: any app, land on / and send the goal request; a conversion is a status the rule accepts', async () => {
  const { createServer } = await import('node:http');
  const { simulate: run, goalPath } = await import('../demo/simulator/simulate.ts');
  const seen: string[] = [];
  let n = 0;
  const app = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.method === 'GET') {
      const variant = Math.floor(n++ / 2) % 2 ? 'v2' : 'control'; // two page views per visitor
      res.writeHead(200, { 'x-turnout-variant': variant, 'x-turnout-release': variant === 'v2' ? 'landing:2' : 'landing:1' });
      return res.end('ok');
    }
    res.writeHead(req.url === '/signup' ? 201 : 404).end();
  });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  const port = (app.address() as { port: number }).port;
  try {
    const report = await run({ target: `http://127.0.0.1:${port}`, visitors: 40, rates: { control: 0, v2: 1 }, concurrency: 1, seed: 1, goal: { method: 'POST', path: '/signup', status: '2xx' }, log: () => {} });
    assert.equal(report.byVariant.control!.orders, 0);
    assert.equal(report.byVariant.v2!.orders, 20);
    assert.equal(report.byRelease['landing:2']!.orders, 20);
    assert.equal(report.failedOrders, 0);
    assert.equal(seen.filter((s) => s === 'POST /signup').length, 20);
    assert.equal(seen.filter((s) => s === 'GET /').length, 80, 'each visitor comes back once, so the proxy records the exposure');
    assert.ok(!seen.some((s) => s.includes('/product') || s.includes('/checkout')), 'no shop pages');
  } finally {
    app.close();
  }
  assert.equal(goalPath('/fix/*'), '/fix/simulated');
});

test('funnel: add-to-cart is level across variants; the order rate decides', async () => {
  const report = await simulate({ target, visitors: 600, rates: { control: 0.1, v2: 0.2 }, cartRate: 0.3, concurrency: 20, seed: 11, log: () => {} });
  await new Promise((r) => setTimeout(r, 50));
  const rate = (k: string, f: 'carts' | 'orders') => report.byVariant[k]![f] / report.byVariant[k]!.visitors;
  assert.ok(Math.abs(rate('v2', 'carts') - rate('control', 'carts')) < 0.1, `carts ${rate('control', 'carts')} vs ${rate('v2', 'carts')}`);
  assert.ok(rate('v2', 'orders') > rate('control', 'orders'), 'v2 completes more checkouts');
  for (const k of ['control', 'v2']) assert.ok(report.byVariant[k]!.orders <= report.byVariant[k]!.carts);
  flags.conversions.clear();
  flags.exposures = 0;
});
