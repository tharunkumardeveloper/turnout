import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { createProxy, type Assignment, type FlagSource } from '../src/proxy/server.ts';
import { goalRequest, pageLinks, SIM_USER_AGENT, simulateAny } from '../src/commands/simulate-any.ts';

test('page links: same-origin pages only, no assets or Turnout paths', () => {
  assert.deepEqual(pageLinks('<a href="/about">a</a><a href="/pricing?x=1">p</a><link href="/app.css"><a href="//evil.example/x">e</a><a href="https://x.y/">x</a><a href="/__turnout/receipt">r</a><a href="/about">dup</a>'), ['/about', '/pricing']);
  assert.deepEqual(goalRequest({ method: 'POST', path: '/api/orders/*', status: '2xx' }), { method: 'POST', path: '/api/orders/1' });
});

test('simulated visitors go through a real proxy, follow links, and make the goal request at the hidden rates', async () => {
  const seen: { ua: string; method: string; path: string }[] = [];
  const app = http.createServer((req, res) => {
    seen.push({ ua: String(req.headers['user-agent']), method: req.method!, path: req.url! });
    if (req.method === 'POST') return void res.writeHead(303, { location: '/' }).end();
    res.writeHead(200, { 'content-type': 'text/html' }).end('<a href="/about">about</a> <a href="/pricing">pricing</a>');
  });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  const appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  let n = 0;
  const seenIds = new Map<string, number>();
  const flags: FlagSource = {
    async assign(identity): Promise<Assignment> {
      // Like Flagsmith: the same identity gets the same version every time; new identities take turns.
      if (!seenIds.has(identity)) seenIds.set(identity, n++ % 2);
      return seenIds.get(identity) ? { variant: 'v2', release: 'app:2', enrolled: true } : { variant: 'control', release: 'app:1', enrolled: true };
    },
    track: () => {},
  };
  const config = parseConfig({ flag: 'f', releases: { 'app:1': appUrl, 'app:2': appUrl }, goal: { event: 'signup', when: { method: 'POST', path: '/signup', status: '2xx,303' } } });
  const proxy = createProxy({ config, flags, debugToken: 'dbg', log: () => {}, warn: () => {} });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  try {
    const truth = { experimentId: 0, control: 'app:1', v2: 'app:2', scenario: 'new-better' as const, rates: { control: 0, v2: 1 }, slow: false };
    const report = await simulateAny({
      target: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
      visitors: 20, concurrency: 4, releases: ['app:1', 'app:2'], goal: config.goal.when, debugToken: 'dbg', truth,
    });
    const total = Object.values(report.byRelease).reduce((s, r) => s + r.visitors, 0);
    assert.equal(total, 20);
    assert.ok((report.byRelease['app:2']?.goals ?? 0) > 0, 'v2 converts at rate 1');
    assert.equal(report.byRelease['app:1']?.goals ?? 0, 0, 'control converts at rate 0');
    assert.ok(seen.some((r) => r.path === '/about' || r.path === '/pricing'), 'followed a link');
    assert.ok(seen.every((r) => r.ua === SIM_USER_AGENT), 'every request is labelled simulated');
    assert.equal(seen.filter((r) => r.method === 'POST').length, report.byRelease['app:2']!.goals);
  } finally {
    proxy.close();
    app.close();
  }
});

test('forms: method, action resolved against the page, named fields; filled with made-up values a person would type', async () => {
  const { pageForms, fillForm, pickRates } = await import('../src/commands/simulate-any.ts');
  const html = `<form method="post" action="signup"><input type="hidden" name="csrf" value="tok&amp;1"><input name="email" type="email">
    <input name="full_name"><input type="password" name="pw"><select name="plan"><option value="">Pick</option><option value="pro">Pro</option></select>
    <input type="checkbox" name="terms"><input type="submit" name="go" value="Sign up"><textarea name="note"></textarea></form><form><input name="q"></form>`;
  const [signup, search] = pageForms(html, '/join/');
  assert.equal(signup!.method, 'POST');
  assert.equal(signup!.action, '/join/signup');
  assert.deepEqual(signup!.fields.map((f) => f.name), ['csrf', 'email', 'full_name', 'pw', 'terms', 'plan', 'note'], 'no submit button');
  assert.deepEqual([search!.method, search!.action], ['GET', '/join/']);
  const body = fillForm(signup!, 7);
  assert.equal(body.get('csrf'), 'tok&1', 'hidden fields kept');
  assert.equal(body.get('email'), 'sim-visitor-7@example.test');
  assert.equal(body.get('full_name'), 'Sim Visitor');
  assert.equal(body.get('pw'), 'Turnout-sim-123!');
  assert.equal(body.get('plan'), 'pro', 'the first real option');
  assert.equal(body.get('terms'), 'on');
  const rates = pickRates(['a', 'b', 'c'], () => 0.5);
  assert.deepEqual(Object.keys(rates), ['a', 'b', 'c']);
  assert.ok(rates.a! >= 0.08 && rates.a! <= 0.12);
});

test('an A/B/C run: visitors fill in the form that posts to the goal, at each version\'s hidden rate; some bounce', async () => {
  const posts: string[] = [];
  const app = http.createServer((req, res) => {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c)).on('end', () => {
        posts.push(body);
        res.writeHead(303, { location: '/thanks' }).end();
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(req.url === '/'
      ? '<a href="/pricing">pricing</a><a href="/join">join</a>'
      : '<a href="/">home</a><form method="post" action="/signup"><input name="email" type="email"><input type="hidden" name="src" value="join"></form>');
  });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  const appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  let n = 0;
  const seenIds = new Map<string, number>();
  const arms = [['control', 'app:1'], ['v2', 'app:2'], ['v3', 'app:3']] as const;
  const flags: FlagSource = { async assign(identity): Promise<Assignment> { if (!seenIds.has(identity)) seenIds.set(identity, n++ % 3); const [variant, release] = arms[seenIds.get(identity)!]!; return { variant, release, enrolled: true }; }, track: () => {} };
  const config = parseConfig({ flag: 'f', releases: { 'app:1': appUrl, 'app:2': appUrl, 'app:3': appUrl }, goal: { event: 'signup', when: { method: 'POST', path: '/signup', status: '2xx,303' } } });
  const proxy = createProxy({ config, flags, debugToken: 'dbg', log: () => {}, warn: () => {} });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  try {
    const report = await simulateAny({
      target: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
      visitors: 60, concurrency: 6, releases: ['app:1', 'app:2', 'app:3'], goal: config.goal.when, debugToken: 'dbg',
      rates: { 'app:1': 0, 'app:2': 1, 'app:3': 1 },
    });
    assert.deepEqual(Object.keys(report.byRelease).sort(), ['app:1', 'app:2', 'app:3']);
    assert.equal(report.byRelease['app:1']!.goals, 0);
    assert.ok(report.byRelease['app:2']!.goals > 0 && report.byRelease['app:3']!.goals > 0);
    assert.ok(Object.values(report.byRelease).some((r) => r.forms > 0), 'some goals were a filled-in form');
    assert.ok(posts.some((b) => /email=sim-visitor-\d+%40example\.test/.test(b) && /src=join/.test(b)), 'the form was filled in and its hidden field kept');
    assert.ok(Object.values(report.byRelease).reduce((s, r) => s + r.bounces, 0) > 0, 'some visitors left after one page');
    assert.equal(report.spa, false);
  } finally {
    proxy.close();
    app.close();
  }
});

test('a GET goal (GET /product/*): browsing never opens a goal page, only converting does, through one of the real links', async () => {
  const gets: string[] = [];
  const app = http.createServer((req, res) => {
    gets.push(req.url!);
    res.writeHead(200, { 'content-type': 'text/html' }).end('<a href="/about">a</a><a href="/product/silk-saree">p</a><a href="/product/brass-thali">q</a>');
  });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  const appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  let n = 0;
  const seenIds = new Map<string, number>();
  const flags: FlagSource = { async assign(identity): Promise<Assignment> { if (!seenIds.has(identity)) seenIds.set(identity, n++ % 2); return seenIds.get(identity) ? { variant: 'v2', release: 'b', enrolled: true } : { variant: 'control', release: 'a', enrolled: true }; }, track: () => {} };
  const config = parseConfig({ flag: 'f', releases: { a: appUrl, b: appUrl }, goal: { event: 'product_view', when: { method: 'GET', path: '/product/*', status: '2xx' } } });
  const proxy = createProxy({ config, flags, debugToken: 'dbg', log: () => {}, warn: () => {} });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  try {
    const report = await simulateAny({ target: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, visitors: 40, concurrency: 4, releases: ['a', 'b'], goal: config.goal.when, debugToken: 'dbg', rates: { a: 0, b: 1 } });
    const productViews = gets.filter((u) => u.startsWith('/product/')).length;
    assert.equal(productViews, report.byRelease.b!.goals, 'every product view is a conversion, none from browsing');
    assert.equal(report.byRelease.a!.goals, 0);
    assert.ok(gets.includes('/product/silk-saree') || gets.includes('/product/brass-thali'), 'a real product link, not a made-up path');
    assert.ok(!gets.includes('/product/1'));
  } finally {
    proxy.close();
    app.close();
  }
});
