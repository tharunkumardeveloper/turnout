import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Experiments } from '../src/flagsmith/experiments.ts';
import { healthPayload, identitiesIn, losingFor, REFRESH_EVERY_MS, Watcher, type WatchOptions } from '../src/health.ts';
import { initialState } from './fake-flagsmith.ts';

// Experiment 7 (shop:1.5 vs shop:1.4) with doc_latency_ms losing badly on v2.
function losingState(chance = 0.0004) {
  const s = initialState();
  s.results!.payload!.metrics.push({
    metric_id: 2,
    variants: { control: { n: 1000, sum: 13_000, sum_squares: 0 }, v2: { n: 1000, sum: 79_000, sum_squares: 0 } },
    inference: { v2: { lift: 5.04, ci_low: 4.8, ci_high: 5.3, chance_to_win: chance } },
  });
  return s;
}

function fakeExperiments(state: ReturnType<typeof initialState>) {
  const calls = { refresh: 0 };
  const exps = {
    detail: async () => structuredClone(state.experiment),
    results: async () => structuredClone(state.results),
    refreshResults: async () => {
      calls.refresh++;
      return { ok: true as const };
    },
  } as unknown as Experiments;
  return { exps, calls };
}

function watcher(state: ReturnType<typeof initialState>, over: Partial<WatchOptions> = {}) {
  const posts: { status: string; reason: { text_blocks: { title?: string; text: string }[] } }[] = [];
  const reverts: string[] = [];
  const { exps, calls } = fakeExperiments(state);
  let now = Date.parse('2026-11-17T12:00:00Z');
  const w = new Watcher({
    experiments: async () => exps,
    flag: 'shop_release',
    environmentName: 'Production',
    healthWebhookUrl: 'http://flagsmith.test/api/v1/feature-health/secret',
    guard: { enabled: false },
    lock: { busy: false },
    revert: async (_e, reason) => {
      reverts.push(reason);
      state.experiment.status = 'completed';
    },
    fetch: (async (_url: string, init: RequestInit) => {
      posts.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 200 });
    }) as typeof fetch,
    now: () => now,
    ...over,
  });
  return { w, posts, reverts, calls, advance: (ms: number) => (now += ms) };
}

describe('health summary', () => {
  test('losingFor names the release, the metric and both means, as returned', () => {
    const s = losingState();
    assert.deepEqual(losingFor(s.experiment, s.results), [
      { metric: 'doc_latency_ms', chanceToWin: 0.0004, lift: 5.04, variant: 'v2', release: 'shop:1.5', control: 13, treatment: 79 },
    ]);
    assert.equal(identitiesIn(s.results), 2000);
    assert.deepEqual(losingFor(initialState().experiment, initialState().results), []);
  });

  test("the payload is Flagsmith's Webhook provider format", () => {
    const s = losingState();
    const p = healthPayload({ flag: 'shop_release', environmentName: 'Production', status: 'unhealthy', experiment: s.experiment, results: s.results, losing: losingFor(s.experiment, s.results), links: [{ title: 'Results', url: 'http://x' }] });
    assert.equal(p.feature, 'shop_release');
    assert.equal(p.environment, 'Production');
    assert.equal(p.status, 'unhealthy');
    assert.equal(p.reason.text_blocks[0]!.title, 'shop:1.5 is losing the doc_latency_ms guardrail');
    assert.match(p.reason.text_blocks[0]!.text, /79 on shop:1\.5 vs 13 on control; chance to win 0\.0%/);
    assert.deepEqual(p.reason.url_blocks, [{ title: 'Results', url: 'http://x' }]);
  });
});

describe('the health bridge', () => {
  test('reports unhealthy once while a guardrail is losing, and healthy when the experiment completes', async () => {
    const s = losingState();
    const { w, posts, reverts } = watcher(s);
    await w.tick();
    await w.tick();
    assert.deepEqual(posts.map((p) => p.status), ['unhealthy'], 'only on a change');
    assert.deepEqual(reverts, [], 'the guard is off');
    assert.match(posts[0]!.reason.text_blocks.at(-1)!.text, /Revert it from the Turnover console/);

    s.experiment.status = 'completed';
    await w.tick();
    assert.deepEqual(posts.map((p) => p.status), ['unhealthy', 'healthy']);
    assert.equal(w.snapshot().health.last?.status, 'healthy');
  });

  test('a healthy running experiment reports healthy; no webhook means no reports', async () => {
    const { w, posts } = watcher(initialState());
    await w.tick();
    assert.deepEqual(posts.map((p) => p.status), ['healthy']);
    const quiet = watcher(losingState(), { healthWebhookUrl: undefined });
    await quiet.w.tick();
    assert.equal(quiet.posts.length, 0);
    assert.equal(quiet.w.snapshot().health.enabled, false);
  });

  test('a failed delivery is retried on the next check', async () => {
    let fail = true;
    const { w } = watcher(losingState(), {
      fetch: (async () => new Response(null, { status: fail ? 502 : 200 })) as unknown as typeof fetch,
    });
    await w.tick();
    assert.equal(w.snapshot().health.last?.delivered, false);
    fail = false;
    await w.tick();
    assert.equal(w.snapshot().health.last?.delivered, true);
  });
});

describe('the guard', () => {
  test('reverts when a guardrail is clearly losing, writes why, then reports healthy', async () => {
    const s = losingState();
    const { w, posts, reverts } = watcher(s, { guard: { enabled: true } });
    await w.tick();
    assert.deepEqual(reverts, ['shop:1.5 losing doc_latency_ms, 0.0% chance to win']);
    assert.equal(w.snapshot().guard.lastAction?.ok, true);
    assert.deepEqual(posts.map((p) => p.status), ['healthy']);
    assert.match(posts[0]!.reason.text_blocks[0]!.text, /guard reverted experiment 7/);
  });

  test('never acts on thin data, above its threshold, or while another action holds the lock', async () => {
    const thin = losingState();
    for (const m of thin.results!.payload!.metrics) for (const v of Object.values(m.variants)) v.n = 40;
    assert.deepEqual((await run(thin, { guard: { enabled: true } })).reverts, [], 'under 100 identities');
    assert.deepEqual((await run(losingState(0.03), { guard: { enabled: true } })).reverts, [], 'losing, but above 1%');
    const busy = await run(losingState(), { guard: { enabled: true }, lock: { busy: true } });
    assert.deepEqual(busy.reverts, [], 'a Ship or a job is running');
    assert.deepEqual(busy.posts.map((p) => p.status), ['unhealthy'], 'it still reports');
  });

  test('asks Flagsmith for fresh results at most once per 5 minutes, only while guarding a running experiment', async () => {
    const s = initialState();
    s.results!.as_of = '2026-11-17T11:00:00Z'; // an hour old
    const { w, calls, advance } = watcher(s, { guard: { enabled: true } });
    await w.tick();
    await w.tick();
    assert.equal(calls.refresh, 1);
    advance(REFRESH_EVERY_MS);
    await w.tick();
    assert.equal(calls.refresh, 2);
    w.setGuard(false);
    advance(REFRESH_EVERY_MS);
    await w.tick();
    assert.equal(calls.refresh, 2, 'guard off: no automatic refreshes');
  });

  test('the guard can be switched on at runtime', async () => {
    const s = losingState();
    const { w, reverts } = watcher(s);
    await w.tick();
    assert.equal(reverts.length, 0);
    assert.equal(w.setGuard(true).guard.enabled, true);
    await w.tick();
    assert.equal(reverts.length, 1);
  });
});

async function run(state: ReturnType<typeof initialState>, over: Partial<WatchOptions>) {
  const r = watcher(state, over);
  await r.w.tick();
  return r;
}

test('the guard leaves a just-started experiment alone (nothing to score yet)', async () => {
  const s = initialState();
  s.results = null;
  s.experiment.started_at = '2026-11-17T11:58:00Z'; // two minutes before the watcher's clock
  const { w, calls } = watcher(s, { guard: { enabled: true } });
  await w.tick();
  assert.equal(calls.refresh, 0);
});

describe('a practical minimum for guardrails', () => {
  test('a sure but tiny harm (0.7 ms on 120 ms) is not losing, so neither reported nor reverted', () => {
    const s = initialState();
    s.results!.payload!.metrics.push({
      metric_id: 2,
      variants: { control: { n: 1000, sum: 120_000, sum_squares: 0 }, v2: { n: 1000, sum: 120_700, sum_squares: 0 } },
      inference: { v2: { lift: 0.0058, ci_low: 0.004, ci_high: 0.008, chance_to_win: 0.0001 } },
    });
    assert.deepEqual(losingFor(s.experiment, s.results), []);
    const big = losingState();
    assert.equal(losingFor(big.experiment, big.results).length, 1, 'a 504% rise still is');
  });
});
