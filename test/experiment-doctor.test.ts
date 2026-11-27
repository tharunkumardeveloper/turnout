// The Experiment Doctor (turnout check with an Organisation API key): exposures, tracking, sample ratio.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check } from '../src/commands/check.ts';
import { chiSquareP, configuredShares, diagnose, formatDiagnoses } from '../src/commands/experiment-doctor.ts';
import type { ExperimentDetail, Results } from '../src/flagsmith/experiments.ts';
import { SEED, seededState, startFakeAdmin } from './fake-admin.ts';

const experiment = (split = 50): ExperimentDetail => ({
  id: 9,
  name: 'shop_release: shop:1.6 vs shop:1.5',
  hypothesis: 'h',
  status: 'running',
  feature: { id: 1, name: 'shop_release', initial_value: 'shop:1.5', multivariate_options: [{ id: 11, key: 'v2', string_value: 'shop:1.6' }] },
  metrics: [
    { metric: 6, metric_name: 'order_placed', aggregation: 'occurrence', direction: 'up', expected_direction: 'increase' },
    { metric: 8, metric_name: 'server_error', aggregation: 'mean', direction: 'down', expected_direction: 'not_increase' },
  ],
  experiment_rollout: {
    enabled: true,
    rollout_percentage: 100,
    feature_state_value: { type: 'string', value: 'shop:1.5' },
    multivariate_feature_state_values: [{ multivariate_feature_option: 11, percentage_allocation: split }],
  },
  started_at: '2026-11-20T00:00:00Z',
  ended_at: null,
});

type Arm = { n: number; orders: number; errors?: number };
const results = (control: Arm, v2: Arm, srm: number | null = null): Results => ({
  as_of: null,
  last_error_at: null,
  refresh_requested_at: null,
  is_final: false,
  payload: {
    srm_p_value: srm,
    metrics: [
      { metric_id: 6, variants: { control: { n: control.n, sum: control.orders, sum_squares: control.orders }, v2: { n: v2.n, sum: v2.orders, sum_squares: v2.orders } }, inference: {} },
      { metric_id: 8, variants: { control: { n: control.n, sum: control.errors ?? 0, sum_squares: 0 }, v2: { n: v2.n, sum: v2.errors ?? 0, sum_squares: 0 } }, inference: {} },
    ],
  },
});
const verdicts = (d: ReturnType<typeof diagnose>) => d.map((x) => `${x.check}:${x.verdict}`);

test('chi-square matches the known values', () => {
  assert.equal(chiSquareP([500, 500], [0.5, 0.5]), 1);
  const p = chiSquareP([600, 400], [0.5, 0.5])!; // statistic 40, 1 df
  assert.ok(p > 1e-10 && p < 1e-9, String(p));
  assert.ok(Math.abs(chiSquareP([520, 480], [0.5, 0.5])! - 0.2059) < 0.001); // statistic 1.6
  assert.ok(Math.abs(chiSquareP([340, 330, 330], [1 / 3, 1 / 3, 1 / 3])! - 0.9048) < 0.001); // 2 df: e^-0.1
  assert.equal(chiSquareP([10, 0], [1, 0]), null);
});

test('the configured split: options by key, control the remainder', () => {
  assert.deepEqual(configuredShares(experiment(20)), { v2: 0.2, control: 0.8 });
});

test('a healthy experiment passes, and the late multivariate check is skipped honestly', () => {
  const d = diagnose(experiment(), results({ n: 510, orders: 50 }, { n: 490, orders: 60 }));
  assert.deepEqual(verdicts(d), ['exposures:pass', 'tracking:pass', 'sample ratio:pass', 'late multivariate:skip']);
  assert.match(d[2]!.summary, /chi-square vs the rollout split; a sanity check, not a result/);
  assert.match(d[3]!.summary, /doesn't record when a flag's variants were added/);
});

test('an arm with visitors but no goal events fails; a guardrail at zero only warns', () => {
  const d = diagnose(experiment(), results({ n: 500, orders: 50, errors: 0 }, { n: 500, orders: 0, errors: 20 }));
  const tracking = d.filter((x) => x.check === 'tracking');
  assert.deepEqual(tracking.map((x) => x.verdict), ['fail', 'warn']);
  assert.match(tracking[0]!.summary, /^v2 has 500 visitors but no order_placed events, while control has 50/);
  assert.ok(tracking[0]!.meaning && tracking[0]!.fix);
});

test('too few visitors to expect an event is not a tracking problem', () => {
  const d = diagnose(experiment(), results({ n: 20, orders: 1 }, { n: 20, orders: 0 }));
  assert.equal(d.find((x) => x.check === 'tracking')!.verdict, 'pass');
  assert.equal(d.find((x) => x.check === 'sample ratio')!.verdict, 'skip'); // under 100 visitors
});

test('exposures on one side only fail', () => {
  const d = diagnose(experiment(), results({ n: 800, orders: 80 }, { n: 0, orders: 0 }));
  const exposures = d.find((x) => x.check === 'exposures')!;
  assert.equal(exposures.verdict, 'fail');
  assert.match(exposures.summary, /control 800, v2 0/);
});

test('sample ratio mismatch fails at p < 0.001, and Flagsmith’s own p-value wins when present', () => {
  let d = diagnose(experiment(), results({ n: 600, orders: 60 }, { n: 400, orders: 40 }));
  assert.equal(d.find((x) => x.check === 'sample ratio')!.verdict, 'fail');
  // 600/400 is right for a 40% split.
  d = diagnose(experiment(40), results({ n: 600, orders: 60 }, { n: 400, orders: 40 }));
  assert.equal(d.find((x) => x.check === 'sample ratio')!.verdict, 'pass');
  d = diagnose(experiment(), results({ n: 500, orders: 50 }, { n: 500, orders: 50 }, 0.0002));
  const srm = d.find((x) => x.check === 'sample ratio')!;
  assert.equal(srm.verdict, 'fail');
  assert.match(srm.summary, /\(Flagsmith; a sanity check, not a result\)/);
});

test('no results yet: skipped, with what to do', () => {
  const d = diagnose(experiment(), null);
  assert.deepEqual(verdicts(d), ['exposures:skip', 'late multivariate:skip']);
  const lines = formatDiagnoses(experiment(), diagnose(experiment(), results({ n: 800, orders: 80 }, { n: 0, orders: 0 })));
  assert.equal(lines[0], 'Experiment 9 "shop_release: shop:1.6 vs shop:1.5" (running):');
  assert.ok(lines.some((l) => l.startsWith('  ✗ fail  exposures:')));
  assert.ok(lines.some((l) => l.includes('What it means:')) && lines.some((l) => l.includes('How to fix:')));
});

test('check with an admin key runs the doctor on running experiments and counts its failures', async () => {
  const state = seededState({ experimentStatus: 'running' });
  state.serverKeys.push({ envKey: SEED.envKey, key: 'ser.k', name: 'ci' });
  state.results = new Map([[SEED.experimentId, results({ n: 500, orders: 50 }, { n: 500, orders: 0 })]]);
  const fake = await startFakeAdmin(state);
  try {
    const lines: string[] = [];
    const fails = await check({ apiUrl: fake.apiUrl, serverKey: 'ser.k', adminKey: SEED.adminKey, log: (l) => lines.push(l) });
    assert.equal(fails, 1, lines.join('\n'));
    assert.ok(lines.some((l) => l.startsWith('Experiment doctor:')));
    assert.ok(lines.some((l) => l.includes('✗ fail  tracking: v2 has 500 visitors but no order_placed events')), lines.join('\n'));
    assert.ok(!state.requests.some((r) => r.method !== 'GET'), 'read-only');

    // Server key only: today's checks, no doctor.
    const plain: string[] = [];
    await check({ apiUrl: fake.apiUrl, serverKey: 'ser.k', log: (l) => plain.push(l) });
    assert.ok(!plain.some((l) => l.startsWith('Experiment doctor')));
  } finally {
    await fake.close();
  }
});

test('completed experiments older than two weeks are left out', async () => {
  const state = seededState({ experimentStatus: 'completed' }); // ended 2026-11-17
  state.serverKeys.push({ envKey: SEED.envKey, key: 'ser.k', name: 'ci' });
  const fake = await startFakeAdmin(state);
  try {
    const { experimentDoctor } = await import('../src/commands/experiment-doctor.ts');
    const { AdminClient } = await import('../src/flagsmith/admin.ts');
    const api = new AdminClient(fake.apiUrl, { apiKey: SEED.adminKey });
    const recent: string[] = [];
    await experimentDoctor(api, SEED.envKey, (l) => recent.push(l), Date.parse('2026-11-20T00:00:00Z'));
    assert.ok(recent.some((l) => l.startsWith(`Experiment ${SEED.experimentId} `)));
    const old: string[] = [];
    await experimentDoctor(api, SEED.envKey, (l) => old.push(l), Date.parse('2027-01-20T00:00:00Z'));
    assert.ok(old.some((l) => l.startsWith('No running, paused or recently completed')));
  } finally {
    await fake.close();
  }
});

test('a drained or removed rollout split skips the sample ratio check, and every arm in the results is listed', () => {
  const drained = experiment(0);
  const d = diagnose(drained, results({ n: 500, orders: 50 }, { n: 500, orders: 60 }));
  assert.equal(d[0]!.summary, 'every arm has visitors (control 500, v2 500).');
  assert.match(d.find((x) => x.check === 'sample ratio')!.summary, /no longer has the split visitors were assigned with \(now v2 0%, control 100%; drained or shipped\?\)/);
  const removed = { ...experiment(), status: 'completed' as const, experiment_rollout: null };
  assert.match(diagnose(removed, results({ n: 500, orders: 50 }, { n: 500, orders: 60 })).find((x) => x.check === 'sample ratio')!.summary, /no longer reports a rollout split/);
});
