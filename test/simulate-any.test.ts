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
  const flags: FlagSource = {
    async assign(): Promise<Assignment> {
      return n++ % 2 ? { variant: 'v2', release: 'app:2', enrolled: true } : { variant: 'control', release: 'app:1', enrolled: true };
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
