import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import type { SimOptions, SimReport } from '../demo/simulator/simulate.ts';
import {
  DEFAULT_RATES,
  deriveSteps,
  nextRelease,
  parseRates,
  shared,
  summarizeResults,
  testedReleases,
  verdictOf,
  type JudgeOptions,
  type StepInput,
} from '../src/console/judge.ts';
import { createConsole, JUDGE_COOKIE, judgeMark, listenForOtherDevices, listenForPublic } from '../src/console/server.ts';
import { AdminClient } from '../src/flagsmith/admin.ts';
import { latestExperiment, type ExperimentDetail, type Results } from '../src/flagsmith/experiments.ts';
import { readLedger } from '../src/ledger.ts';
import { ENV, initialState, startFakeFlagsmith, type FakeState } from './fake-flagsmith.ts';

const RELEASES = ['shop:1.4', 'shop:1.5', 'shop:1.6'];

// ---- pure parts -------------------------------------------------------------------------------------------------

const input = (over: Partial<StepInput> = {}): StepInput => ({
  status: 'running',
  visitorsSent: 0,
  identities: 0,
  resultsAsOf: null,
  lastVisitorsAt: null,
  losingGuardrails: false,
  decision: null,
  verified: false,
  swungBack: false,
  swungForward: false,
  previewServes: null,
  previewAvailable: true,
  next: 'shop:1.6',
  ...over,
});
const statuses = (i: StepInput) => Object.fromEntries(deriveSteps(i).steps.map((s) => [s.id, s.status]));

describe('deriveSteps', () => {
  test('a running experiment: visitors, then score, then decide', () => {
    assert.equal(deriveSteps(input()).current, 'visitors');
    assert.deepEqual(statuses(input()), { visitors: 'current', score: 'todo', decide: 'todo', verify: 'todo', swing: 'todo', preview: 'todo', release: 'todo' });

    const sent = input({ visitorsSent: 1500, lastVisitorsAt: '2026-11-17T10:00:00Z', resultsAsOf: '2026-11-17T09:00:00Z' });
    assert.equal(deriveSteps(sent).current, 'score', 'results older than the visitors');
    const scored = { ...sent, resultsAsOf: '2026-11-17T10:00:30Z' };
    assert.equal(deriveSteps(scored).current, 'decide');
    assert.deepEqual(statuses(scored), { visitors: 'done', score: 'done', decide: 'current', verify: 'todo', swing: 'todo', preview: 'todo', release: 'todo' });
    assert.equal(deriveSteps({ ...scored, status: 'paused' }).current, 'decide');
  });

  test("Flagsmith's identity count stands in for visitors this console didn't send", () => {
    assert.equal(deriveSteps(input({ identities: 99 })).current, 'visitors');
    assert.equal(deriveSteps(input({ identities: 120 })).current, 'score');
    assert.equal(deriveSteps(input({ identities: 120, resultsAsOf: '2026-11-17T10:00:00Z' })).current, 'decide');
  });

  test('the decide step says Revert when a guardrail is losing', () => {
    const scored = input({ identities: 2000, resultsAsOf: '2026-11-17T10:00:00Z' });
    assert.equal(deriveSteps(scored).steps.find((s) => s.id === 'decide')!.title, 'Ship winner');
    assert.equal(deriveSteps({ ...scored, losingGuardrails: true }).steps.find((s) => s.id === 'decide')!.title, 'Revert (a guardrail is losing)');
    const shippedAnyway = { ...scored, status: 'completed' as const, decision: 'shipped' as const, losingGuardrails: true };
    assert.equal(deriveSteps(shippedAnyway).steps.find((s) => s.id === 'decide')!.title, 'Ship winner');
  });

  test('keep running: the decide step says so, and after it the next step is more visitors', () => {
    const scored = input({ visitorsSent: 1500, lastVisitorsAt: '2026-11-17T10:00:00Z', resultsAsOf: '2026-11-17T10:00:30Z' });
    const kr = { ...scored, recommendation: 'keep-running' as const };
    assert.equal(deriveSteps(kr).steps.find((s) => s.id === 'decide')!.title, 'Keep running (interval crosses zero)');
    const kept = { ...kr, keptRunningAt: '2026-11-17T10:01:00Z' };
    assert.equal(deriveSteps(kept).current, 'visitors');
    assert.deepEqual(deriveSteps(kept).steps.filter((s) => s.status === 'current').map((s) => s.id), ['visitors'], 'one current step, not two');
    const more = { ...kept, lastVisitorsAt: '2026-11-17T10:05:00Z' };
    assert.equal(deriveSteps(more).current, 'score', 'more visitors sent: get the results again');
    assert.equal(deriveSteps({ ...more, resultsAsOf: '2026-11-17T10:06:00Z' }).current, 'decide');
  });

  test('a completed experiment: verify, optional swing, preview, release', () => {
    const done = input({ status: 'completed', decision: 'shipped' });
    assert.equal(deriveSteps(done).current, 'verify');
    assert.deepEqual(statuses(done), { visitors: 'done', score: 'done', decide: 'done', verify: 'current', swing: 'optional', preview: 'todo', release: 'todo' });

    const verified = { ...done, verified: true };
    assert.equal(deriveSteps(verified).current, 'preview');
    assert.equal(statuses(verified).release, 'todo');
    assert.equal(statuses({ ...verified, swungBack: true }).swing, 'optional', 'back without forward');
    assert.equal(statuses({ ...verified, swungBack: true, swungForward: true }).swing, 'done');
    assert.equal(statuses({ ...verified, decision: 'reverted', swungBack: true, swungForward: true }).swing, 'optional');

    const previewed = { ...verified, previewServes: 'shop:1.6' };
    assert.equal(deriveSteps(previewed).current, 'release');
    assert.deepEqual(statuses(previewed), { visitors: 'done', score: 'done', decide: 'done', verify: 'done', swing: 'optional', preview: 'done', release: 'current' });
    assert.equal(deriveSteps({ ...verified, previewServes: 'shop:1.5' }).current, 'preview', 'the preview serves an older release');
  });

  test('preview skipped: release is current right after verify', () => {
    const verified = input({ status: 'completed', decision: 'shipped', verified: true, previewAvailable: false });
    assert.equal(deriveSteps(verified).current, 'release');
    assert.equal(statuses(verified).preview, 'optional');
  });

  test('no next release: reset after verify', () => {
    const last = input({ status: 'completed', decision: 'reverted', losingGuardrails: true, next: null });
    assert.equal(deriveSteps(last).current, 'verify');
    assert.equal(deriveSteps({ ...last, verified: true }).current, 'reset');
    assert.equal(deriveSteps(last).steps.find((s) => s.id === 'decide')!.title, 'Revert (a guardrail is losing)');
    assert.equal(statuses({ ...last, verified: true }).release, 'todo');
  });

  test('every step names its round', () => {
    assert.deepEqual(
      deriveSteps(input()).steps.map((s) => s.round),
      ['03', '02', '04', '04', '01', null, '01'],
    );
  });
});

describe('results summary', () => {
  const experiment = initialState().experiment;
  const results = (metrics: NonNullable<Results['payload']>['metrics']): Results => ({
    as_of: '2026-11-17T01:00:00Z',
    last_error_at: null,
    refresh_requested_at: null,
    is_final: false,
    payload: { srm_p_value: null, metrics },
  });

  test('verdicts from chance to win, or why there is none', () => {
    assert.equal(verdictOf({ chance_to_win: 0.95 }, null), 'winning');
    assert.equal(verdictOf({ chance_to_win: 0.05 }, null), 'losing');
    assert.equal(verdictOf({ chance_to_win: 0.5 }, null), 'inconclusive');
    assert.equal(verdictOf(null, [{ sum: 0 }, { sum: 0 }]), 'no-events');
    assert.equal(verdictOf(null, [{ sum: 0 }, { sum: 3 }]), 'collecting');
    assert.equal(verdictOf(null, null), 'collecting');
  });

  test('per metric: role, arms as means, v2 inference, verdict', () => {
    const summary = summarizeResults(
      experiment,
      results([
        {
          metric_id: 1,
          variants: { control: { n: 1000, sum: 100, sum_squares: 100 }, v2: { n: 1000, sum: 135, sum_squares: 135 } },
          inference: { v2: { lift: 0.35, ci_low: 0.1, ci_high: 0.6, chance_to_win: 0.99 } },
        },
        {
          metric_id: 2,
          variants: { control: { n: 1000, sum: 26_000, sum_squares: 0 }, v2: { n: 1000, sum: 97_000, sum_squares: 0 } },
          inference: { v2: { lift: 2.7, ci_low: 2.5, ci_high: 2.9, chance_to_win: 0.0001 } },
        },
      ]),
    );
    assert.deepEqual(summary[0], {
      name: 'order_placed',
      role: 'goal',
      aggregation: 'occurrence',
      direction: 'up',
      arms: { control: { n: 1000, mean: 0.1 }, v2: { n: 1000, mean: 0.135 } },
      v2: { lift: 0.35, chanceToWin: 0.99, ciLow: 0.1, ciHigh: 0.6 },
      verdict: 'winning',
      byArm: { v2: { lift: 0.35, chanceToWin: 0.99, ciLow: 0.1, ciHigh: 0.6, verdict: 'winning' } },
    });
    assert.equal(summary[1]!.role, 'guardrail');
    assert.equal(summary[1]!.arms.v2!.mean, 97);
    assert.equal(summary[1]!.verdict, 'losing');
  });

  test('inconclusive, collecting and no events', () => {
    const summary = summarizeResults(
      experiment,
      results([
        {
          metric_id: 1,
          variants: { control: { n: 10, sum: 1, sum_squares: 1 }, v2: { n: 10, sum: 2, sum_squares: 2 } },
          inference: { v2: { lift: 1, ci_low: -1, ci_high: 3, chance_to_win: 0.7 } },
        },
        { metric_id: 2, variants: { control: { n: 10, sum: 0, sum_squares: 0 }, v2: { n: 10, sum: 0, sum_squares: 0 } }, inference: { v2: null } },
      ]),
    );
    assert.deepEqual(summary.map((m) => m.verdict), ['inconclusive', 'no-events']);
    assert.deepEqual(summarizeResults(experiment, null).map((m) => m.verdict), ['collecting', 'collecting']);
    assert.equal(summarizeResults(experiment, null)[0]!.v2, null);
  });

  test("the releases an experiment compares survive a preview re-pointing v2", () => {
    const e: ExperimentDetail = structuredClone(experiment);
    assert.deepEqual(testedReleases(e, RELEASES), { control: 'shop:1.4', v2: 'shop:1.5' });
    e.feature.multivariate_options[0]!.string_value = 'shop:1.6'; // preview shop:1.6 after the ship
    assert.deepEqual(testedReleases(e, RELEASES), { control: 'shop:1.4', v2: 'shop:1.5' });
    e.name = 'something else';
    assert.deepEqual(testedReleases(e, RELEASES), { control: 'shop:1.4', v2: 'shop:1.6' }, 'falls back to the flag');
    assert.equal(nextRelease(RELEASES, 'shop:1.5'), 'shop:1.6');
    assert.equal(nextRelease(RELEASES, 'shop:1.6'), null);
    assert.equal(nextRelease(RELEASES, null), null);
  });

  test('demo rates are keyed by release label', () => {
    assert.deepEqual(parseRates('shop:1.4=0.10, shop:1.5=0.135,shop:1.6=0.14'), { 'shop:1.4': 0.1, 'shop:1.5': 0.135, 'shop:1.6': 0.14 });
    assert.throws(() => parseRates('shop:1.4=lots'), /TURNOUT_DEMO_RATES/);
    assert.throws(() => parseRates('shop:1.4=2'), /TURNOUT_DEMO_RATES/);
  });
});

// ---- the console with guided demo --------------------------------------------------------------------------------

const listen = (server: http.Server) =>
  new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

// fake-flagsmith.ts has no experiments list, environment, segments or refresh routes; this adds them in front of it.
async function startFlagsmith(state: FakeState) {
  const fake = await startFakeFlagsmith(state);
  const root = fake.apiUrl.replace(/\/api\/v1\/$/, '');
  const flagPatches: any[] = [];
  const requests: string[] = [];
  let refreshes = 0;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const path = req.url ?? '';
    requests.push(`${req.method} ${path}`);
    const exp = `/api/v1/environments/${ENV}/experiments/${state.experiment.id}`;
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.method === 'GET' && path === `/api/v1/environments/${ENV}/experiments/`) {
      const e = state.experiment;
      return send(200, { results: [{ id: e.id, name: e.name, status: e.status, feature: { id: e.feature.id, name: e.feature.name } }] });
    }
    if (req.method === 'GET' && path === `/api/v1/environments/${ENV}/`) return send(200, { project: 1, api_key: ENV });
    if (req.method === 'GET' && path === '/api/v1/projects/1/segments/') return send(200, [{ id: 50, name: 'turnout-preview' }]);
    if (req.method === 'POST' && path === `${exp}/results/refresh/`) {
      if (++refreshes > 1) return send(429, { detail: 'Request was throttled. Expected available in 120 seconds.' });
      state.results!.as_of = new Date(Date.now() + 3_600_000).toISOString(); // computed "later"
      return send(202, {});
    }
    if (req.method === 'PATCH' && path === `/api/__future__/environments/${ENV}/features/${state.experiment.feature.id}/`) {
      const body = JSON.parse(raw);
      flagPatches.push(body);
      if (body.environment_default?.value) state.flag.environment_default.value = body.environment_default.value; // the fake ignores it
    }
    const upstream = await fetch(`${root}${path}`, {
      method: req.method!,
      headers: { 'content-type': 'application/json' },
      ...(raw ? { body: raw } : {}),
    });
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(await upstream.text());
  });
  const url = await listen(server);
  return { apiUrl: `${url}/api/v1/`, flagPatches, requests, close: () => (server.close(), fake.close()) };
}

const UI = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'sy-judge-ui-'));
  writeFileSync(join(dir, 'index.html'), '<head><meta name="turnout-console" content=""></head><h1>console</h1>');
  writeFileSync(join(dir, 'judge.html'), '<head><meta name="turnout-console" content=""></head><h1>judge</h1>'); // server mode's public page
  // /judge on the console, and server mode's public page (read-only)
  writeFileSync(join(dir, 'demo.html'), '<head><meta name="turnout-console" content=""><script type="module" src="/demo.js"></script></head><h1>demo</h1>');
  writeFileSync(join(dir, 'demo.js'), 'export {};');
  writeFileSync(join(dir, 'judge.js'), 'export {};');
  writeFileSync(join(dir, 'judge.css'), 'body{}');
  return dir;
})();

type Raw = { status: number; headers: http.IncomingHttpHeaders; body: string };
const raw = (port: number, path: string, headers: Record<string, string>, method = 'GET', body?: string) =>
  new Promise<Raw>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });

describe('guided demo API', () => {
  let state: FakeState;
  let flagsmith: Awaited<ReturnType<typeof startFlagsmith>>;
  let server: http.Server;
  let base = '';
  let token = '';
  let ledgerDir = '';
  let offset = 0; // a fake clock: sleeps advance it instead of waiting
  let simulated: SimOptions | undefined;
  let releaseSimulation: (() => void) | undefined;
  const previews: string[] = [];
  const releases: { release: string; hypothesis: string; extra?: { also?: string[]; aa?: boolean } }[] = [];

  // What the proxy would serve a new visitor, from the fake flag.
  const served = () => {
    const d = state.flag.environment_default;
    const full = d.variants.find((v) => v.weight >= 100);
    return full ? state.experiment.feature.multivariate_options.find((o) => o.id === full.id)!.string_value : d.value.value;
  };

  const startExperiment = (id: number, v2: string, control: string) => {
    state.experiment = {
      ...structuredClone(initialState().experiment),
      id,
      name: `shop_release: ${v2} vs ${control}`,
      hypothesis: `${v2} raises order_placed without hurting latency or errors`,
      experiment_rollout: { ...initialState().experiment.experiment_rollout!, feature_state_value: { type: 'string', value: control } },
    };
    state.experiment.feature.multivariate_options[0]!.string_value = v2;
    state.flag.segment_overrides[0]!.variants = [{ id: 11, weight: 50 }];
    state.results = null;
  };

  before(async () => {
    state = initialState();
    flagsmith = await startFlagsmith(state);
    ledgerDir = mkdtempSync(join(tmpdir(), 'sy-judge-ledger-'));
    const judge: JudgeOptions = {
      flag: 'shop_release',
      releases: RELEASES,
      goal: 'order_placed',
      apiUrl: flagsmith.apiUrl,
      adminKey: 'k',
      proxyUrl: 'http://proxy.invalid:8080',
      shopUrl: 'http://localhost:8080/',
      dashboardUrl: 'http://localhost:8000',
      previewToken: 'preview-token',
      rates: parseRates('shop:1.4=0.10,shop:1.5=0.135,shop:1.6=0.14'),
      stateCacheMs: 0, // these tests edit the fake between reads; the shared read itself is tested below
      deps: {
        simulate: async (opts: SimOptions): Promise<SimReport> => {
          simulated = opts;
          await new Promise<void>((resolve) => (releaseSimulation = resolve));
          for (let done = 100; done <= opts.visitors; done += 100) opts.log?.(`  ${done}/${opts.visitors} visitors`);
          const half = opts.visitors / 2;
          return {
            byVariant: {},
            byRelease: {
              'shop:1.4': { visitors: half, carts: 0, orders: Math.round(half / 10), pageErrors: 0 },
              'shop:1.5': { visitors: half, carts: 0, orders: Math.round(half / 7), pageErrors: 0 },
            },
            failedOrders: 0,
            durationMs: 1234,
          };
        },
        preview: async (release, envKey, log) => {
          assert.equal(envKey, ENV);
          previews.push(release);
          // As preview() does: everyone else keeps the live release as the default's value, v2 at 0%.
          state.flag.environment_default = { enabled: true, value: { type: 'string', value: served()! }, variants: [{ id: 11, weight: 0 }] };
          state.experiment.feature.multivariate_options[0]!.string_value = release;
          state.flag.segment_overrides.push({ segment: { id: 50 }, priority: 1, enabled: true, variants: [{ id: 11, weight: 100 }] });
          log(`✓ your team gets ${release}`);
        },
        release: async (release, hypothesis, _envKey, _log, extra) => {
          releases.push({ release, hypothesis, ...(extra ? { extra } : {}) });
          const id = state.experiment.id + 1;
          startExperiment(id, release, served()!);
          return { experimentId: id };
        },
        check: async (log) => {
          log("✓ shop_release: experiment 7's split is drained (0%).");
          return 0;
        },
        visit: async () => served(),
        readEvents: async () => ({ accepted: 9000, rejected: 0 }),
        sleep: async (ms) => {
          offset += ms;
          await new Promise((r) => setImmediate(r));
        },
        now: () => Date.now() + offset,
      },
    };
    server = createConsole({
      experiments: () => latestExperiment(new AdminClient(flagsmith.apiUrl, { apiKey: 'k' }), ENV, 'shop_release'),
      feedUrl: 'http://127.0.0.1:9',
      snapshotDir: mkdtempSync(join(tmpdir(), 'sy-judge-snap-')),
      ledgerDir,
      uiDir: UI,
      judge,
    });
    base = await listen(server);
    const page = await (await fetch(`${base}/judge`)).text();
    token = page.match(/name="turnout-console" content="([^"]+)"/)?.[1] ?? '';
  });

  after(() => {
    server.close();
    flagsmith.close();
  });

  const getState = async (): Promise<any> => {
    const res = await fetch(`${base}/api/judge/state`, { headers: { 'x-turnout-console': token } });
    assert.equal(res.status, 200);
    return res.json();
  };
  const run = async (body: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${base}/api/judge/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-turnout-console': token },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  // Waits for the job, then reads the state once more. While release swaps the fake's only experiment, a read that
  // resolved the old id can 404 (real Flagsmith keeps old experiments), so mid-job reads may fail.
  const finished = async (): Promise<any> => {
    for (let i = 0; i < 500; i++) {
      const res = await fetch(`${base}/api/judge/state`, { headers: { 'x-turnout-console': token } });
      const s: any = res.ok ? await res.json() : null;
      if (s?.job && s.job.status !== 'running') return getState();
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('job did not finish');
  };
  const runToEnd = async (body: unknown) => {
    const started = await run(body);
    assert.equal(started.status, 202, JSON.stringify(started.body));
    return finished();
  };
  const logText = (s: any) => s.job.log.map((l: { text: string }) => l.text).join('\n');

  test('serves the simple judge page (demo.html) at /judge with the per-boot token, and its script and styles', async () => {
    assert.match(token, /^[\w-]{32}$/);
    const page = await fetch(`${base}/judge`);
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await page.text(), `<head><meta name="turnout-console" content="${token}"><script type="module" src="/demo.js"></script></head><h1>demo</h1>`);
    assert.equal((await fetch(`${base}/judge.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal((await fetch(`${base}/judge.css`)).headers.get('content-type'), 'text/css; charset=utf-8');
    assert.equal((await fetch(`${base}/api/judge/state`)).status, 403, 'the API needs the token');
  });

  test('the starting state: experiment 1 running, send visitors first', async () => {
    const s = await getState();
    assert.equal(s.simulated, true);
    assert.deepEqual(s.releases, RELEASES);
    assert.equal(s.live, 'shop:1.4');
    assert.equal(s.next, 'shop:1.6');
    assert.deepEqual(s.experiment, {
      id: 7,
      name: 'shop_release: shop:1.5 vs shop:1.4',
      hypothesis: 'shop:1.5 raises order_placed',
      status: 'running',
      control: 'shop:1.4',
      v2: 'shop:1.5',
      arms: [{ key: 'control', release: 'shop:1.4' }, { key: 'v2', release: 'shop:1.5' }],
      startedAt: '2026-11-17T00:00:00Z',
      endedAt: null,
    });
    assert.deepEqual(s.links, {
      experiment: `http://localhost:8000/project/1/environment/${ENV}/experiments/7`,
      flag: `http://localhost:8000/project/1/environment/${ENV}/features?feature=3`,
      shop: 'http://localhost:8080',
      preview: 'http://localhost:8080/__turnout/preview?token=preview-token',
    });
    assert.equal(s.results.winner.key, 'v2');
    assert.equal(s.results.winner.release, 'shop:1.5');
    assert.equal(s.results.metrics[0].verdict, 'winning');
    assert.equal(s.results.metrics[1].verdict, 'collecting');
    assert.deepEqual(s.preview, { active: false, release: null });
    assert.deepEqual(s.routing, {
      defaultRelease: 'shop:1.4',
      experiment: {
        id: 7,
        status: 'running',
        enrolledPct: 100,
        arms: [
          { key: 'control', release: 'shop:1.4', pct: 50 },
          { key: 'v2', release: 'shop:1.5', pct: 50 },
        ],
      },
      preview: { active: false, release: null },
    });
    assert.equal(s.current, 'decide', "the fake's results already count 2,000 identities, scored before this console started");
    assert.equal(s.job, null);
    assert.deepEqual(s.totals, { visitorsSent: 0, eventsAccepted: 9000, eventsRejected: 0 });
  });

  test('rejects unknown actions and bad bodies', async () => {
    assert.equal((await run({ action: 'launch' })).status, 400);
    assert.equal((await run({ action: 'visitors', visitors: 'many' })).status, 400);
    assert.equal((await run({ action: 'ship' })).status, 400, 'experimentId is required');
    assert.equal((await run({ action: 'ship', experimentId: 7.5 })).status, 400);
  });

  test('refuses an action for an experiment the page no longer shows, and release while one runs', async () => {
    const stale = await run({ action: 'ship', experimentId: 6 });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /experiment changed/);
    const release = await run({ action: 'release' });
    assert.equal(release.status, 409);
    assert.match(release.body.error, /Experiment 7 .* is running\. Ship the winner or revert it first/);
    assert.equal((await run({ action: 'verify', experimentId: 7 })).status, 409);
    assert.equal((await run({ action: 'swing-back', experimentId: 7 })).status, 409);
    assert.equal(state.experiment.status, 'running');
  });

  test('visitors run in the background, holding the lock the console shares', async () => {
    const started = await run({ action: 'visitors', visitors: 9000 });
    assert.equal(started.status, 202);
    assert.equal(started.body.job.action, 'visitors');
    assert.equal(started.body.job.status, 'running');
    while (!releaseSimulation) await new Promise((r) => setTimeout(r, 5));

    const busy = await run({ action: 'score', experimentId: 7 });
    assert.equal(busy.status, 409);
    assert.match(busy.body.error, /still running/);
    const revert = await fetch(`${base}/api/revert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-turnout-console': token },
      body: '{"experimentId":7}',
    });
    assert.equal(revert.status, 409, 'Ship/Revert share the lock');
    assert.equal((await getState()).job.status, 'running');
    const polled: any = await (await fetch(`${base}/api/judge/job`, { headers: { 'x-turnout-console': token } })).json();
    assert.equal(polled.job.id, started.body.job.id);
    assert.equal(polled.job.status, 'running');
    assert.match(polled.job.log[0].text, /Sending 5000 simulated visitors/);

    releaseSimulation!();
    const s = await finished();
    assert.equal(s.job.status, 'done', s.job.error);
    assert.equal(simulated!.visitors, 5000, 'clamped');
    assert.equal(simulated!.target, 'http://proxy.invalid:8080');
    assert.equal(simulated!.debugToken, 'preview-token');
    assert.deepEqual(simulated!.rates, { control: 0.1, v2: 0.135 }, 'release rates mapped to variant keys');
    const log = logText(s);
    assert.match(log, /simulated visitors \(labelled simulation\)/);
    assert.match(log, /300 of 5000 visitors done/);
    assert.match(log, /5000 of 5000 visitors done/);
    assert.match(log, /shop:1\.5: 2500 visitors, 0 added to cart, 357 orders/);
    assert.equal(s.totals.visitorsSent, 5000);
    assert.equal(s.current, 'score');
  });

  test("score waits for events, refreshes Flagsmith's results, and polls until they change", async () => {
    const s = await runToEnd({ action: 'score', experimentId: 7 });
    assert.equal(s.job.status, 'done', s.job.error);
    const log = logText(s);
    assert.match(log, /Flagsmith has accepted 9,000 events/);
    assert.match(log, /order_placed \(goal\): v2 lift 30\.0% \(interval −2% to \+62%\), 96\.7% chance to win: winning/);
    assert.match(log, /Turnout recommends: keep running \(interval −2% to \+62% crosses zero\)/);
    assert.equal(s.current, 'decide');
    assert.ok(s.results.refreshAllowedAt, 'the next refresh is 5 minutes away');

    const again = await runToEnd({ action: 'score', experimentId: 7 });
    assert.equal(again.job.status, 'failed');
    assert.match(again.job.error, /one refresh per experiment every 5 minutes; next at \d\d:\d\d UTC/);
  });

  test('keep running: Flagsmith untouched, the ledger says why, and the next step is more visitors', async () => {
    const before = await getState();
    assert.equal(before.results.recommendation.call, 'keep-running');
    assert.equal(before.results.recommendation.reason, 'interval −2% to +62% crosses zero');
    assert.equal(before.steps.find((x: any) => x.id === 'decide').title, 'Keep running (interval crosses zero)');
    const writesBefore = state.requests.filter((r) => !r.startsWith('GET')).length;
    const s = await runToEnd({ action: 'keep-running', experimentId: 7 });
    assert.equal(s.job.status, 'done', s.job.error);
    assert.match(logText(s), /Kept running: interval −2% to \+62% crosses zero/);
    assert.equal(state.requests.filter((r) => !r.startsWith('GET')).length, writesBefore, 'no Flagsmith write');
    assert.equal(state.experiment.status, 'running');
    assert.equal(s.job.result.entry.decision, 'kept-running');
    assert.equal(s.current, 'visitors');
  });

  test('a losing guardrail fails Ship with the guardrails; accepting it ships', async () => {
    state.results!.payload!.metrics.push({
      metric_id: 2,
      variants: { control: { n: 1000, sum: 26_000, sum_squares: 0 }, v2: { n: 1000, sum: 97_000, sum_squares: 0 } },
      inference: { v2: { lift: 2.7, ci_low: 2.5, ci_high: 2.9, chance_to_win: 0.0001 } },
    });
    const before = await getState();
    assert.equal(before.steps.find((x: any) => x.id === 'decide').title, 'Revert (a guardrail is losing)');
    assert.deepEqual(before.results.losingGuardrails, [{ metric: 'doc_latency_ms', chanceToWin: 0.0001, lift: 2.7 }]);
    assert.equal(before.results.metrics[1].verdict, 'losing');

    const refused = await runToEnd({ action: 'ship', experimentId: 7 });
    assert.equal(refused.job.status, 'failed');
    assert.match(refused.job.error, /losing on doc_latency_ms/);
    assert.equal(refused.job.result.guardrails[0].metric, 'doc_latency_ms');
    assert.equal(state.experiment.status, 'running');

    const shipped = await runToEnd({ action: 'ship', experimentId: 7, acceptLosingGuardrails: true });
    assert.equal(shipped.job.status, 'done', shipped.job.error);
    assert.match(logText(shipped), /✓ Pause the experiment/);
    assert.match(logText(shipped), /Everyone now gets shop:1\.5/);
    assert.equal(shipped.job.result.entry.decision, 'shipped');
    assert.equal(state.experiment.status, 'completed');
    assert.equal(shipped.live, 'shop:1.5');
    assert.deepEqual(shipped.ledger.map((e: any) => e.decision), ['kept-running', 'shipped']);
    assert.equal(readLedger(ledgerDir).at(-1)!.release, 'shop:1.5');
    assert.equal(shipped.current, 'verify');
    // The page's checklist and before → after card.
    assert.deepEqual(shipped.job.stages.map((s: any) => s.status), ['done', 'done', 'done', 'done', 'done', 'done']);
    assert.equal(shipped.job.stages[0].title, 'Pause the experiment');
    assert.equal(shipped.job.changes.before.experiment.status, 'running');
    assert.equal(shipped.job.changes.after.experiment, null, 'completed and drained: no split left to draw');
    assert.equal(shipped.job.changes.after.defaultRelease, 'shop:1.5');
    assert.equal(refused.job.stages.find((s: any) => s.status === 'failed')?.title, 'Pause the experiment');
  });

  test('verify: 50 new visitors get the shipped release, and no split is left behind', async () => {
    const s = await runToEnd({ action: 'verify', experimentId: 7 });
    assert.equal(s.job.status, 'done', s.job.error);
    assert.deepEqual(s.job.result, { byRelease: { 'shop:1.5': 50 }, expected: 'shop:1.5', leftovers: 0 });
    assert.match(logText(s), /50 of 50 new visitors got shop:1\.5/);
    assert.match(logText(s), /No splits left behind/);
    assert.equal(s.current, 'preview');
  });

  test('swing back and forward with one edit to the environment default', async () => {
    const back = await runToEnd({ action: 'swing-back', experimentId: 7 });
    assert.equal(back.job.status, 'done', back.job.error);
    assert.deepEqual(flagsmith.flagPatches.at(-1), { environment_default: { enabled: true, variants: [{ id: 11, weight: 0 }] } });
    assert.equal(back.job.result.served, 'shop:1.4');
    assert.match(logText(back), /same edit as changing the default in Flagsmith's flag editor/);
    assert.equal(back.live, 'shop:1.4');
    assert.equal(back.steps.find((x: any) => x.id === 'swing').status, 'optional');

    const forward = await runToEnd({ action: 'swing-forward', experimentId: 7 });
    assert.equal(forward.job.result.served, 'shop:1.5');
    assert.equal(forward.live, 'shop:1.5');
    assert.equal(forward.steps.find((x: any) => x.id === 'swing').status, 'done');
  });

  test('preview the next release, then swinging is refused (v2 now holds the preview)', async () => {
    const s = await runToEnd({ action: 'preview' });
    assert.equal(s.job.status, 'done', s.job.error);
    assert.deepEqual(previews, ['shop:1.6']);
    assert.match(logText(s), /preview\?token=preview-token/);
    assert.deepEqual(s.preview, { active: true, release: 'shop:1.6' });
    assert.equal(s.next, 'shop:1.6', 'still the release after the one this experiment shipped');
    assert.equal(s.experiment.v2, 'shop:1.5');
    assert.equal(s.current, 'release');
    const swing = await run({ action: 'swing-forward', experimentId: 7 });
    assert.equal(swing.status, 409);
    assert.match(swing.body.error, /now serves shop:1\.6/);
  });

  test('release starts the next experiment; the page follows it', async () => {
    const s = await runToEnd({ action: 'release' });
    assert.equal(s.job.status, 'done', s.job.error);
    assert.deepEqual(releases.at(-1), { release: 'shop:1.6', hypothesis: 'shop:1.6 raises order_placed without hurting latency or errors' });
    assert.equal(s.experiment.id, 8);
    assert.equal(s.experiment.control, 'shop:1.5');
    assert.equal(s.experiment.v2, 'shop:1.6');
    assert.equal(s.next, null);
    assert.equal(s.results, null);
    assert.equal(s.current, 'visitors');
    assert.equal(s.totals.visitorsSent, 0);
    assert.equal((await run({ action: 'revert', experimentId: 7 })).status, 409, 'the page still showed experiment 7');
  });

  test('reset reverts the running experiment and starts the story again', async () => {
    const s = await runToEnd({ action: 'reset' });
    assert.equal(s.job.status, 'done', s.job.error);
    const log = logText(s);
    assert.match(log, /Experiment 8 is running; reverting it first/);
    assert.match(log, /✓ Complete the experiment/);
    assert.deepEqual(flagsmith.flagPatches.at(-1), {
      environment_default: { enabled: true, value: { type: 'string', value: 'shop:1.4' }, variants: [{ id: 11, weight: 0 }] },
    });
    assert.deepEqual(releases.at(-1)!.release, 'shop:1.5');
    assert.equal(s.experiment.id, 9, JSON.stringify(s.job.log));
    assert.equal(s.experiment.control, 'shop:1.4');
    assert.equal(s.experiment.v2, 'shop:1.5');
    assert.equal(s.next, 'shop:1.6');
    assert.equal(s.current, 'visitors');
    assert.deepEqual(s.ledger.map((e: any) => [e.experimentId, e.decision]), [[7, 'kept-running'], [7, 'shipped'], [8, 'reverted']]);
  });

  test('start: the kind of test the judge picked, from the start (A/A, A/B/C), and no more versions than releases', async () => {
    let s = await runToEnd({ action: 'start', arms: 1 });
    assert.equal(s.job.status, 'done', s.job.error);
    assert.deepEqual(releases.at(-1), { release: 'shop:1.4', hypothesis: releases.at(-1)!.hypothesis, extra: { aa: true } });
    assert.match(logText(s), /an A\/A test: shop:1\.4 on both arms/);
    s = await runToEnd({ action: 'start', arms: 3 });
    assert.equal(s.job.status, 'done', s.job.error);
    assert.deepEqual(releases.at(-1)!.extra, { also: ['shop:1.6'] });
    assert.equal(releases.at(-1)!.release, 'shop:1.5');
    s = await runToEnd({ action: 'start', arms: 4 });
    assert.equal(s.job.status, 'failed');
    assert.match(s.job.error, /lists 3 releases, so a test can compare at most 3/);
    assert.equal((await run({ action: 'start', arms: 0 })).status, 400);
  });
});

describe('shared reads', () => {
  test('one load for concurrent callers, kept for the TTL, failures never kept, clear() starts afresh', async () => {
    let t = 0;
    let loads = 0;
    let fail = false;
    const waiting: (() => void)[] = [];
    const release = () => waiting.shift()?.();
    const read = shared(
      async () => {
        const n = ++loads;
        if (fail) throw new Error('down');
        await new Promise<void>((r) => waiting.push(r));
        return n;
      },
      1500,
      () => t,
    );
    const first = Promise.all([read.get(), read.get(), read.get()]);
    release();
    assert.deepEqual(await first, [1, 1, 1]);
    t += 1499;
    assert.equal(await read.get(), 1, 'kept');
    t += 1;
    const second = read.get();
    assert.equal(await second, 1, 'expired: the last answer at once, a new read behind it');
    release();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(await read.get(), 2, 'the next caller gets the new read');

    const before = read.get(true); // fresh: skips the kept value
    release();
    assert.equal(await before, 3);
    const running = read.get(true);
    const joined = read.get(true);
    assert.equal(running, joined, 'fresh still joins a read that is running');
    release();
    await running;

    read.clear();
    const old = read.get();
    read.clear(); // e.g. a job ended while this read ran
    const next = read.get();
    assert.notEqual(old, next);
    release();
    release();
    assert.equal(await old, 5);
    assert.equal(await next, 6);

    read.clear();
    fail = true;
    await assert.rejects(read.get(), /down/);
    fail = false;
    const retried = read.get();
    release();
    assert.equal(await retried, 8, 'a failure is not kept');
  });
});

describe('guided demo shares one read of Flagsmith between viewers', () => {
  let state: FakeState;
  let flagsmith: Awaited<ReturnType<typeof startFlagsmith>>;
  let server: http.Server;
  let base = '';
  let token = '';

  before(async () => {
    state = initialState();
    flagsmith = await startFlagsmith(state);
    server = createConsole({
      experiments: () => latestExperiment(new AdminClient(flagsmith.apiUrl, { apiKey: 'k' }), ENV, 'shop_release'),
      feedUrl: 'http://127.0.0.1:9',
      snapshotDir: mkdtempSync(join(tmpdir(), 'sy-judge-snap-')),
      ledgerDir: mkdtempSync(join(tmpdir(), 'sy-judge-ledger-')),
      uiDir: UI,
      cacheMs: { state: 60_000, latest: 60_000 }, // nothing expires during the test: only a job drops the kept reads
      judge: {
        flag: 'shop_release',
        releases: RELEASES,
        goal: 'order_placed',
        apiUrl: flagsmith.apiUrl,
        adminKey: 'k',
        proxyUrl: 'http://proxy.invalid:8080',
        shopUrl: 'http://localhost:8080/',
        dashboardUrl: 'http://localhost:8000',
        previewToken: 'preview-token',
        rates: parseRates(DEFAULT_RATES),
        stateCacheMs: 60_000,
        deps: {
          simulate: async (opts: SimOptions): Promise<SimReport> => ({
            byVariant: {},
            byRelease: { 'shop:1.4': { carts: 0, visitors: opts.visitors, orders: 0, pageErrors: 0 } },
            failedOrders: 0,
            durationMs: 1,
          }),
          visit: async () => 'shop:1.4',
          readEvents: async () => ({ accepted: 1, rejected: 0 }),
          sleep: async () => {},
        },
      },
    });
    base = await listen(server);
    const page = await (await fetch(`${base}/judge`)).text();
    token = page.match(/name="turnout-console" content="([^"]+)"/)?.[1] ?? '';
  });
  after(() => {
    server.close();
    flagsmith.close();
  });

  const getState = async (): Promise<any> => {
    const res = await fetch(`${base}/api/judge/state`, { headers: { 'x-turnout-console': token } });
    assert.equal(res.status, 200);
    return res.json();
  };
  const reads = (suffix: string) => flagsmith.requests.filter((r) => r.startsWith('GET') && r.endsWith(suffix)).length;
  const exp = `/environments/${ENV}/experiments/`;

  test('six viewers at once make one round of Flagsmith calls; a job ends the shared read', async () => {
    const states = await Promise.all(Array.from({ length: 6 }, () => getState()));
    assert.ok(states.every((s) => s.experiment.id === 7));
    assert.equal(reads(exp), 1, 'one experiments list (the latest experiment)');
    assert.equal(reads(`${exp}7/`), 1, 'one experiment detail');
    assert.equal(reads(`${exp}7/results/`), 1, 'one results read');
    assert.equal(reads(`/features/${state.experiment.feature.id}/`), 1, 'one flag read');

    await getState();
    assert.equal(reads(`${exp}7/`), 1, 'kept between polls');

    const run = await fetch(`${base}/api/judge/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-turnout-console': token },
      body: JSON.stringify({ action: 'visitors', visitors: 50 }),
    });
    assert.equal(run.status, 202);
    const listsBeforeEnd = reads(exp);
    assert.ok(listsBeforeEnd >= 2, 'the action checked the latest experiment afresh');
    let s = await getState();
    for (let i = 0; i < 200 && s.job?.status !== 'done'; i++) {
      await new Promise((r) => setTimeout(r, 10));
      s = await getState();
    }
    assert.equal(s.job.status, 'done', 'the read after the job ended is fresh');
    assert.equal(s.totals.visitorsSent, 50);
    assert.ok(reads(exp) > listsBeforeEnd, 'the job dropped the cached latest experiment');
  });
});

describe('guided demo from another device', () => {
  const JUDGE_TOKEN = 'judge-secret-token';
  let server: http.Server;
  let port = 0;
  let state: FakeState;
  let fake: { apiUrl: string; close: () => void };

  before(async () => {
    state = initialState();
    fake = await startFakeFlagsmith(state);
    server = createConsole({
      experiments: async () => {
        throw new Error('not needed');
      },
      feedUrl: 'http://127.0.0.1:9',
      snapshotDir: mkdtempSync(join(tmpdir(), 'sy-judge-snap-')),
      ledgerDir: mkdtempSync(join(tmpdir(), 'sy-judge-ledger-')),
      uiDir: UI,
      allowedHosts: ['judge.example'],
      judgeToken: JUDGE_TOKEN,
      judge: {
        flag: 'shop_release', releases: RELEASES, goal: 'order_placed', apiUrl: fake.apiUrl, adminKey: 'k',
        proxyUrl: 'http://proxy.invalid:8080', shopUrl: 'http://127.0.0.1:8080', dashboardUrl: 'http://127.0.0.1:8000', rates: parseRates(DEFAULT_RATES),
      },
    });
    await listen(server);
    port = (server.address() as AddressInfo).port;
  });
  after(() => {
    server.close();
    fake.close();
  });

  test('loopback works without the cookie, as before', async () => {
    assert.equal((await raw(port, '/judge', { host: `localhost:${port}` })).status, 200);
    assert.equal((await raw(port, '/', { host: '127.0.0.1' })).status, 200);
  });

  test('an allowed host needs the judge cookie; an unlisted one is still refused', async () => {
    assert.equal((await raw(port, '/judge', { host: 'judge.example:8090' })).status, 403);
    assert.equal((await raw(port, '/', { host: 'judge.example' })).status, 403);
    assert.equal((await raw(port, '/api/judge/state', { host: 'judge.example' })).status, 403);
    assert.equal((await raw(port, '/judge', { host: 'evil.example' })).status, 421);
    assert.equal((await raw(port, `/judge?key=${JUDGE_TOKEN}`, { host: 'evil.example' })).status, 421);
  });

  test('a wrong key is refused', async () => {
    const res = await raw(port, '/judge?key=nope', { host: 'judge.example' });
    assert.equal(res.status, 403);
    assert.equal(res.headers['set-cookie'], undefined);
    assert.match(res.body, /Not a valid judge link/);
  });

  test('the judge link trades the key for a cookie, then everything works', async () => {
    const res = await raw(port, `/judge?key=${JUDGE_TOKEN}`, { host: 'judge.example:8090' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.location, '/judge');
    const cookie = res.headers['set-cookie']![0]!;
    assert.equal(cookie, `${JUDGE_COOKIE}=${judgeMark(JUDGE_TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
    assert.ok(!cookie.includes(JUDGE_TOKEN), 'the cookie holds a MAC, not the token');

    const pair = cookie.split(';')[0]!;
    const page = await raw(port, '/judge', { host: 'judge.example:8090', cookie: `other=1; ${pair}` });
    assert.equal(page.status, 200);
    const token = page.body.match(/content="([^"]+)"/)?.[1] ?? '';
    assert.match(token, /^[\w-]{32}$/);
    const api = await raw(port, '/api/judge/state', { host: 'judge.example:8090', cookie: pair, 'x-turnout-console': token });
    assert.ok(![403, 421].includes(api.status), `past the guards (got ${api.status}; this console's Flagsmith is a stub)`);
    assert.equal((await raw(port, '/api/judge/state', { host: 'judge.example', cookie: pair })).status, 403, 'still needs the page token');
    assert.equal((await raw(port, '/judge', { host: 'judge.example', cookie: `${JUDGE_COOKIE}=forged` })).status, 403);
  });

  test('the cookie is Secure behind HTTPS', async () => {
    const res = await raw(port, `/judge?key=${JUDGE_TOKEN}`, { host: 'judge.example', 'x-forwarded-proto': 'https' });
    assert.match(res.headers['set-cookie']![0]!, /; Secure$/);
  });

  test('the console refuses to start with a non-loopback host but no judge token', () => {
    const opts = {
      experiments: async () => {
        throw new Error('not needed');
      },
      feedUrl: 'http://127.0.0.1:9',
      snapshotDir: tmpdir(),
      ledgerDir: tmpdir(),
      uiDir: UI,
    };
    assert.throws(() => createConsole({ ...opts, allowedHosts: ['judge.example'] }), /TURNOUT_JUDGE_TOKEN is not set/);
    assert.doesNotThrow(() => createConsole({ ...opts, allowedHosts: ['localhost', '127.0.0.1'] }));
    assert.doesNotThrow(() => createConsole(opts));
  });

  test("on the other-devices port, a loopback Host header earns nothing: the cookie is needed and the password never sent", async () => {
    const devicesConsole = createConsole({
      experiments: async () => {
        throw new Error('not needed');
      },
      feedUrl: 'http://127.0.0.1:9',
      snapshotDir: tmpdir(),
      ledgerDir: tmpdir(),
      uiDir: UI,
      allowedHosts: ['judge.example'],
      judgeToken: JUDGE_TOKEN,
      flagsmithLogin: { email: 'admin@example.com', password: 'admin-password-123' },
      judge: {
        flag: 'shop_release',
        releases: RELEASES,
        goal: 'order_placed',
        apiUrl: fake.apiUrl,
        adminKey: 'k',
        proxyUrl: 'http://proxy.invalid:8080',
        shopUrl: 'http://localhost:8080/',
        dashboardUrl: 'http://localhost:8000',
        rates: parseRates(DEFAULT_RATES),
      },
    });
    await listen(devicesConsole);
    const local = (devicesConsole.address() as AddressInfo).port;
    const devices = listenForOtherDevices(devicesConsole, 0, '127.0.0.1');
    await once(devices, 'listening');
    const remote = (devices.address() as AddressInfo).port;
    try {
      // This machine's port: loopback names work without the cookie and the sign-in step gets the password.
      const page = await raw(local, '/judge', { host: '127.0.0.1:8090' });
      assert.equal(page.status, 200);
      const pageToken = page.body.match(/content="([^"]+)"/)?.[1] ?? '';
      const signin = await raw(local, '/api/judge/signin', { host: '127.0.0.1:8090', 'x-turnout-console': pageToken });
      assert.equal(JSON.parse(signin.body).password, 'admin-password-123');

      // The other-devices port, with a forged loopback Host: refused, no page token, no password.
      for (const host of ['127.0.0.1:8090', 'localhost', '[::1]:8091']) {
        const forged = await raw(remote, '/judge', { host });
        assert.equal(forged.status, 403, host);
        assert.doesNotMatch(forged.body, /turnout-console/, host);
        const api = await raw(remote, '/api/judge/signin', { host, 'x-turnout-console': pageToken });
        assert.equal(api.status, 403, host);
        assert.doesNotMatch(api.body, /admin-password-123/, host);
      }

      // With the judge cookie it works there, but the password still stays on this machine's port.
      const pair = (await raw(remote, `/judge?key=${JUDGE_TOKEN}`, { host: 'judge.example:8091' })).headers['set-cookie']![0]!.split(';')[0]!;
      for (const host of ['judge.example:8091', '127.0.0.1:8091']) {
        const withCookie = await raw(remote, '/judge', { host, cookie: pair });
        assert.equal(withCookie.status, 200, host);
        const remoteToken = withCookie.body.match(/content="([^"]+)"/)?.[1] ?? '';
        const answer = JSON.parse((await raw(remote, '/api/judge/signin', { host, cookie: pair, 'x-turnout-console': remoteToken })).body);
        assert.equal(answer.email, 'admin@example.com', host);
        assert.equal(answer.password, null, host);
      }
    } finally {
      devicesConsole.close();
      devices.close();
    }
  });

  test('without a judge token, the judge link is refused even on loopback', async () => {
    const other = createConsole({
      experiments: async () => {
        throw new Error('not needed');
      },
      feedUrl: 'http://127.0.0.1:9',
      snapshotDir: tmpdir(),
      ledgerDir: tmpdir(),
      uiDir: UI,
    });
    await listen(other);
    const p = (other.address() as AddressInfo).port;
    assert.equal((await raw(p, '/judge?key=anything', { host: 'localhost' })).status, 403);
    other.close();
  });
});

// Server mode: the console's public port (behind Caddy) serves a read-only judge view and nothing else.
describe('the public, read-only judge view (server mode)', () => {
  let flagsmith: Awaited<ReturnType<typeof startFlagsmith>>;
  let server: http.Server;
  let pub = '';
  let token = '';
  const realUi = fileURLToPath(new URL('../src/console/ui/', import.meta.url));

  before(async () => {
    flagsmith = await startFlagsmith(initialState());
    server = createConsole({
      experiments: () => latestExperiment(new AdminClient(flagsmith.apiUrl, { apiKey: 'k' }), ENV, 'shop_release'),
      feedUrl: 'http://127.0.0.1:9',
      snapshotDir: mkdtempSync(join(tmpdir(), 'sy-pub-snap-')),
      ledgerDir: mkdtempSync(join(tmpdir(), 'sy-pub-ledger-')),
      uiDir: realUi,
      judgeToken: 'judge-token-0123456789',
      flagsmithLogin: { email: 'a@example.com', password: 'admin-password-123' },
      autopilot: { pauseMs: 3_600_000 }, // on, but its first step is an hour away: nothing runs during the tests
      judge: {
        flag: 'shop_release',
        releases: RELEASES,
        goal: 'order_placed',
        apiUrl: flagsmith.apiUrl,
        adminKey: 'k',
        proxyUrl: 'http://proxy.invalid:8080',
        shopUrl: 'https://turnout.example.com',
        dashboardUrl: 'http://127.0.0.1:8000',
        previewToken: 'preview-token-secret',
        rates: parseRates(DEFAULT_RATES),
      },
    });
    await listen(server);
    const viewers = listenForPublic(server, 0, '127.0.0.1');
    await once(viewers, 'listening');
    pub = `http://127.0.0.1:${(viewers.address() as AddressInfo).port}`;
  });
  after(() => {
    server.close();
    flagsmith.close();
  });

  test('GET /judge: the judge page, read-only, assets and API under /judge/, its own token', async () => {
    const res = await fetch(`${pub}/judge`, { headers: { host: 'turnout.example.com' } });
    assert.equal(res.status, 200);
    const html = await res.text();
    token = html.match(/name="turnout-console" content="([^"]+)"/)?.[1] ?? '';
    assert.ok(token);
    assert.match(html, /<meta name="turnout-readonly" content="1">/);
    assert.match(html, /<meta name="turnout-base" content="\/judge">/);
    assert.match(html, /src="\/judge\/v\/[\w-]+\/demo\.js"/, 'the same page as /judge, its assets under /judge/');
    assert.doesNotMatch(html, /(href|src)="\/[a-z-]+\.(css|js|svg)"/, 'no asset left at the root, where the app lives');
    assert.equal((await fetch(`${pub}/judge/demo.js`)).status, 200);
    // Versioned: this start's URLs, and the modules a script imports resolve under the same version.
    const versioned = html.match(/src="(\/judge\/v\/[\w-]+\/)demo\.js"/)?.[1];
    assert.ok(versioned);
    assert.equal((await fetch(`${pub}${versioned}menu.js`)).status, 200, 'an import, under the version');
    assert.equal((await fetch(`${pub}/judge/v/x/../../index.html`)).status, 404);
    assert.equal((await fetch(`${pub}/judge/style.css`)).status, 200);
  });

  test('state without the preview link, tokens or the admin password', async () => {
    const res = await fetch(`${pub}/judge/api/judge/state`, { headers: { 'x-turnout-console': token } });
    assert.equal(res.status, 200);
    const text = await res.text();
    const body = JSON.parse(text);
    assert.equal(body.readOnly, true);
    assert.equal(body.links.preview, null);
    assert.equal(body.links.experiment, null, "Flagsmith's dashboard is private: no links to it");
    assert.equal(body.links.flag, null);
    assert.equal(body.dashboardUrl, null);
    assert.equal(body.autopilot.enabled, true);
    assert.ok(['starting', 'waiting'].includes(body.autopilot.phase), body.autopilot.phase);
    for (const secret of ['preview-token-secret', 'judge-token-0123456789', 'admin-password-123']) assert.ok(!text.includes(secret), 'no secret in the public state');
    assert.equal((await fetch(`${pub}/judge/api/judge/state`)).status, 403, 'the page token is required');
  });

  test('a write from the private console pauses the autopilot', async () => {
    const port = (server.address() as AddressInfo).port;
    const page = await (await fetch(`http://127.0.0.1:${port}/judge`)).text();
    const own = page.match(/name="turnout-console" content="([^"]+)"/)?.[1] ?? '';
    await fetch(`http://127.0.0.1:${port}/api/judge/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-turnout-console': own },
      body: JSON.stringify({ action: 'not-an-action' }),
    });
    const body = (await (await fetch(`${pub}/judge/api/judge/state`, { headers: { 'x-turnout-console': token } })).json()) as { autopilot: { phase: string; pausedUntil: string | null } };
    assert.equal(body.autopilot.phase, 'paused');
    assert.ok(body.autopilot.pausedUntil);
  });

  test('the console, read-only, at /judge/console: the same page, its state without Flagsmith links or secrets', async () => {
    const page = await fetch(`${pub}/judge/console`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<meta name="turnout-readonly" content="1">/);
    assert.match(html, /<meta name="turnout-base" content="\/judge">/);
    assert.match(html, /src="\/judge\/v\/[\w-]+\/app\.js"/, "the console's script, its assets under /judge/");
    const res = await fetch(`${pub}/judge/api/state`, { headers: { 'x-turnout-console': token } });
    assert.equal(res.status, 200);
    const text = await res.text();
    const body = JSON.parse(text);
    assert.equal(body.readOnly, true);
    assert.equal(body.site.dashboardUrl, null, "Flagsmith's dashboard stays private");
    assert.equal(body.site.url, 'https://turnout.example.com', 'be a visitor: the public site itself');
    for (const secret of ['preview-token-secret', 'judge-token-0123456789', 'admin-password-123']) assert.ok(!text.includes(secret), 'no secret');
    assert.equal((await fetch(`${pub}/judge/api/state`)).status, 403, 'the page token is required');
  });

  test('the Flagsmith feature map, read-only, at /judge/flagsmith: no link into the private dashboard', async () => {
    const page = await fetch(`${pub}/judge/flagsmith`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<meta name="turnout-readonly" content="1">/);
    assert.match(html, /src="\/judge\/v\/[\w-]+\/flagsmith\.js"/);
    const res = await fetch(`${pub}/judge/api/flagsmith-map`, { headers: { 'x-turnout-console': token } });
    assert.equal(res.status, 200);
    const text = await res.text();
    const map = JSON.parse(text);
    assert.equal(map.flagsmith.dashboardUrl, '');
    assert.ok(map.items.length > 10);
    assert.ok(map.items.every((i: { link: unknown }) => i.link === null), 'no "Open in Flagsmith" links');
    for (const secret of ['preview-token-secret', 'judge-token-0123456789', 'admin-password-123']) assert.ok(!text.includes(secret), 'no secret');
    assert.equal((await fetch(`${pub}/judge/api/flagsmith-map`)).status, 403, 'the page token is required');
  });

  test('every write, every other page and every other API answer is refused', async () => {
    const post = await fetch(`${pub}/judge/api/judge/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-turnout-console': token },
      body: JSON.stringify({ action: 'visitors' }),
    });
    assert.equal(post.status, 405);
    for (const method of ['PUT', 'DELETE', 'PATCH']) assert.equal((await fetch(`${pub}/judge`, { method })).status, 405);
    const h = { 'x-turnout-console': token, host: 'localhost' };
    for (const path of ['/', '/setup', '/flagsmith', '/api/state', '/api/doctor', '/api/judge/state', '/judge/api/doctor',
      '/judge/api/guard', '/judge/api/judge/signin', '/judge/judge.html', '/judge/setup.html', '/judge/index.html', '/judge/../index.html']) {
      const res = await fetch(`${pub}${path}`, { headers: h });
      assert.equal(res.status, 404, path);
    }
  });
});

describe('public play (server mode): visitors run the guided demo, nothing else', () => {
  let flagsmith: Awaited<ReturnType<typeof startFlagsmith>>;
  let server: http.Server;
  let pub = '';
  let token = '';
  const realUi = fileURLToPath(new URL('../src/console/ui/', import.meta.url));

  before(async () => {
    flagsmith = await startFlagsmith(initialState());
    server = createConsole({
      experiments: () => latestExperiment(new AdminClient(flagsmith.apiUrl, { apiKey: 'k' }), ENV, 'shop_release'),
      feedUrl: 'http://127.0.0.1:9',
      snapshotDir: mkdtempSync(join(tmpdir(), 'sy-play-snap-')),
      ledgerDir: mkdtempSync(join(tmpdir(), 'sy-play-ledger-')),
      uiDir: realUi,
      judgeToken: 'judge-token-0123456789',
      flagsmithLogin: { email: 'a@example.com', password: 'admin-password-123' },
      publicPlay: true,
      judge: {
        flag: 'shop_release', releases: RELEASES, goal: 'order_placed', apiUrl: flagsmith.apiUrl, adminKey: 'k',
        proxyUrl: 'http://proxy.invalid:8080', shopUrl: 'https://shop.turnout.example.com', dashboardUrl: 'http://127.0.0.1:8000',
        previewToken: 'preview-token-secret', rates: parseRates(DEFAULT_RATES),
      },
    });
    await listen(server);
    const viewers = listenForPublic(server, 0, '127.0.0.1');
    await once(viewers, 'listening');
    pub = `http://127.0.0.1:${(viewers.address() as AddressInfo).port}`;
    const html = await (await fetch(`${pub}/judge`)).text();
    token = html.match(/name="turnout-console" content="([^"]+)"/)?.[1] ?? '';
    assert.match(html, /<meta name="turnout-public-play" content="1">/);
  });
  after(() => {
    server.close();
    flagsmith.close();
  });

  const post = (body: object, t = token) =>
    fetch(`${pub}/judge/api/judge/run`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-turnout-console': t }, body: JSON.stringify(body) });

  test('a step outside the guided demo is refused; the page token is required', async () => {
    for (const action of ['reset', 'release', 'preview', 'swing-back']) assert.equal((await post({ action })).status, 403, action);
    assert.equal((await post({ action: 'start', arms: 2 }, 'wrong')).status, 403);
  });

  test("a guided step runs, and a second click within seconds is held back", async () => {
    // Through the public gate to the judge, which then asks for the experiment: a 400 from the judge, not the gate's
    // 403. (A real start left a background job running that could keep this file from finishing.)
    const first = await post({ action: 'score' });
    assert.equal(first.status, 400, 'a guided step reaches the judge');
    assert.match(((await first.json()) as { error: string }).error, /experimentId is required/);
    assert.equal((await post({ action: 'visitors' })).status, 429, 'one step at a time');
  });

  test("another visitor can't start a new test over someone's test in progress", async () => {
    const other = await fetch(`${pub}/judge/api/judge/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-turnout-console': token, 'x-forwarded-for': '203.0.113.9' },
      body: JSON.stringify({ action: 'start', arms: 3 }),
    });
    assert.equal(other.status, 409);
    assert.match(((await other.json()) as { error: string }).error, /Someone else is running a test/);
  });

  test('Take over and hand back reach the gate (404 here: this console runs no autopilot)', async () => {
    const res = await fetch(`${pub}/judge/api/judge/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-turnout-console': token, 'x-forwarded-for': '198.51.100.7' },
      body: JSON.stringify({ action: 'take-over' }),
    });
    assert.equal(res.status, 404, 'past the 403 for unknown steps');
    assert.match(((await res.json()) as { error: string }).error, /No autopilot/);
  });

  test('every other write stays refused', async () => {
    for (const method of ['PUT', 'DELETE', 'PATCH']) assert.equal((await fetch(`${pub}/judge`, { method })).status, 405);
    assert.equal((await fetch(`${pub}/judge/api/ship`, { method: 'POST', headers: { 'x-turnout-console': token } })).status, 405);
  });
});

// The autopilot rests while nobody watches. The public page is who it runs for, so the public page's own state polls
// must wake it: before this, only the private console's reads counted, and the live demo stood still for good.
describe('the public page keeps the autopilot awake', () => {
  test('idle after 3 minutes without a viewer; one public state read wakes it', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const flagsmith = await startFlagsmith(initialState());
    const server = createConsole({
      experiments: () => latestExperiment(new AdminClient(flagsmith.apiUrl, { apiKey: 'k' }), ENV, 'shop_release'),
      feedUrl: 'http://127.0.0.1:9',
      snapshotDir: mkdtempSync(join(tmpdir(), 'sy-wake-snap-')),
      ledgerDir: mkdtempSync(join(tmpdir(), 'sy-wake-ledger-')),
      uiDir: fileURLToPath(new URL('../src/console/ui/', import.meta.url)),
      autopilot: { pauseMs: 3_600_000 }, // on, but its first step is an hour away
      judge: {
        flag: 'shop_release', releases: RELEASES, goal: 'order_placed', apiUrl: flagsmith.apiUrl, adminKey: 'k',
        proxyUrl: 'http://proxy.invalid:8080', shopUrl: 'https://turnout.example.com', dashboardUrl: 'http://127.0.0.1:8000',
        previewToken: 'preview-token-secret', rates: parseRates(DEFAULT_RATES),
      },
    });
    await listen(server);
    const viewers = listenForPublic(server, 0, '127.0.0.1');
    await once(viewers, 'listening');
    const pub = `http://127.0.0.1:${(viewers.address() as AddressInfo).port}`;
    try {
      const html = await (await fetch(`${pub}/judge`, { headers: { host: 'turnout.example.com' } })).text();
      const token = html.match(/name="turnout-console" content="([^"]+)"/)?.[1] ?? '';
      const phase = async () => ((await (await fetch(`${pub}/judge/api/judge/state`, { headers: { 'x-turnout-console': token } })).json()) as { autopilot: { phase: string } }).autopilot.phase;
      const settle = () => new Promise((r) => setTimeout(r, 1300)); // one autopilot poll (real timers)
      t.mock.timers.tick(4 * 60_000); // nobody looked for 4 minutes
      await settle();
      assert.equal(await phase(), 'idle', 'resting while nobody watched');
      await settle();
      assert.notEqual(await phase(), 'idle', 'the public read above woke it');
    } finally {
      viewers.close();
      server.close();
      flagsmith.close();
    }
  });
});
