import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { preview, PREVIEW_SEGMENT } from '../src/commands/preview.ts';
import { AA_HYPOTHESIS, currentRelease, launchEstimate, release, visitorsPerArm } from '../src/commands/release.ts';
import type { FlagState } from '../src/flagsmith/experiments.ts';
import { calls, flagKey, SEED, seededState, shipV2, startFakeAdmin, writes, type FakeAdminState } from './fake-admin.ts';

const options = [{ id: 11, key: 'v2', string_value: 'shop:1.5', default_percentage_allocation: 0 }];
const flag = (weight: number): FlagState => ({
  environment_default: { enabled: true, value: { type: 'string', value: 'shop:1.4' }, variants: [{ id: 11, weight }] },
  segment_overrides: [],
});

test('after shipping v2, the live release is v2’s value', () => {
  assert.equal(currentRelease(flag(100), options), 'shop:1.5');
});

test('otherwise the live release is the flag’s own value', () => {
  assert.equal(currentRelease(flag(0), options), 'shop:1.4');
  assert.equal(currentRelease(flag(50), options), 'shop:1.4');
});

test('a variant at 100% whose option has no value falls back to the flag’s own value', () => {
  assert.equal(currentRelease(flag(100), [{ ...options[0]!, string_value: null }]), 'shop:1.4');
  assert.equal(currentRelease(flag(100), []), 'shop:1.4');
});

// release() against the fake Admin API.

const RELEASES = new Set(['shop:1.4', 'shop:1.5', 'shop:1.6']);
let fake: { apiUrl: string; close: () => Promise<void> } | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function run(state: FakeAdminState, newRelease: string, extra: { split?: number; releases?: ReadonlySet<string> } = {}) {
  fake ??= await startFakeAdmin(state);
  const lines: string[] = [];
  const result = await release({
    apiUrl: fake.apiUrl,
    adminKey: SEED.adminKey,
    envKey: SEED.envKey,
    flag: 'shop_release',
    releases: extra.releases ?? RELEASES,
    newRelease,
    hypothesis: `${newRelease} raises order_placed`,
    ...(extra.split === undefined ? {} : { split: extra.split }),
    log: (l) => lines.push(l),
  });
  return { ...result, lines };
}
const flagOf = (state: FakeAdminState) => state.flags.get(flagKey(SEED.envKey, SEED.featureId))!;
const newest = (state: FakeAdminState) => state.experiments.at(-1)!;

test('release refuses while the previous experiment is unfinished, and changes nothing', async () => {
  for (const status of ['running', 'paused'] as const) {
    const state = seededState({ experimentStatus: status });
    await assert.rejects(run(state, 'shop:1.6'), new RegExp(`Experiment ${SEED.experimentId} \\("shop_release: shop:1\\.5 vs shop:1\\.4"\\) is ${status}\\. Ship or revert it and complete it first\\.`));
    assert.deepEqual(writes(state), []);
    await fake!.close();
    fake = undefined;
  }
});

test('release starts the next experiment: live release as control, the new one as v2, same metrics', async () => {
  const state = seededState();
  shipV2(state); // shop:1.5 won and was shipped in place: everyone gets it through v2 at 100%
  const { experimentId, lines } = await run(state, 'shop:1.6');

  // Control is the live release (the flag's own value); v2 is at 0% outside the experiment.
  const flag = flagOf(state);
  assert.equal(flag.environment_default.value.value, 'shop:1.5');
  assert.deepEqual(flag.environment_default.variants, [{ id: SEED.v2Id, weight: 0 }]);

  // v2 serves the new release, through a full PUT.
  assert.equal(state.features[0]!.multivariate_options[0]!.string_value, 'shop:1.6');
  assert.equal(calls(state, 'PATCH', /mv-options/).length, 0);
  assert.deepEqual(calls(state, 'PUT', /mv-options/)[0]!.body, {
    feature: SEED.featureId,
    type: 'unicode',
    string_value: 'shop:1.6',
    default_percentage_allocation: 0,
    key: 'v2',
  });

  // The new experiment reuses the previous one's metrics and is running.
  const experiment = newest(state);
  assert.equal(experiment.id, experimentId);
  assert.notEqual(experimentId, SEED.experimentId);
  assert.equal(experiment.status, 'running');
  assert.equal(experiment.name, 'shop_release: shop:1.6 vs shop:1.5');
  assert.equal(experiment.hypothesis, 'shop:1.6 raises order_placed');
  assert.deepEqual(
    experiment.metrics.map((m) => [m.metric, m.expected_direction]),
    state.experiments[0]!.metrics.map((m) => [m.metric, m.expected_direction]),
  );
  assert.equal(experiment.experiment_rollout!.feature_state_value.value, 'shop:1.5');
  assert.deepEqual(experiment.experiment_rollout!.multivariate_feature_state_values, [{ multivariate_feature_option: SEED.v2Id, percentage_allocation: 50 }]);
  assert.equal(calls(state, 'POST', new RegExp(`/experiments/${experimentId}/start/$`)).length, 1);

  // The order matters: v2 is only re-pointed once everyone is on control.
  const order = state.requests.filter((r) => r.method !== 'GET').map((r) => r.method);
  assert.deepEqual(order, ['PATCH', 'PUT', 'POST', 'POST']);
  assert.ok(lines.some((l) => l.includes('50% of visitors get shop:1.6, the rest shop:1.5')));
});

test('release without a shipped v2 keeps the flag’s value as control and honours --split', async () => {
  const state = seededState();
  await run(state, 'shop:1.6', { split: 20 });
  assert.equal(flagOf(state).environment_default.value.value, 'shop:1.4');
  const experiment = newest(state);
  assert.equal(experiment.name, 'shop_release: shop:1.6 vs shop:1.4');
  assert.deepEqual(experiment.experiment_rollout!.multivariate_feature_state_values, [{ multivariate_feature_option: SEED.v2Id, percentage_allocation: 20 }]);
});

test('release takes metrics from the most recent finished experiment', async () => {
  const state = seededState();
  const older = structuredClone(state.experiments[0]!);
  older.id = 1;
  older.metrics = [{ metric: 6, metric_name: 'order_placed', aggregation: 'occurrence', direction: 'up', expected_direction: 'decrease' }];
  state.experiments.unshift(older);
  await run(state, 'shop:1.6');
  assert.deepEqual(
    newest(state).metrics.map((m) => m.metric),
    [6, 7, 8],
  );
});

test('release refuses labels outside the allowlist, the live release itself, and a flag without history', async () => {
  let state = seededState();
  await assert.rejects(run(state, 'shop:9.9'), /"shop:9\.9" isn't in turnout\.config\.yml's releases/);
  await assert.rejects(run(state, 'shop:1.4'), /shop:1\.4 is already what everyone gets/);
  // The live release must be routable too.
  await assert.rejects(run(state, 'shop:1.6', { releases: new Set(['shop:1.6']) }), /"shop:1\.4" isn't in turnout\.config\.yml's releases/);
  assert.deepEqual(writes(state), []);
  await fake!.close();
  fake = undefined;

  state = seededState();
  state.experiments = [];
  await assert.rejects(run(state, 'shop:1.6'), /No previous experiment on this flag/);
  assert.deepEqual(writes(state), []);
});

test('preview, then release: the team keeps the new release and the experiment rollout is added below it', async () => {
  const state = seededState();
  fake = await startFakeAdmin(state);
  await preview({ apiUrl: fake.apiUrl, adminKey: SEED.adminKey, envKey: SEED.envKey, flag: 'shop_release', releases: RELEASES, newRelease: 'shop:1.6', log: () => {} });
  const { experimentId } = await run(state, 'shop:1.6');

  const segment = state.segments.find((s) => s.name === PREVIEW_SEGMENT)!;
  const rollout = state.segments.find((s) => s.name === `experiment-${experimentId}-rollout`)!;
  const overrides = flagOf(state).segment_overrides;
  const previewOverride = overrides.find((o) => o.segment.id === segment.id)!;
  const rolloutOverride = overrides.find((o) => o.segment.id === rollout.id)!;
  assert.deepEqual(previewOverride.variants, [{ id: SEED.v2Id, weight: 100 }]);
  assert.ok(previewOverride.priority < rolloutOverride.priority, 'the preview outranks the experiment');
  assert.equal(state.features[0]!.multivariate_options[0]!.string_value, 'shop:1.6');
  assert.equal(newest(state).status, 'running');
});

test('release --aa: v2 serves the live release too, with the A/A hypothesis', async () => {
  const state = seededState();
  fake = await startFakeAdmin(state);
  const lines: string[] = [];
  const base = { apiUrl: fake.apiUrl, adminKey: SEED.adminKey, envKey: SEED.envKey, flag: 'shop_release', releases: RELEASES, hypothesis: 'ignored', log: (l: string) => lines.push(l) };
  await assert.rejects(release({ ...base, newRelease: 'shop:1.6', aa: true }), /A\/A run serves the live release on both arms; shop:1\.4 is live, not shop:1\.6/);
  assert.deepEqual(writes(state), []);
  await release({ ...base, newRelease: '', aa: true });
  const experiment = newest(state);
  assert.equal(experiment.name, 'shop_release: A/A shop:1.4');
  assert.equal(experiment.hypothesis, AA_HYPOTHESIS);
  assert.equal(experiment.status, 'running');
  assert.equal(experiment.experiment_rollout!.feature_state_value.value, 'shop:1.4');
  assert.equal(state.features[0]!.multivariate_options[0]!.string_value, 'shop:1.4'); // both arms, same release
  assert.ok(lines.includes('Live today: shop:1.4. A/A run: shop:1.4 on both arms.'));
});

test('release prints a rough launch estimate from the previous experiment’s control rate', async () => {
  const state = seededState();
  state.results = new Map([[SEED.experimentId, { as_of: null, last_error_at: null, refresh_requested_at: null, is_final: true, payload: { srm_p_value: null, metrics: [{ metric_id: 6, variants: { control: { n: 1000, sum: 100, sum_squares: 100 } }, inference: {} }] } }]]);
  fake = await startFakeAdmin(state);
  const lines: string[] = [];
  await release({ apiUrl: fake.apiUrl, adminKey: SEED.adminKey, envKey: SEED.envKey, flag: 'shop_release', releases: RELEASES, newRelease: 'shop:1.6', hypothesis: 'h', dailyVisitors: 1000, log: (l) => lines.push(l) });
  // 16·0.1·0.9/(0.1·0.1)² = 14,400 per arm; the 50% arm gets 500 a day.
  assert.equal(lines.at(-1), "Launch estimate: ~14,400 visitors per arm to detect a 10% relative lift on a 10.0% baseline, about 29 days at 1000 visitors a day (rough estimate; Flagsmith does the real statistics; don't ship on an early reading).");
});

test('the launch estimate says unknown without a baseline', async () => {
  assert.equal(visitorsPerArm(0.1, 0.1), 14400);
  assert.match(launchEstimate(null), /visitors needed per arm for a 10% lift: unknown/);
  assert.match(launchEstimate(0.05, { mde: 20 }), /~7,600 visitors per arm to detect a 20% relative lift on a 5\.0% baseline \(/);
  const state = seededState(); // no results for the previous experiment
  fake = await startFakeAdmin(state);
  const { lines } = await run(state, 'shop:1.6');
  assert.match(lines.at(-1)!, /unknown \(no baseline goal rate from a previous experiment\)/);
});

test('release with also: an A/B/C test, every new release on its own variation (v3 created once), split evenly', async () => {
  const state = seededState();
  fake ??= await startFakeAdmin(state);
  const lines: string[] = [];
  const { experimentId } = await release({
    apiUrl: fake.apiUrl,
    adminKey: SEED.adminKey,
    envKey: SEED.envKey,
    flag: 'shop_release',
    releases: RELEASES,
    newRelease: 'shop:1.5',
    also: ['shop:1.6'],
    hypothesis: 'shop:1.5 or shop:1.6 raises order_placed',
    log: (l) => lines.push(l),
  });
  const options = state.features[0]!.multivariate_options;
  assert.deepEqual(options.map((o) => [o.key, o.string_value]), [['v2', 'shop:1.5'], ['v3', 'shop:1.6']]);
  assert.equal(calls(state, 'POST', /mv-options\/$/).length, 1, 'v3 is created on the flag');
  // Nobody outside the experiment gets a new release: every variation at 0% on the environment default.
  assert.ok(flagOf(state).environment_default.variants.every((v) => v.weight === 0));
  const e = newest(state);
  assert.equal(e.id, experimentId);
  assert.equal(e.name, 'shop_release: shop:1.5 vs shop:1.6 vs shop:1.4');
  assert.deepEqual(
    e.experiment_rollout!.multivariate_feature_state_values.map((v) => v.percentage_allocation),
    [33, 33],
    'control keeps the remaining 34%',
  );
  assert.match(lines.join('\n'), /33% of visitors each get shop:1\.5 and shop:1\.6, the rest shop:1\.4 \(control\)/);
});

test('release with also refuses a split, and a release that repeats', async () => {
  const state = seededState();
  fake ??= await startFakeAdmin(state);
  const base = { apiUrl: fake.apiUrl, adminKey: SEED.adminKey, envKey: SEED.envKey, flag: 'shop_release', releases: RELEASES, newRelease: 'shop:1.5', hypothesis: 'h' };
  await assert.rejects(release({ ...base, also: ['shop:1.6'], split: 20, log: () => {} }), /splits visitors evenly/);
  await assert.rejects(release({ ...base, also: ['shop:1.5'], log: () => {} }), /must be different/);
  assert.deepEqual(writes(state), []);
});
