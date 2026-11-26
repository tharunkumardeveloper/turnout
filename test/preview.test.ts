import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { preview, PREVIEW_SEGMENT, PREVIEW_TRAIT } from '../src/commands/preview.ts';
import { calls, flagKey, SEED, seededState, shipV2, startFakeAdmin, writes, type FakeAdminState } from './fake-admin.ts';

const RELEASES = new Set(['shop:1.4', 'shop:1.5', 'shop:1.6']);
let fake: { apiUrl: string; close: () => Promise<void> } | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function run(state: FakeAdminState, newRelease: string, releases: ReadonlySet<string> = RELEASES): Promise<string[]> {
  fake ??= await startFakeAdmin(state);
  const lines: string[] = [];
  await preview({ apiUrl: fake.apiUrl, adminKey: SEED.adminKey, envKey: SEED.envKey, flag: 'shop_release', releases, newRelease, log: (l) => lines.push(l) });
  return lines;
}
const flagOf = (state: FakeAdminState) => state.flags.get(flagKey(SEED.envKey, SEED.featureId))!;
const previewSegments = (state: FakeAdminState) => state.segments.filter((s) => s.name === PREVIEW_SEGMENT);

test('refuses while the flag has an unfinished experiment, and changes nothing', async () => {
  for (const status of ['running', 'paused', 'created'] as const) {
    const state = seededState({ experimentStatus: status });
    await assert.rejects(run(state, 'shop:1.6'), new RegExp(`Experiment ${SEED.experimentId} is ${status}\\. A preview must start before the experiment`));
    assert.deepEqual(writes(state), []);
    await fake!.close();
    fake = undefined;
  }
});

test('refuses a label that is not in the config allowlist, and changes nothing', async () => {
  const state = seededState();
  await assert.rejects(run(state, 'shop:9.9'), /"shop:9\.9" isn't in switchyard\.config\.yml's releases/);
  assert.deepEqual(writes(state), []);
});

test('refuses to preview the release everyone already gets', async () => {
  const state = seededState();
  await assert.rejects(run(state, 'shop:1.4'), /shop:1\.4 is already what everyone gets/);
  assert.equal(calls(state, 'PUT', /mv-options/).length, 0);
  assert.equal(calls(state, 'PATCH', /__future__/).length, 0);
});

test('serves the new release to the preview segment only, rotating v2 with a full PUT', async () => {
  const state = seededState();
  const lines = await run(state, 'shop:1.6');

  // The segment: trait preview = "true".
  const [segment] = previewSegments(state);
  assert.ok(segment);
  assert.equal(previewSegments(state).length, 1);
  assert.deepEqual(JSON.stringify(segment.rules).match(/"operator":"EQUAL","property":"([^"]+)","value":"([^"]+)"/)?.slice(1), [PREVIEW_TRAIT, 'true']);

  // Everyone else keeps the live release as control, v2 at 0%.
  const flag = flagOf(state);
  assert.equal(flag.environment_default.value.value, 'shop:1.4');
  assert.deepEqual(flag.environment_default.variants, [{ id: SEED.v2Id, weight: 0 }]);

  // v2 now serves the new release, via PUT (a partial PATCH answers 500 on Flagsmith 2.291.0).
  assert.equal(state.features[0]!.multivariate_options[0]!.string_value, 'shop:1.6');
  assert.equal(calls(state, 'PATCH', /mv-options/).length, 0);
  const put = calls(state, 'PUT', /mv-options/);
  assert.equal(put.length, 1);
  assert.deepEqual(put[0]!.body, { feature: SEED.featureId, type: 'unicode', string_value: 'shop:1.6', default_percentage_allocation: 0, key: 'v2' });

  // The preview override: v2 at 100%, after the drained experiment override (priority 0).
  const override = flag.segment_overrides.find((o) => o.segment.id === segment.id)!;
  assert.equal(override.priority, 1);
  assert.equal(override.enabled, true);
  assert.deepEqual(override.variants, [{ id: SEED.v2Id, weight: 100 }]);
  assert.ok(lines.some((l) => l.includes('your team gets shop:1.6; everyone else still gets shop:1.4')));
});

test('takes the next free priority: max existing + 1', async () => {
  const state = seededState();
  flagOf(state).segment_overrides.push(
    { segment: { id: 50 }, priority: 4, enabled: true, variants: [] },
    { segment: { id: 51 }, priority: 2, enabled: true, variants: [] },
  );
  await run(state, 'shop:1.6');
  const segment = previewSegments(state)[0]!;
  assert.equal(flagOf(state).segment_overrides.find((o) => o.segment.id === segment.id)!.priority, 5);
});

test('running it again reuses the segment and its override priority', async () => {
  const state = seededState();
  await run(state, 'shop:1.6');
  const segment = previewSegments(state)[0]!;
  const priority = flagOf(state).segment_overrides.find((o) => o.segment.id === segment.id)!.priority;

  await run(state, 'shop:1.5');
  assert.equal(previewSegments(state).length, 1);
  assert.equal(calls(state, 'POST', /\/segments\/$/).length, 1);
  const overrides = flagOf(state).segment_overrides.filter((o) => o.segment.id === segment.id);
  assert.equal(overrides.length, 1);
  assert.equal(overrides[0]!.priority, priority);
  assert.equal(state.features[0]!.multivariate_options[0]!.string_value, 'shop:1.5');
  assert.equal(calls(state, 'PATCH', /mv-options/).length, 0);
});

test('after v2 was shipped, the shipped release becomes control for everyone else', async () => {
  const state = seededState();
  shipV2(state); // everyone gets shop:1.5 through v2 at 100%
  await run(state, 'shop:1.6');
  const flag = flagOf(state);
  assert.equal(flag.environment_default.value.value, 'shop:1.5');
  assert.deepEqual(flag.environment_default.variants, [{ id: SEED.v2Id, weight: 0 }]);
  assert.equal(state.features[0]!.multivariate_options[0]!.string_value, 'shop:1.6');
});

test('a missing flag or missing v2 option is explained', async () => {
  const state = seededState();
  state.features[0]!.multivariate_options[0]!.key = 'other';
  await assert.rejects(run(state, 'shop:1.6'), /has no variant with key v2/);
  state.features[0]!.name = 'renamed';
  await assert.rejects(run(state, 'shop:1.6'), /Flag "shop_release" not found\. Run switchyard init first\./);
  assert.deepEqual(writes(state), []);
});
