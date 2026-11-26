import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { createProxy, ID_COOKIE, MAX_HEADER_EVENTS, parseEventHeader, type Assignment, type FlagSource } from '../src/proxy/server.ts';

type Tracked = { event: string; identity: string; value?: number };

class FakeFlags implements FlagSource {
  tracked: Tracked[] = [];
  async assign(): Promise<Assignment> {
    return { variant: 'v2', release: 'b', enrolled: true };
  }
  track(event: string, identity: string, value?: number): void {
    this.tracked.push(value === undefined ? { event, identity } : { event, identity, value });
  }
}

// The app names its own events: GET /?e=<header value> answers with it.
const app = http.createServer((req, res) => {
  const e = new URL(req.url ?? '/', 'http://x').searchParams.get('e');
  res.writeHead(200, { 'content-type': 'text/plain', ...(e ? { 'x-turnover-event': e } : {}) });
  res.end('ok');
});

const listen = (server: http.Server) =>
  new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

const flags = new FakeFlags();
const servers: http.Server[] = [app];
let withHeader = '';
let withoutHeader = '';
const id = '44444444-4444-4444-8444-444444444444';

before(async () => {
  const url = await listen(app);
  const make = async (goal: Record<string, unknown>) => {
    const p = createProxy({ config: parseConfig({ flag: 'f', releases: { a: url, b: url }, goal }), flags, log: () => {}, warn: () => {} });
    servers.push(p);
    return listen(p);
  };
  withHeader = await make({ event: 'signup', header: true });
  withoutHeader = await make({ event: 'signup', when: { method: 'POST', path: '/signup' } });
});

after(() => {
  for (const s of servers) s.close();
});

const get = async (base: string, value: string, headers: Record<string, string> = { cookie: `${ID_COOKIE}=${id}` }) => {
  flags.tracked = [];
  const res = await fetch(`${base}/api?e=${encodeURIComponent(value)}`, { headers });
  await res.text();
  await new Promise((r) => setTimeout(r, 20));
  return res;
};

test('a header-only goal loads without goal.when; existing configs stay valid', () => {
  const c = parseConfig({ flag: 'f', releases: { a: 'http://a' }, goal: { event: 'signup', header: true } });
  assert.equal(c.goal.when, undefined);
  assert.equal(c.goal.header, true);
  const old = parseConfig({ flag: 'f', releases: { a: 'http://a' }, goal: { event: 'signup', when: { method: 'POST', path: '/s' } } });
  assert.equal(old.goal.header, false);
  assert.throws(() => parseConfig({ flag: 'f', releases: { a: 'http://a' }, goal: { event: 'signup' } }), /goal.when/);
  assert.throws(() => parseConfig({ flag: 'f', releases: { a: 'http://a' }, goal: { event: 'signup', header: 'yes' } }), /goal.header/);
});

test('the header becomes Flagsmith events for the visitor, with optional values, and is stripped', async () => {
  const res = await get(withHeader, 'signup, plan_chosen;value=49.5');
  assert.equal(res.headers.get('x-turnover-event'), null);
  assert.deepEqual(flags.tracked, [
    { event: 'signup', identity: id },
    { event: 'plan_chosen', identity: id, value: 49.5 },
  ]);
});

test('invalid names, guardrail names and bad parameters are ignored', async () => {
  await get(withHeader, '9lives, doc_latency_ms, ok;value=abc, bad name, fine');
  assert.deepEqual(flags.tracked, [{ event: 'fine', identity: id }]);
});

test(`at most ${MAX_HEADER_EVENTS} events per response`, async () => {
  await get(withHeader, Array.from({ length: 9 }, (_, i) => `e${i}`).join(','));
  assert.equal(flags.tracked.length, MAX_HEADER_EVENTS);
  assert.equal(parseEventHeader(['a', 'b']).length, 2);
});

test('no events before the cookie round-trip or for bots, and the header is still stripped', async () => {
  let res = await get(withHeader, 'signup', {});
  assert.equal(res.headers.get('x-turnover-event'), null);
  assert.equal(flags.tracked.length, 0);
  res = await get(withHeader, 'signup', { cookie: `${ID_COOKIE}=${id}`, 'user-agent': 'Googlebot/2.1' });
  assert.equal(res.headers.get('x-turnover-event'), null);
  assert.equal(flags.tracked.length, 0);
});

test('without goal.header the header is stripped and ignored', async () => {
  const res = await get(withoutHeader, 'signup');
  assert.equal(res.headers.get('x-turnover-event'), null);
  assert.equal(flags.tracked.length, 0);
});
