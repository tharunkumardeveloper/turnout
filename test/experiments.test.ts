import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { AdminClient } from '../src/flagsmith/admin.ts';
import {
  Experiments,
  parseExperimentRef,
  losingGuardrails,
  pickWinner,
  recommend,
  GUARDRAIL_MIN_ABSOLUTE,
  GUARDRAIL_MIN_HARM,
  planRevert,
  planShip,
  releaseOf,
  runSteps,
  snapshotFileOf,
  variantKey,
  vitalsComparable,
  VITALS_MAX_RATE_GAP,
  type StepResult,
} from '../src/flagsmith/experiments.ts';
import { ENV, initialState, startFakeFlagsmith, type FakeState } from './fake-flagsmith.ts';

async function setup(state: FakeState) {
  const fake = await startFakeFlagsmith(state);
  const api = new AdminClient(fake.apiUrl, { apiKey: 'test' });
  const exp = new Experiments(api, { envKey: ENV, experimentId: state.experiment.id });
  const snapshots = mkdtempSync(join(tmpdir(), 'sy-snap-'));
  return { fake, exp, snapshots };
}

const writes = (state: FakeState) => state.requests.filter((r) => !r.startsWith('GET'));

describe('pickWinner (Flagsmith results-page rule)', () => {
  test('a treatment above 50% wins', () => {
    const s = initialState();
    assert.deepEqual(pickWinner(s.experiment, s.results), { key: 'v2', chanceToWin: 0.967, isControl: false });
  });

  test('control wins when the treatments are below its bound', () => {
    const s = initialState();
    s.results!.payload!.metrics[0]!.inference.v2!.chance_to_win = 0.237;
    const w = pickWinner(s.experiment, s.results);
    assert.equal(w?.key, 'control');
    assert.ok(Math.abs(w!.chanceToWin - 0.763) < 1e-9);
  });

  test('no winner without results, or while a treatment has no inference yet', () => {
    const s = initialState();
    assert.equal(pickWinner(s.experiment, null), null);
    s.results!.payload!.metrics[0]!.inference.v2 = null;
    assert.equal(pickWinner(s.experiment, s.results), null);
  });

  test('uses the primary (first) metric only', () => {
    const s = initialState();
    s.experiment.metrics.reverse();
    assert.equal(pickWinner(s.experiment, s.results), null);
  });

  test('with two treatments, control is best only above 1 - their total', () => {
    const s = initialState();
    s.experiment.feature.multivariate_options.push({ id: 12, key: 'v3', string_value: 'shop:1.6' });
    const inf = s.results!.payload!.metrics[0]!.inference;
    inf.v2!.chance_to_win = 0.237;
    inf.v3 = { lift: 0, ci_low: -0.1, ci_high: 0.1, chance_to_win: 0.5 };
    assert.equal(pickWinner(s.experiment, s.results)?.key, 'v3');
  });

  // derive.ts getBestTreatment skips a treatment without inference; getControlChanceToWin stays null until every
  // treatment has one, so control can't win yet.
  test('with two treatments, one still without inference: the other wins and control cannot', () => {
    const s = initialState();
    s.experiment.feature.multivariate_options.push({ id: 12, key: 'v3', string_value: 'shop:1.6' });
    const inf = s.results!.payload!.metrics[0]!.inference;
    inf.v3 = null;
    assert.deepEqual(pickWinner(s.experiment, s.results), { key: 'v2', chanceToWin: 0.967, isControl: false });

    inf.v2!.chance_to_win = 0.1; // control's bound would be 0.9 with v3 at 0, but it isn't known yet
    assert.deepEqual(pickWinner(s.experiment, s.results), { key: 'v2', chanceToWin: 0.1, isControl: false });

    delete inf.v3; // absent from the payload altogether: the same
    assert.equal(pickWinner(s.experiment, s.results)?.key, 'v2');

    inf.v3 = { lift: 0, ci_low: -0.1, ci_high: 0.1, chance_to_win: 0.05 };
    const w = pickWinner(s.experiment, s.results);
    assert.equal(w?.key, 'control', 'once every treatment has inference, control can win');
    assert.ok(Math.abs(w!.chanceToWin - 0.85) < 1e-9);
  });

  test('names an unkeyed option Variant_<n>, as the results page does', () => {
    const s = initialState();
    s.experiment.feature.multivariate_options.push({ id: 12, key: null, string_value: 'shop:1.6' });
    const inf = s.results!.payload!.metrics[0]!.inference;
    inf.v2!.chance_to_win = 0.1;
    // Variant_2 has no inference, so control's bound is unknown and v2 stays best
    assert.equal(pickWinner(s.experiment, s.results)?.key, 'v2');
    inf.Variant_2 = { lift: 0.2, ci_low: 0, ci_high: 0.4, chance_to_win: 0.8 };
    assert.deepEqual(pickWinner(s.experiment, s.results), { key: 'Variant_2', chanceToWin: 0.8, isControl: false });
    assert.equal(releaseOf(s.experiment, 'Variant_2'), 'shop:1.6');
    assert.equal(variantKey({ key: null }, 0), 'Variant_1');
  });
});

describe('parseExperimentRef', () => {
  test('accepts the dashboard link and the short form', () => {
    assert.deepEqual(parseExperimentRef('http://localhost:8000/project/1/environment/abcDEF12/experiments/4'), {
      envKey: 'abcDEF12',
      experimentId: 4,
    });
    assert.deepEqual(parseExperimentRef('abcDEF12/4'), { envKey: 'abcDEF12', experimentId: 4 });
    assert.throws(() => parseExperimentRef('https://example.com'));
  });
});

describe('Ship winner', () => {
  test('pauses, snapshots, sets the default, drains, then completes, in that order', async () => {
    const state = initialState();
    const { fake, exp, snapshots } = await setup(state);
    const log: StepResult[] = [];
    await runSteps(exp, await planShip(exp, 'v2', snapshots), (s) => log.push(s));
    fake.close();

    assert.deepEqual(writes(state), [
      `POST /api/v1/environments/${ENV}/experiments/7/pause/`,
      `PATCH /api/__future__/environments/${ENV}/features/3/`,
      `PATCH /api/v1/environments/${ENV}/experiments/7/rollout/`,
      `POST /api/v1/environments/${ENV}/experiments/7/complete/`,
    ]);
    assert.equal(state.experiment.status, 'completed');
    assert.deepEqual(state.flag.environment_default, {
      enabled: true,
      value: { type: 'string', value: 'shop:1.4' },
      variants: [{ id: 11, weight: 100 }],
    });
    assert.equal(state.experiment.experiment_rollout?.rollout_percentage, 0);
    assert.deepEqual(state.flag.segment_overrides[0]!.variants, [{ id: 11, weight: 100 }]);
    assert.ok(log.every((s) => s.status === 'done'));

    const snapshot = JSON.parse(readFileSync(join(snapshots, (await import('node:fs')).readdirSync(snapshots)[0]!), 'utf8'));
    assert.equal(snapshot.decision, 'v2');
    assert.equal(snapshot.results.payload.metrics[0].inference.v2.chance_to_win, 0.967);
  });

  test('the plan reports the snapshot file it wrote, and none when the step was skipped', async () => {
    const state = initialState();
    const { fake, exp, snapshots } = await setup(state);
    const steps = await planShip(exp, 'v2', snapshots);
    assert.equal(snapshotFileOf(steps), null, 'nothing written before running');
    await runSteps(exp, steps, () => {});
    const file = snapshotFileOf(steps);
    assert.ok(file && file.startsWith(snapshots) && existsSync(file));
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).decision, 'v2');

    const again = await planShip(exp, 'v2', snapshots); // completed: the snapshot step is skipped
    await runSteps(exp, again, () => {});
    fake.close();
    assert.equal(snapshotFileOf(again), null);
  });

  test('ships an unkeyed option by the name the results page gives it', async () => {
    const state = initialState();
    state.experiment.feature.multivariate_options.push({ id: 12, key: null, string_value: 'shop:1.6' });
    state.flag.environment_default.variants.push({ id: 12, weight: 0 });
    const { fake, exp, snapshots } = await setup(state);
    await runSteps(exp, await planShip(exp, 'Variant_2', snapshots), () => {});
    fake.close();
    assert.deepEqual(state.flag.environment_default.variants, [
      { id: 11, weight: 0 },
      { id: 12, weight: 100 },
    ]);
  });

  test('shipping control zeroes every variant', async () => {
    const state = initialState();
    const { fake, exp, snapshots } = await setup(state);
    await runSteps(exp, await planShip(exp, 'control', snapshots), () => {});
    fake.close();
    assert.deepEqual(state.flag.environment_default.variants, [{ id: 11, weight: 0 }]);
    assert.deepEqual(state.flag.segment_overrides[0]!.variants, [{ id: 11, weight: 0 }]);
  });

  test('is safe to re-run after a failure, and does nothing once done', async () => {
    const state = initialState();
    const { fake, exp, snapshots } = await setup(state);
    state.failNext = `PATCH /api/v1/environments/${ENV}/experiments/7/rollout/`;
    await assert.rejects(runSteps(exp, await planShip(exp, 'v2', snapshots), () => {}), /500/);
    assert.equal(state.experiment.status, 'paused');

    state.requests = [];
    const log: StepResult[] = [];
    await runSteps(exp, await planShip(exp, 'v2', snapshots), (s) => log.push(s));
    assert.deepEqual(
      log.map((s) => s.status),
      ['skipped', 'done', 'skipped', 'done', 'done'],
    );
    assert.equal(state.experiment.status, 'completed');

    state.requests = [];
    const again: StepResult[] = [];
    await runSteps(exp, await planShip(exp, 'v2', snapshots), (s) => again.push(s));
    fake.close();
    assert.deepEqual(writes(state), []);
    assert.ok(again.every((s) => s.status === 'skipped'));
  });

  test('refuses a variant the flag does not have', async () => {
    const state = initialState();
    const { fake, exp, snapshots } = await setup(state);
    await assert.rejects(planShip(exp, 'v9', snapshots), /not a variant/);
    fake.close();
    assert.equal(existsSync(join(snapshots, 'x')), false);
  });

  test('stops if a step leaves the flag disabled for everyone', async () => {
    const state = initialState();
    const { fake, exp, snapshots } = await setup(state);
    state.flag.environment_default.enabled = false;
    // the default step sets enabled: true, so simulate a server that ignores it
    const steps = await planShip(exp, 'v2', snapshots);
    steps[2]!.run = async () => undefined;
    steps[2]!.done = () => false;
    await assert.rejects(runSteps(exp, steps, () => {}), /disabled/);
    fake.close();
  });
});

describe('Revert to control', () => {
  test('is Ship with control: default to control, drain, complete, leaving no split', async () => {
    const state = initialState();
    const { fake, exp, snapshots } = await setup(state);
    await runSteps(exp, await planRevert(exp, snapshots), () => {});
    fake.close();
    assert.equal(state.experiment.status, 'completed');
    assert.equal(state.experiment.experiment_rollout?.rollout_percentage, 0);
    assert.deepEqual(state.flag.environment_default.variants, [{ id: 11, weight: 0 }]);
    assert.deepEqual(state.flag.segment_overrides[0]!.variants, [{ id: 11, weight: 0 }]);
    assert.deepEqual(writes(state), [
      `POST /api/v1/environments/${ENV}/experiments/7/pause/`, // the default already serves control: skipped
      `PATCH /api/v1/environments/${ENV}/experiments/7/rollout/`,
      `POST /api/v1/environments/${ENV}/experiments/7/complete/`,
    ]);
  });

  test("puts the default's value back to what control served, if it was edited during the experiment", async () => {
    const state = initialState();
    state.flag.environment_default.value = { type: 'string', value: 'shop:9.9' }; // edited mid-experiment
    const { fake, exp, snapshots } = await setup(state);
    await runSteps(exp, await planRevert(exp, snapshots), () => {});
    fake.close();
    assert.deepEqual(state.flag.environment_default, {
      enabled: true,
      value: { type: 'string', value: 'shop:1.4' }, // the rollout's feature_state_value
      variants: [{ id: 11, weight: 0 }],
    });
    assert.ok(writes(state).includes(`PATCH /api/__future__/environments/${ENV}/features/3/`), 'the default step ran, not skipped');
    assert.equal(releaseOf(state.experiment, 'control'), 'shop:1.4');
  });

  test('refuses a completed experiment', async () => {
    const state = initialState();
    state.experiment.status = 'completed';
    const { fake, exp, snapshots } = await setup(state);
    await assert.rejects(planRevert(exp, snapshots), /completed/);
    fake.close();
  });
});

describe('read-back after each step', () => {
  test('stops when Flagsmith accepts a call but does not show the change', async () => {
    const state = initialState();
    const { fake, exp, snapshots } = await setup(state);
    const steps = await planShip(exp, 'v2', snapshots);
    steps[3]!.run = async () => undefined; // the drain "succeeds" but nothing changes
    await assert.rejects(runSteps(exp, steps, () => {}), /doesn.t show the change/);
    fake.close();
    assert.equal(state.experiment.status, 'paused', 'complete never ran');
  });
});

describe('losingGuardrails', () => {
  test('flags a guardrail whose chance to win is below 5% for the variant being shipped', () => {
    const s = initialState();
    s.results!.payload!.metrics.push({
      metric_id: 2,
      variants: { control: { n: 1000, sum: 6000, sum_squares: 0 }, v2: { n: 1000, sum: 66000, sum_squares: 0 } },
      inference: { v2: { lift: 10, ci_low: 9, ci_high: 11, chance_to_win: 0.001 } },
    });
    assert.deepEqual(losingGuardrails(s.experiment, s.results, 'v2'), [{ metric: 'doc_latency_ms', chanceToWin: 0.001, lift: 10 }]);
    assert.deepEqual(losingGuardrails(s.experiment, s.results, 'control'), [], 'control is the status quo');
    s.results!.payload!.metrics[1]!.inference.v2!.chance_to_win = 0.4;
    assert.deepEqual(losingGuardrails(s.experiment, s.results, 'v2'), []);
  });

  test('a secondary metric (expected to increase) is never a guardrail', () => {
    const s = initialState();
    s.experiment.metrics[1]!.expected_direction = 'increase';
    s.results!.payload!.metrics.push({
      metric_id: s.experiment.metrics[1]!.metric,
      variants: { control: { n: 1000, sum: 300, sum_squares: 0 }, v2: { n: 1000, sum: 200, sum_squares: 0 } },
      inference: { v2: { lift: -0.33, ci_low: -0.4, ci_high: -0.2, chance_to_win: 0.001 } },
    });
    assert.deepEqual(losingGuardrails(s.experiment, s.results, 'v2'), []);
  });

  test('a practical minimum: a sure but tiny harm (under 5% relative) is not losing', () => {
    const s = initialState();
    s.results!.payload!.metrics.push({
      metric_id: 2,
      variants: { control: { n: 1000, sum: 300_000, sum_squares: 0 }, v2: { n: 1000, sum: 300_700, sum_squares: 0 } },
      inference: { v2: { lift: 0.002, ci_low: 0.001, ci_high: 0.003, chance_to_win: 0.001 } }, // 0.7 ms on 300 ms
    });
    assert.equal(GUARDRAIL_MIN_HARM, 0.05);
    assert.deepEqual(losingGuardrails(s.experiment, s.results, 'v2'), [], '0.6% slower is not a loss worth blocking');
    s.results!.payload!.metrics[1]!.inference.v2!.lift = 0.08;
    s.results!.payload!.metrics[1]!.variants.v2!.sum = 324_000; // 24 ms slower
    assert.equal(losingGuardrails(s.experiment, s.results, 'v2').length, 1, '8% slower is');
    assert.deepEqual(losingGuardrails(s.experiment, s.results, 'v2', 0.1), [], 'the minimum is configurable');
    s.results!.payload!.metrics[1]!.inference.v2!.lift = -0.08;
    s.results!.payload!.metrics[1]!.variants.v2!.sum = 276_000;
    assert.deepEqual(losingGuardrails(s.experiment, s.results, 'v2'), [], 'down is better: 8% faster is no harm');
    s.experiment.metrics[1]!.direction = 'up';
    assert.equal(losingGuardrails(s.experiment, s.results, 'v2').length, 1, 'up is better: an 8% fall is harm');
  });

  test('a page-speed floor: under 20 ms slower is never a loss, however sure and however large in percent', () => {
    const s = initialState();
    s.results!.payload!.metrics.push({
      metric_id: 2,
      variants: { control: { n: 1000, sum: 30_000, sum_squares: 0 }, v2: { n: 1000, sum: 45_000, sum_squares: 0 } },
      inference: { v2: { lift: 0.5, ci_low: 0.45, ci_high: 0.55, chance_to_win: 0.0 } }, // 15 ms on 30 ms: +50%
    });
    assert.equal(GUARDRAIL_MIN_ABSOLUTE.doc_latency_ms, 20);
    assert.deepEqual(losingGuardrails(s.experiment, s.results, 'v2'), [], '15 ms slower is under the floor');
    s.results!.payload!.metrics[1]!.variants.v2!.sum = 101_000; // 71 ms slower, like shop:1.6's test fault
    assert.equal(losingGuardrails(s.experiment, s.results, 'v2').length, 1, '71 ms slower is a loss');
  });

  // The vitals_reported metric (metric 9), with each version's share of visitors whose browser reported page speed.
  const withReported = (s: FakeState, control: number, v2: number) => {
    s.experiment.metrics.push({ metric: 9, metric_name: 'vitals_reported', expected_direction: 'increase', direction: 'up' } as never);
    s.results!.payload!.metrics.push({ metric_id: 9, variants: { control: { n: 100, sum: control * 100, sum_squares: 0 }, v2: { n: 100, sum: v2 * 100, sum_squares: 0 } }, inference: {} });
  };

  test('real-browser page speed: 100 ms of largest paint and 0.02 of layout shift are the floors', () => {
    const s = initialState();
    s.experiment.metrics[1]!.metric_name = 'lcp_ms';
    s.results!.payload!.metrics.push({
      metric_id: 2,
      variants: { control: { n: 100, sum: 15_200, sum_squares: 0 }, v2: { n: 100, sum: 23_600, sum_squares: 0 } },
      inference: { v2: { lift: 0.55, ci_low: 0.41, ci_high: 0.69, chance_to_win: 0.0 } }, // 152 ms → 236 ms: 84 ms
    });
    withReported(s, 0.95, 0.94); // both versions' browsers reported about as often
    assert.equal(GUARDRAIL_MIN_ABSOLUTE.lcp_ms, 100);
    assert.deepEqual(losingGuardrails(s.experiment, s.results, 'v2'), [], '84 ms later is under the floor');
    s.results!.payload!.metrics[1]!.variants.v2!.sum = 45_200; // 300 ms later
    assert.equal(losingGuardrails(s.experiment, s.results, 'v2')[0]?.metric, 'lcp_ms', '300 ms later is a loss');

    s.experiment.metrics[1]!.metric_name = 'cls';
    s.results!.payload!.metrics[1]!.variants = { control: { n: 100, sum: 1, sum_squares: 0 }, v2: { n: 100, sum: 2.5, sum_squares: 0 } }; // 0.010 → 0.025
    s.results!.payload!.metrics[1]!.inference.v2 = { lift: 1.5, ci_low: 1.2, ci_high: 1.8, chance_to_win: 0.0 };
    assert.equal(GUARDRAIL_MIN_ABSOLUTE.cls, 0.02);
    assert.deepEqual(losingGuardrails(s.experiment, s.results, 'v2'), [], 'a layout shift 0.015 bigger is under the floor');
    s.results!.payload!.metrics[1]!.variants.v2!.sum = 24; // 0.24, a banner pushing the page down
    assert.equal(losingGuardrails(s.experiment, s.results, 'v2')[0]?.metric, 'cls', 'a page that jumps is a loss');
  });

  test("browser page speed decides only when both versions' visitors reported it about as often", () => {
    const losingLcp = (control: number | null, v2: number | null) => {
      const s = initialState();
      s.experiment.metrics[1]!.metric_name = 'lcp_ms';
      if (control !== null && v2 !== null) withReported(s, control, v2);
      s.results!.payload!.metrics.push({
        metric_id: 2,
        variants: { control: { n: 100, sum: 15_000, sum_squares: 0 }, v2: { n: 100, sum: 45_000, sum_squares: 0 } }, // 300 ms later
        inference: { v2: { lift: 2, ci_low: 1.8, ci_high: 2.2, chance_to_win: 0.0 } },
      });
      return { s, losing: losingGuardrails(s.experiment, s.results, 'v2') };
    };
    assert.equal(losingLcp(0.95, 0.93).losing.length, 1, '2 points apart: compared');
    assert.deepEqual(losingLcp(0.95, 0.80).losing, [], '15 points apart: a visitor who left before reporting counts as 0, so not compared');
    assert.deepEqual(losingLcp(null, null).losing, [], 'no vitals_reported metric: rates unknown, not compared');
    const { s } = losingLcp(0.95, 0.8);
    assert.match(vitalsComparable(s.experiment, s.results, 'v2').note!, /80% of v2's visitors reported it against 95% of control's/);
    // The recommendation says why.
    assert.match((recommend(s.experiment, s.results).notes ?? [])[0]!, /page speed in browsers not compared/);
    assert.equal(VITALS_MAX_RATE_GAP, 0.05);
  });

  test('ignores the primary metric and missing results', () => {
    const s = initialState();
    s.results!.payload!.metrics[0]!.inference.v2!.chance_to_win = 0.01;
    assert.deepEqual(losingGuardrails(s.experiment, s.results, 'v2'), []);
    assert.deepEqual(losingGuardrails(s.experiment, null, 'v2'), []);
  });
});

describe('recommend: read the credible interval, not just the chance to win', () => {
  const goal = (s: FakeState) => s.results!.payload!.metrics[0]!.inference.v2!;
  const withGuardrail = (s: FakeState, lift: number, chance: number) =>
    s.results!.payload!.metrics.push({
      metric_id: 2,
      variants: { control: { n: 1000, sum: 60_000, sum_squares: 0 }, v2: { n: 1000, sum: 90_000, sum_squares: 0 } },
      inference: { v2: { lift, ci_low: lift - 0.1, ci_high: lift + 0.1, chance_to_win: chance } },
    });

  test('96.7% chance to win but an interval crossing zero: keep running', () => {
    const s = initialState(); // v2: lift 30%, interval -2% to +62%
    const r = recommend(s.experiment, s.results);
    assert.equal(r.call, 'keep-running');
    assert.equal(r.reason, 'interval −2% to +62% crosses zero');
    assert.deepEqual(r.interval, { low: -0.02, high: 0.62 });
    assert.equal(r.variant, 'v2');
    assert.equal(r.chanceToWin, 0.967);
  });

  test('an interval clearing zero with 95%+ chance to win: ship', () => {
    const s = initialState();
    goal(s).ci_low = 0.05;
    const r = recommend(s.experiment, s.results);
    assert.equal(r.call, 'ship');
    assert.match(r.reason, /\+5% to \+62% clears zero, 96\.7% chance to win/);
  });

  test('an interval clearing zero but under 95% chance to win: keep running', () => {
    const s = initialState();
    Object.assign(goal(s), { ci_low: 0.01, chance_to_win: 0.9 });
    const r = recommend(s.experiment, s.results);
    assert.equal(r.call, 'keep-running');
    assert.equal(r.reason, 'chance to win 90.0% is under 95%');
  });

  test('the whole interval on the losing side: revert', () => {
    const s = initialState();
    Object.assign(goal(s), { lift: -0.2, ci_low: -0.3, ci_high: -0.1, chance_to_win: 0.01 });
    assert.equal(recommend(s.experiment, s.results).call, 'revert');
  });

  test('a losing guardrail: revert, even with a clear win on the goal', () => {
    const s = initialState();
    goal(s).ci_low = 0.05;
    withGuardrail(s, 0.4, 0.001);
    const r = recommend(s.experiment, s.results);
    assert.equal(r.call, 'revert');
    assert.match(r.reason, /v2 is losing doc_latency_ms \(lift \+40%, 0\.1% chance to win\)/);
  });

  test('a tiny guardrail harm does not stop a ship', () => {
    const s = initialState();
    goal(s).ci_low = 0.05;
    withGuardrail(s, 0.006, 0.001);
    assert.equal(recommend(s.experiment, s.results).call, 'ship');
  });

  // An A/B/C test: v2 and v3 against control, each scored on its own (Flagsmith's compare_to_control).
  const abc = (v3goal: object, v3latency: object | null) => {
    const s = initialState();
    s.experiment.feature.multivariate_options.push({ id: 12, key: 'v3', string_value: 'shop:1.6' });
    goal(s).ci_low = 0.05; // v2: a clear win on the goal
    s.results!.payload!.metrics[0]!.variants.v3 = { n: 1000, sum: 150, sum_squares: 150 };
    s.results!.payload!.metrics[0]!.inference.v3 = { lift: 0.5, ci_low: 0.2, ci_high: 0.8, chance_to_win: 0.999, ...v3goal };
    s.results!.payload!.metrics.push({
      metric_id: 2,
      variants: { control: { n: 1000, sum: 60_000, sum_squares: 0 }, v2: { n: 1000, sum: 61_000, sum_squares: 0 }, v3: { n: 1000, sum: 160_000, sum_squares: 0 } },
      inference: { v2: { lift: 0.016, ci_low: -0.05, ci_high: 0.08, chance_to_win: 0.4 }, ...(v3latency ? { v3: v3latency as any } : {}) },
    });
    return s;
  };

  test('A/B/C: the best treatment fails a guardrail, the other is safe and clearly better: ship the safe one', () => {
    const s = abc({}, { lift: 1.6, ci_low: 1.5, ci_high: 1.7, chance_to_win: 0.0001 });
    const r = recommend(s.experiment, s.results);
    assert.equal(r.call, 'ship');
    assert.equal(r.variant, 'v2');
  });

  test('A/B/C: both safe and clearly better: ship the one Flagsmith is surest of', () => {
    const s = abc({}, { lift: 0, ci_low: -0.05, ci_high: 0.05, chance_to_win: 0.5 });
    assert.equal(recommend(s.experiment, s.results).variant, 'v3');
  });

  test('A/B/C: one still undecided and the other failing: keep running for the undecided one', () => {
    const s = abc({}, { lift: 1.6, ci_low: 1.5, ci_high: 1.7, chance_to_win: 0.0001 });
    goal(s).ci_low = -0.02; // v2's interval crosses zero again
    const r = recommend(s.experiment, s.results);
    assert.equal(r.call, 'keep-running');
    assert.equal(r.variant, 'v2');
  });

  test('A/B/C: every treatment failing: revert, naming each reason', () => {
    const s = abc({}, { lift: 1.6, ci_low: 1.5, ci_high: 1.7, chance_to_win: 0.0001 });
    Object.assign(goal(s), { lift: -0.2, ci_low: -0.3, ci_high: -0.1, chance_to_win: 0.01 });
    const r = recommend(s.experiment, s.results);
    assert.equal(r.call, 'revert');
    assert.match(r.reason, /v3 is losing doc_latency_ms/);
    assert.match(r.reason, /control is better: v2's interval/);
  });

  test('no inference yet: keep running, no interval', () => {
    const s = initialState();
    s.results!.payload!.metrics[0]!.inference.v2 = null;
    assert.deepEqual(recommend(s.experiment, s.results), {
      call: 'keep-running', variant: null, reason: 'Flagsmith has no result on the goal yet', interval: null, chanceToWin: null,
    });
    assert.equal(recommend(s.experiment, null).call, 'keep-running');
  });
});

describe('settleText: what it would take to settle an interval crossing zero', () => {
  test("read off Flagsmith's interval: width shrinks with √visitors", async () => {
    const { settleText } = await import('../src/flagsmith/experiments.ts');
    // The blog's example: +14.9% lift, interval −14.1% to +44.0%, 502 visitors. Centre +14.95%, half-width 29.05%:
    // (29.05 / 14.95)² ≈ 3.8× the visitors, about 950 per version.
    assert.equal(settleText({ low: -0.141, high: 0.44 }, 502, 2), 'roughly 3.8× the visitors so far, about 950 per version, would settle a lift this size, if it holds');
    // Centred on zero: no amount of traffic is promised.
    assert.match(settleText({ low: -0.2, high: 0.2 }, 1000, 2)!, /may be no real difference: more than 20× the visitors/);
    // Clears zero: nothing to settle.
    assert.equal(settleText({ low: 0.02, high: 0.3 }, 1000, 2), null);
  });

  test('recommend carries it on a crossing interval only', () => {
    const s = initialState(); // v2: interval −2% to +62%, crossing zero
    const crossing = recommend(s.experiment, s.results);
    assert.equal(crossing.call, 'keep-running');
    assert.match(crossing.settle ?? '', /^roughly 1\.\d× the visitors so far, about [\d,]+ per version/);
    s.results!.payload!.metrics[0]!.inference.v2!.ci_low = 0.02; // now it clears zero
    assert.equal(recommend(s.experiment, s.results).settle, undefined);
  });
});
