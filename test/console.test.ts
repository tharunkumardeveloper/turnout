import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createConsole, hostnameOf, readEventCounter, sortSnapshots } from '../src/console/server.ts';
import { AdminClient } from '../src/flagsmith/admin.ts';
import { Experiments, type ExperimentSummary } from '../src/flagsmith/experiments.ts';
import { decide } from '../src/decide.ts';
import { Watcher } from '../src/health.ts';
import { readLedger } from '../src/ledger.ts';
import { createFeedServer, TrafficFeed } from '../src/proxy/feed.ts';
import { ENV, initialState, startFakeFlagsmith, type FakeState } from './fake-flagsmith.ts';

const listen = (server: http.Server) =>
  new Promise<string>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
  );

const METRICS = `# HELP flagsmith_experimentation_sdk_events_total SDK events
flagsmith_experimentation_sdk_events_total{result="accepted"} 324.0
flagsmith_experimentation_sdk_events_total{result="rejected"} 2.0
`;

// The fake has no experiments-list route; the release history is stubbed here.
const PAST: ExperimentSummary[] = [
  { id: 7, name: 'shop_release: shop:1.5 vs shop:1.4', hypothesis: '', status: 'running', started_at: '2026-11-17T00:00:00Z', ended_at: null },
  { id: 4, name: 'shop_release: shop:1.4 vs shop:1.3', hypothesis: '', status: 'completed', started_at: '2026-11-10T00:00:00Z', ended_at: '2026-11-12T00:00:00Z' },
];
class WithHistory extends Experiments {
  override async history(): Promise<ExperimentSummary[]> {
    return PAST;
  }
}

let state: FakeState;
let fake: { apiUrl: string; close: () => void };
const feed = new TrafficFeed();
const feedServer = createFeedServer(feed);
const metricsServer = http.createServer((_req, res) => res.end(METRICS));
let consoleServer: http.Server;
let base = '';
let port = 0;
let token = '';
let ledgerDir = '';

before(async () => {
  state = initialState();
  fake = await startFakeFlagsmith(state);
  const ui = mkdtempSync(join(tmpdir(), 'sy-ui-'));
  writeFileSync(join(ui, 'index.html'), '<head><meta name="turnout-console" content=""></head><h1>console</h1>');
  ledgerDir = mkdtempSync(join(tmpdir(), 'sy-ledger-'));
  consoleServer = createConsole({
    experiments: new WithHistory(new AdminClient(fake.apiUrl, { apiKey: 'k' }), { envKey: ENV, experimentId: 7 }),
    feedUrl: await listen(feedServer),
    metricsUrl: `${await listen(metricsServer)}/metrics`,
    snapshotDir: mkdtempSync(join(tmpdir(), 'sy-snap-')),
    ledgerDir,
    uiDir: ui,
  });
  base = await listen(consoleServer);
  port = (consoleServer.address() as AddressInfo).port;
  const page = await (await fetch(`${base}/`)).text();
  token = page.match(/name="turnout-console" content="([^"]+)"/)?.[1] ?? '';
});

after(() => {
  for (const s of [consoleServer, feedServer, metricsServer]) s.close();
  fake.close();
});

// Response bodies are loosely typed here; the assertions check their shape.
const json = (res: Response): Promise<any> => res.json();

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { headers: { 'x-turnout-console': token, ...headers } });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-turnout-console': token, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

// fetch() won't send a forged Host header; a raw request will.
const rawGet = (path: string, host: string) =>
  new Promise<number>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { host, 'x-turnout-console': token } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });

const losingLatency = () =>
  state.results!.payload!.metrics.push({
    metric_id: 2,
    variants: { control: { n: 1000, sum: 150_000, sum_squares: 0 }, v2: { n: 1000, sum: 210_000, sum_squares: 0 } },
    inference: { v2: { lift: 0.4, ci_low: 0.3, ci_high: 0.5, chance_to_win: 0.0001 } },
  });

describe('console API', () => {
  test('the page carries a per-boot token', () => {
    assert.match(token, /^[\w-]{32}$/);
  });

  test('state combines the experiment, results, winner, flag, events, traffic, history and ledger', async () => {
    feed.publish({ at: Date.now(), variant: 'v2', release: 'shop:1.5', method: 'GET', path: '/', status: 200, latencyMs: 70, document: true, enrolled: true, converted: false });
    const s = await json(await get('/api/state'));
    assert.equal(s.experiment.status, 'running');
    assert.equal(s.winner.key, 'v2');
    assert.deepEqual(s.events, { accepted: 324, rejected: 2 });
    assert.equal(s.traffic.byVariant.v2.pages, 1);
    assert.equal(s.flag.environment_default.enabled, true);
    assert.equal(s.serving, 'shop:1.4');
    assert.deepEqual(s.history.map((e: ExperimentSummary) => e.id), [7, 4]);
    assert.deepEqual(s.ledger, []);
  });

  test('shows the plan before acting, with losing guardrails', async () => {
    const plan = await json(await get('/api/plan?action=ship&winner=v2&experimentId=7'));
    assert.equal(plan.steps.length, 5);
    assert.match(plan.steps[3].title, /Drain/);
    assert.deepEqual(plan.guardrails, []);
    assert.equal(plan.recommendation.call, 'keep-running', 'the plan carries the recommendation');
    assert.equal(plan.recommendation.reason, 'interval −2% to +62% crosses zero');
    assert.equal((await json(await get('/api/state'))).recommendation.call, 'keep-running');
    losingLatency();
    const warned = await json(await get('/api/plan?action=ship&winner=v2&experimentId=7'));
    assert.deepEqual(warned.guardrails, [{ metric: 'doc_latency_ms', chanceToWin: 0.0001, lift: 0.4 }]);
    const revert = await json(await get('/api/plan?action=revert&experimentId=7'));
    assert.deepEqual(revert.guardrails, []);
    assert.equal(state.requests.filter((r) => !r.startsWith('GET')).length, 0);
  });

  test('answers only local Host names, on any port', async () => {
    assert.equal(await rawGet('/', 'evil.example'), 421);
    assert.equal(await rawGet('/api/state', `evil.example:${port}`), 421);
    assert.equal(await rawGet('/', 'localhost.evil.example'), 421);
    assert.equal(await rawGet('/', 'localhost:1234'), 200);
    assert.equal(await rawGet('/', `[::1]:${port}`), 200);
    assert.equal(hostnameOf('[::1]:8090'), '[::1]');
    assert.equal(hostnameOf('LocalHost:8090'), 'localhost');
  });

  test('refuses API calls without the token', async () => {
    assert.equal((await fetch(`${base}/api/state`)).status, 403);
    assert.equal((await get('/api/state', { 'x-turnout-console': 'wrong' })).status, 403);
    const res = await fetch(`${base}/api/revert`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"experimentId":7}' });
    assert.equal(res.status, 403);
    assert.equal((await fetch(`${base}/api/traffic?token=wrong`)).status, 403);
    assert.equal(state.experiment.status, 'running');
  });

  test('refuses cross-site, null-origin and non-JSON posts', async () => {
    const form = await post('/api/revert', 'x=1', { 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal(form.status, 403);
    assert.equal((await post('/api/revert', { experimentId: 7 }, { 'content-type': 'application/jsonx' })).status, 403);
    assert.equal((await post('/api/revert', { experimentId: 7 }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await post('/api/revert', { experimentId: 7 }, { origin: 'null' })).status, 403);
    assert.equal((await post('/api/revert', { experimentId: 7 }, { origin: 'not a url' })).status, 403);
    assert.equal(state.experiment.status, 'running');
  });

  test('rejects malformed and oversized bodies', async () => {
    assert.equal((await post('/api/revert', '{nope')).status, 400);
    assert.equal((await post('/api/revert', '[1]')).status, 400);
    assert.equal((await post('/api/revert', JSON.stringify({ experimentId: 7, pad: 'x'.repeat(20_000) }))).status, 413);
    assert.equal((await post('/api/revert', {})).status, 400); // no experimentId
    assert.equal(state.experiment.status, 'running');
  });

  test('refuses a plan or an action for an experiment the page no longer shows', async () => {
    const plan = await get('/api/plan?action=ship&winner=v2&experimentId=6');
    assert.equal(plan.status, 409);
    assert.match((await json(plan)).error, /experiment changed since this page loaded/);
    assert.equal((await get('/api/plan?action=ship&winner=v2')).status, 400);
    const ship = await post('/api/ship', { winner: 'v2', experimentId: 6 }, { 'content-type': 'application/json; charset=utf-8' });
    assert.equal(ship.status, 409);
    assert.match((await json(ship)).error, /experiment changed/);
    assert.equal(state.experiment.status, 'running');
  });

  test('a losing guardrail blocks Ship until the person accepts it', async () => {
    const refused = await post('/api/ship', { winner: 'v2', experimentId: 7 });
    const body = await json(refused);
    assert.equal(refused.status, 409);
    assert.equal(body.ok, false);
    assert.equal(body.guardrails[0].metric, 'doc_latency_ms');
    assert.equal(state.experiment.status, 'running');

    const res = await post('/api/ship', { winner: 'v2', experimentId: 7, acceptLosingGuardrails: true });
    const shipped = await json(res);
    assert.equal(res.status, 200);
    assert.equal(shipped.steps.length, 5);
    assert.equal(shipped.entry.decision, 'shipped');
    assert.equal(shipped.entry.release, 'shop:1.5');
    assert.equal(shipped.entry.losingGuardrailsAccepted[0].metric, 'doc_latency_ms');
    assert.equal(shipped.github, null);
    assert.equal(state.experiment.status, 'completed');
    assert.equal(state.flag.environment_default.variants[0]!.weight, 100);
    assert.equal(readLedger(ledgerDir).length, 1);

    const s = await json(await get('/api/state'));
    assert.equal(s.serving, 'shop:1.5');
    assert.equal(s.ledger[0].experimentId, 7);
  });

  test('Keep running refuses another experiment, and a decided one', async () => {
    assert.equal((await post('/api/keep-running', { experimentId: 6 })).status, 409);
    const res = await post('/api/keep-running', { experimentId: 7 });
    assert.equal(res.status, 409);
    assert.match((await json(res)).error, /already decided/);
    assert.equal(readLedger(ledgerDir).length, 1);
  });

  test('reports a refused action instead of crashing', async () => {
    const res = await post('/api/revert', { experimentId: 7 });
    assert.equal(res.status, 502);
    assert.match((await json(res)).error, /completed/);
  });

  test('Revert completes the experiment, drains the split and writes a ledger entry', async () => {
    Object.assign(state, initialState()); // a fresh running experiment 7
    const res = await post('/api/revert', { experimentId: 7 });
    const body = await json(res);
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(state.experiment.status, 'completed');
    assert.equal(state.experiment.experiment_rollout!.rollout_percentage, 0);
    assert.deepEqual(state.flag.environment_default.variants, [{ id: 11, weight: 0 }]);
    assert.equal(body.entry.decision, 'reverted');
    assert.equal(body.entry.release, 'shop:1.4');
    const ledger = readLedger(ledgerDir);
    assert.equal(ledger.length, 2);
    assert.equal(ledger[1]!.decision, 'reverted');
  });

  test('serves the UI with the token injected and nothing outside it', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(await res.text(), `<head><meta name="turnout-console" content="${token}"><meta name="turnout-no-judge" content="1"></head><h1>console</h1>`, 'no guided demo here: the menu drops its links');
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN', 'guided demo shows the setup check and the feature map as tabs');
    assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'self'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 404);
    assert.equal((await fetch(`${base}/secrets.env`)).status, 404);
    assert.equal((await get('/api/state')).headers.get('x-content-type-options'), 'nosniff');
  });

  test('guided demo is off without its options; the judge link needs a judge token', async () => {
    const state = await get('/api/judge/state');
    assert.equal(state.status, 404);
    assert.match((await json(state)).error, /Guided demo is not configured/);
    assert.equal((await post('/api/judge/run', { action: 'visitors' })).status, 404);
    assert.equal((await fetch(`${base}/api/judge/state`)).status, 403, 'still behind the page token');
    const page = await fetch(`${base}/judge`, { redirect: 'manual' });
    assert.deepEqual([page.status, page.headers.get('location')], [302, '/'], 'no guided demo: /judge is the console');
    const steps = await fetch(`${base}/judge?view=steps`, { redirect: 'manual' });
    assert.equal(steps.status, 302, 'no test API at all: no steps page either');
    assert.equal((await fetch(`${base}/judge?key=x`, { redirect: 'manual' })).status, 403);
  });

  test('relays the live traffic feed, with the token as a query parameter', async () => {
    const res = await fetch(`${base}/api/traffic?token=${encodeURIComponent(token)}`);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const reader = res.body!.getReader();
    await reader.read(); // ": connected"
    feed.publish({ at: Date.now(), variant: 'control', release: 'shop:1.4', method: 'POST', path: '/checkout', status: 200, latencyMs: 5, document: false, enrolled: true, converted: true });
    const { value } = await reader.read();
    assert.match(new TextDecoder().decode(value), /"converted":true/);
    await reader.cancel();
  });
});

describe('shared reads: many pages polling make one round of Flagsmith calls', () => {
  let fs: FakeState;
  let fsServer: { apiUrl: string; close: () => void };
  let server: http.Server;
  let url = '';
  let pageToken = '';
  let resolves = 0;
  let doctorRuns = 0;
  let scrapes = 0;
  const scrape = http.createServer((_req, res) => {
    scrapes++;
    res.end(METRICS);
  });

  before(async () => {
    fs = initialState();
    fsServer = await startFakeFlagsmith(fs);
    const ui = mkdtempSync(join(tmpdir(), 'sy-ui-'));
    writeFileSync(join(ui, 'index.html'), '<head><meta name="turnout-console" content=""></head>');
    server = createConsole({
      experiments: async () => {
        resolves++;
        return new WithHistory(new AdminClient(fsServer.apiUrl, { apiKey: 'k' }), { envKey: ENV, experimentId: 7 });
      },
      feedUrl: 'http://127.0.0.1:9',
      metricsUrl: `${await listen(scrape)}/metrics`,
      snapshotDir: mkdtempSync(join(tmpdir(), 'sy-snap-')),
      ledgerDir: mkdtempSync(join(tmpdir(), 'sy-ledger-')),
      uiDir: ui,
      cacheMs: { state: 60_000, latest: 60_000, events: 60_000, doctor: 60_000 }, // only writes and ?fresh=1 drop them here
      doctor: async () => {
        doctorRuns++;
        await new Promise((r) => setTimeout(r, 20));
        return { checks: [], ok: true } as never;
      },
    });
    url = await listen(server);
    pageToken = (await (await fetch(`${url}/`)).text()).match(/content="([^"]+)"/)?.[1] ?? '';
  });
  after(() => {
    server.close();
    scrape.close();
    fsServer.close();
  });

  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${url}${path}`, { ...init, headers: { 'x-turnout-console': pageToken, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const details = () => fs.requests.filter((r) => r === `GET /api/v1/environments/${ENV}/experiments/7/`).length;

  test('five pages at once: one experiment lookup, one detail, one results read, one metrics scrape', async () => {
    const bodies = await Promise.all(Array.from({ length: 5 }, async () => json(await call('/api/state'))));
    assert.ok(bodies.every((b) => b.experiment.id === 7 && b.serving === 'shop:1.4'));
    assert.equal(resolves, 1);
    assert.equal(details(), 1);
    assert.equal(fs.requests.filter((r) => r.endsWith('/results/')).length, 1);
    assert.equal(scrapes, 1);
    await call('/api/state');
    assert.equal(details(), 1, 'kept between polls');
    await call('/api/plan?action=revert&experimentId=7');
    assert.equal(resolves, 1, 'the plan reuses the latest experiment');
  });

  test('a write drops every kept read', async () => {
    const reverted = await call('/api/revert', { method: 'POST', body: JSON.stringify({ experimentId: 7 }) });
    assert.equal(reverted.status, 200);
    assert.equal(resolves, 2, 'Revert looked the latest experiment up afresh');
    const s = await json(await call('/api/state'));
    assert.equal(s.experiment.status, 'completed', 'not the kept running state');
    assert.equal(scrapes, 2);
  });

  test('the setup check runs once for concurrent pages; ?fresh=1 runs it again', async () => {
    const answers = await Promise.all(Array.from({ length: 4 }, () => call('/api/doctor')));
    assert.ok(answers.every((r) => r.status === 200));
    assert.equal(doctorRuns, 1);
    await call('/api/doctor');
    assert.equal(doctorRuns, 1);
    await call('/api/doctor?fresh=1');
    assert.equal(doctorRuns, 2);
  });

  test('the feature map is read once for concurrent pages', async () => {
    const before = fs.requests.filter((r) => r === 'GET /version/').length;
    const maps = await Promise.all(Array.from({ length: 4 }, () => call('/api/flagsmith-map')));
    assert.ok(maps.every((r) => r.status === 200));
    assert.equal(fs.requests.filter((r) => r === 'GET /version/').length - before, 1);
  });
});

test('decision snapshots are listed newest first by the time in their name, not as text', () => {
  const files = [
    'experiment-9-2026-11-17T11-13-42-484Z.json',
    'experiment-21-2026-11-17T17-43-16-330Z.json',
    'experiment-10-2026-11-17T11-20-00-000Z.json',
    'notes.json',
  ];
  assert.deepEqual(sortSnapshots(files), [
    'experiment-21-2026-11-17T17-43-16-330Z.json',
    'experiment-10-2026-11-17T11-20-00-000Z.json',
    'experiment-9-2026-11-17T11-13-42-484Z.json',
    'notes.json',
  ]);
});

test('readEventCounter tolerates a missing endpoint', async () => {
  assert.equal(await readEventCounter(undefined), null);
  assert.equal(await readEventCounter('http://127.0.0.1:9/metrics'), null);
});

describe("the guard's automatic Revert drops the console's kept reads", () => {
  test('after the guard reverts, the next read shows the completed experiment, not the kept running one', async () => {
    const fs = initialState();
    const fsServer = await startFakeFlagsmith(fs);
    const snapshotDir = mkdtempSync(join(tmpdir(), 'sy-snap-'));
    const ledger = mkdtempSync(join(tmpdir(), 'sy-ledger-'));
    const ui = mkdtempSync(join(tmpdir(), 'sy-ui-'));
    writeFileSync(join(ui, 'index.html'), '<head><meta name="turnout-console" content=""></head>');
    const exps = () => new WithHistory(new AdminClient(fsServer.apiUrl, { apiKey: 'k' }), { envKey: ENV, experimentId: 7 });
    const lock = { busy: false };
    let reverts = 0;
    const watcher = new Watcher({
      experiments: async () => exps(),
      flag: 'shop_release',
      environmentName: 'Development',
      guard: { enabled: true, threshold: 0.01, minIdentities: 0 },
      lock,
      now: () => Date.parse('2026-11-17T00:01:00Z'), // a minute in: no results refresh
      revert: async (e, reason) => {
        reverts++;
        await decide({ experiments: e, action: 'revert', acceptLosingGuardrails: true, snapshotDir, ledgerDir: ledger, by: 'guard', guardReason: reason });
      },
    });
    const server = createConsole({
      experiments: async () => exps(),
      lock,
      watcher,
      feedUrl: 'http://127.0.0.1:9',
      snapshotDir,
      ledgerDir: ledger,
      uiDir: ui,
      cacheMs: { state: 60_000, latest: 60_000, events: 60_000, doctor: 60_000 }, // kept for the whole test unless dropped
    });
    try {
      const url = await listen(server);
      const pageToken = (await (await fetch(`${url}/`)).text()).match(/content="([^"]+)"/)?.[1] ?? '';
      const read = async () => json(await fetch(`${url}/api/state`, { headers: { 'x-turnout-console': pageToken } }));
      assert.equal((await read()).experiment.status, 'running');
      fs.results!.payload!.metrics.push({
        metric_id: 2,
        variants: { control: { n: 1000, sum: 150_000, sum_squares: 0 }, v2: { n: 1000, sum: 210_000, sum_squares: 0 } },
        inference: { v2: { lift: 0.4, ci_low: 0.3, ci_high: 0.5, chance_to_win: 0.0001 } },
      });
      await watcher.tick();
      assert.equal(reverts, 1, 'the guard reverted');
      assert.equal((await read()).experiment.status, 'completed', 'not the kept pre-revert state');
    } finally {
      server.close();
      fsServer.close();
    }
  });
});

// Flagsmith recomputes an experiment's results at most once every 5 minutes; a recompute with nothing new spends it.
describe("the refresh guard: no recompute before there's something new to count", () => {
  test('held back with no visit since the start; allowed after one; held back again once results include it', async () => {
    const saved = { started: state.experiment!.started_at, asOf: state.results!.as_of, status: state.experiment!.status };
    try {
      state.experiment!.status = 'running'; // earlier tests decide it
      await new Promise((r) => setTimeout(r, 5)); // the feed (started with this file) is older than the experiment
      state.experiment!.started_at = new Date().toISOString();
      state.results!.as_of = '2026-11-17T01:00:00Z';
      const none = await json(await post('/api/refresh', {}));
      assert.equal(none.ok, false);
      assert.equal(none.heldBack, true);
      assert.match(none.reason, /No visitor in the experiment has loaded a page since it started/);

      feed.publish({ at: Date.now(), variant: 'v2', release: 'shop:1.5', method: 'GET', path: '/', status: 200, latencyMs: 5, document: true, enrolled: true, converted: false });
      const one = await json(await post('/api/refresh', {}));
      assert.equal(one.ok, true, 'a visit since the start: Flagsmith is asked');

      state.results!.as_of = new Date(Date.now() + 1000).toISOString(); // Flagsmith has recomputed since that visit
      const done = await json(await post('/api/refresh', {}));
      assert.equal(done.heldBack, true);
      assert.match(done.reason, /already include every visit so far/);
    } finally {
      state.experiment!.started_at = saved.started;
      state.results!.as_of = saved.asOf;
      state.experiment!.status = saved.status;
    }
  });

  test("the feed's summary says since when it counts, and the last page view by an enrolled visitor", () => {
    const f = new TrafficFeed();
    assert.equal(f.summary().lastEnrolledPageAt, null);
    f.publish({ at: 123, variant: 'control', release: 'a', method: 'GET', path: '/x.css', status: 200, latencyMs: 1, document: false, enrolled: true, converted: false });
    f.publish({ at: 124, variant: 'control', release: 'a', method: 'GET', path: '/', status: 200, latencyMs: 1, document: true, enrolled: false, converted: false });
    assert.equal(f.summary(200).lastEnrolledPageAt, null, 'an asset, or a visitor outside the test, is not a counted visit');
    f.publish({ at: 150, variant: 'v2', release: 'b', method: 'GET', path: '/', status: 200, latencyMs: 1, document: true, enrolled: true, converted: false });
    assert.equal(f.summary(200).lastEnrolledPageAt, 150);
    assert.equal(typeof f.summary().since, 'number');
  });
});

describe('Try it with your app: the console relays to the tryit service, this machine only', () => {
  test('off without TURNOUT_TRYIT_URL: /try and /api/try answer 404', async () => {
    assert.equal((await get('/api/try/status')).status, 404);
    assert.equal((await fetch(`${base}/try`)).status, 404);
  });

  test('on: /try is guided demo for your versions, /api/try/* and /try/api/* reach the service, the token is required', async () => {
    const seen: string[] = [];
    const tryit = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url} cookie=${req.headers.cookie ?? ''}`);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, path: req.url }));
    });
    const tryUrl = await listen(tryit);
    const realUi = new URL('../src/console/ui/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const server = createConsole({
      experiments: new WithHistory(new AdminClient(fake.apiUrl, { apiKey: 'k' }), { envKey: ENV, experimentId: 7 }),
      feedUrl: 'http://127.0.0.1:9', snapshotDir: mkdtempSync(join(tmpdir(), 'sy-try-snap-')), ledgerDir: mkdtempSync(join(tmpdir(), 'sy-try-led-')),
      uiDir: decodeURIComponent(realUi), tryitUrl: tryUrl,
    });
    const url = await listen(server);
    try {
      const page = await fetch(`${url}/try`);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /<meta name="turnout-base" content="\/try"><meta name="turnout-try" content="1">/);
      const t = html.match(/name="turnout-console" content="([^"]+)"/)![1]!;
      assert.equal((await fetch(`${url}/api/try/status`)).status, 403, 'the page token is required');
      assert.equal((await fetch(`${url}/try/api/judge/state`)).status, 403, 'under /try/api too');
      const status: any = await (await fetch(`${url}/api/try/status`, { headers: { 'x-turnout-console': t } })).json();
      assert.equal(status.path, '/api/try/status');
      const st: any = await (await fetch(`${url}/try/api/judge/state`, { headers: { 'x-turnout-console': t, cookie: 'tn_id=abc' } })).json();
      assert.equal(st.path, '/api/judge/state', '/try/api/x reaches the service as /api/x');
      assert.ok(seen.some((l) => l.includes('cookie=tn_id=abc')), 'the browser cookie goes along (where you land, pins)');
      assert.equal((await fetch(`${url}/try/api/doctor`, { headers: { 'x-turnout-console': t } })).status, 404, 'only the listed paths');
      assert.match(page.headers.get('content-security-policy') ?? '', /frame-src 'self'[^;]* http:\/\/127\.0\.0\.1:8085/, 'its previews may frame the try proxy');
    } finally {
      server.close();
      tryit.close();
    }
  });
});
