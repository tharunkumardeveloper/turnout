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
  planRevert,
  planShip,
  releaseOf,
  runSteps,
  snapshotFileOf,
  variantKey,
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

  test('ignores the primary metric and missing results', () => {
    const s = initialState();
    s.results!.payload!.metrics[0]!.inference.v2!.chance_to_win = 0.01;
    assert.deepEqual(losingGuardrails(s.experiment, s.results, 'v2'), []);
    assert.deepEqual(losingGuardrails(s.experiment, null, 'v2'), []);
  });
});
