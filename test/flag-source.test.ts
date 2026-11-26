// createFlagSource against the real @flagsmith/nodejs SDK with local evaluation, fed by a fetch stub that serves an
// environment document (shaped like Flagsmith 2.291.0's, trimmed to what the engine reads) and accepts events.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createFlagSource, eventsApiUrlFor } from '../src/flagsmith/flag-source.ts';

const API = 'http://flagsmith.test/api/v1/';

type FlagShape = { enabled: boolean; value: string | null; v2: { value: string; weight: number } | null; rollout?: { weight: number; inExperiment: boolean } };

// shop_release with control = value, an optional v2 option, and optionally an experiment's rollout segment
// (100% of identities, the way Flagsmith writes experiment-<id>-rollout).
function environmentDocument(flag: FlagShape, name = 'shop_release') {
  const feature = { id: 4, name, type: flag.v2 ? 'MULTIVARIATE' : 'STANDARD' };
  const mv = (weight: number) =>
    flag.v2 ? [{ id: 1, multivariate_feature_option: { id: 5, key: 'v2', value: flag.v2.value }, percentage_allocation: weight, mv_fs_value_uuid: '6d5f1a8e-8f6c-4e8a-9a51-0b0c3f6d1a01' }] : [];
  const experiment = { id: 9, name: 'shop_release: shop:1.5 vs shop:1.4' };
  return {
    api_key: 'envKey',
    name: 'Production',
    id: 1,
    project: {
      id: 2,
      name: 'Switchyard demo',
      hide_disabled_flags: false,
      organisation: { id: 1, name: 'Switchyard', feature_analytics: false, persist_trait_data: true, stop_serving_flags: false },
      segments: flag.rollout
        ? [
            {
              id: 10,
              name: 'experiment-9-rollout',
              rules: [{ type: 'ALL', rules: [], conditions: [{ operator: 'PERCENTAGE_SPLIT', property_: '$.identity.key', value: '100.0' }] }],
              feature_states: [
                {
                  django_id: 2,
                  featurestate_uuid: 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2',
                  feature,
                  feature_segment: { priority: 0 },
                  enabled: flag.enabled,
                  feature_state_value: flag.value,
                  multivariate_feature_state_values: mv(flag.rollout.weight),
                  metadata: { experiment: { ...experiment, in_experiment: flag.rollout.inExperiment } },
                },
              ],
            },
          ]
        : [],
    },
    segment_overrides: [],
    feature_states: [
      {
        django_id: 1,
        featurestate_uuid: 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1',
        feature,
        feature_segment: null,
        enabled: flag.enabled,
        feature_state_value: flag.value,
        multivariate_feature_state_values: mv(flag.v2?.weight ?? 0),
        ...(flag.rollout ? { metadata: { experiment: { ...experiment, in_experiment: false } } } : {}),
      },
    ],
    identity_overrides: [],
  };
}

type Sent = { url: string; method: string; headers: Record<string, string>; body: unknown };

function stubFetch(serve: () => { status: number; body: unknown }) {
  const sent: Sent[] = [];
  const fetchStub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    sent.push({ url, method: init?.method ?? 'GET', headers, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    if (url === `${API}environment-document/`) {
      const { status, body } = serve();
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/v1/events')) {
      const events = (sent.at(-1)!.body as { events: unknown[] }).events;
      return new Response(JSON.stringify({ accepted: events.length, rejected: [] }), { status: 202, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch: fetchStub as typeof fetch, sent };
}

const sources: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(sources.splice(0).map((s) => s.close()));
});

function source(serve: () => { status: number; body: unknown }, flag = 'shop_release') {
  const stub = stubFetch(serve);
  const flags = createFlagSource({ apiUrl: API, serverKey: 'ser.test', flag, refreshSeconds: 0.02, fetch: stub.fetch });
  sources.push(flags);
  return { flags, sent: stub.sent };
}

async function until(condition: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('eventsApiUrlFor drops the trailing v1/ because the SDK appends v1/events itself', () => {
  assert.equal(eventsApiUrlFor('http://flagsmith:8000/api/v1/'), 'http://flagsmith:8000/api/');
  assert.equal(eventsApiUrlFor('http://flagsmith:8000/api/v1'), 'http://flagsmith:8000/api/');
  assert.equal(eventsApiUrlFor('https://edge.example.com/api/'), 'https://edge.example.com/api/');
});

test('not ready until the first environment document arrives, then ready with its age', async () => {
  const doc = environmentDocument({ enabled: true, value: 'shop:1.4', v2: { value: 'shop:1.5', weight: 0 } });
  const { flags, sent } = source(() => ({ status: 200, body: doc }));
  assert.equal(flags.ready!(), false);
  assert.deepEqual(flags.status!(), { ready: false, environmentAgeSeconds: null, lastError: null });

  await until(() => flags.ready!());
  assert.deepEqual(flags.status!(), { ready: true, environmentAgeSeconds: 0, lastError: null });
  const docRequest = sent.find((s) => s.url.endsWith('environment-document/'))!;
  assert.equal(docRequest.headers['x-environment-key'], 'ser.test');
});

test('a failing environment document is reported in status() and the source stays not ready', async () => {
  const { flags } = source(() => ({ status: 503, body: { detail: 'down' } }));
  await until(() => flags.status!().lastError !== null);
  const status = flags.status!();
  assert.equal(status.ready, false);
  assert.equal(status.environmentAgeSeconds, null);
  assert.match(status.lastError!, /503/);
});

test('a recovered environment document clears the last error', async () => {
  let failing = true;
  const doc = environmentDocument({ enabled: true, value: 'shop:1.4', v2: null });
  const { flags } = source(() => (failing ? { status: 500, body: {} } : { status: 200, body: doc }));
  await until(() => flags.status!().lastError !== null);
  failing = false;
  await until(() => flags.ready!());
  assert.equal(flags.status!().lastError, null);
});

test('an identity enrolled in the experiment gets the variant, its release and enrolled = true, and an exposure is sent', async () => {
  const doc = environmentDocument({ enabled: true, value: 'shop:1.4', v2: { value: 'shop:1.5', weight: 0 }, rollout: { weight: 100, inExperiment: true } });
  const { flags, sent } = source(() => ({ status: 200, body: doc }));
  await until(() => flags.ready!());

  assert.deepEqual(await flags.assign('visitor-1', { recordExposure: true }), { variant: 'v2', release: 'shop:1.5', enrolled: true });
  flags.track('order_placed', 'visitor-1');
  flags.track('doc_latency_ms', 'visitor-1', 42);
  await flags.close();

  // Events go to <api>/v1/events, i.e. eventsApiUrlFor(apiUrl) + "v1/events".
  const batches = sent.filter((s) => s.url === 'http://flagsmith.test/api/v1/events');
  const events = batches.flatMap((b) => (b.body as { events: { event: string; identifier: string; value?: unknown; metadata?: unknown }[] }).events);
  assert.ok(events.length >= 3, `expected an exposure and two conversions, got ${JSON.stringify(events)}`);
  assert.ok(events.every((e) => e.identifier === 'visitor-1'));
  assert.ok(events.some((e) => e.event === 'order_placed'));
  assert.ok(events.some((e) => e.event === 'doc_latency_ms' && e.value === '42'), 'the SDK stringifies values');
  assert.ok(events.some((e) => (e.metadata as { experiment_id?: number } | undefined)?.experiment_id === 9), 'the exposure names the experiment');
  assert.equal(flags.receipts.get('visitor-1')?.status, 'accepted');
});

test('without recording an exposure, the same identity is evaluated but no exposure is sent', async () => {
  const doc = environmentDocument({ enabled: true, value: 'shop:1.4', v2: { value: 'shop:1.5', weight: 0 }, rollout: { weight: 100, inExperiment: true } });
  const { flags, sent } = source(() => ({ status: 200, body: doc }));
  await until(() => flags.ready!());
  assert.deepEqual(await flags.assign('visitor-2', { recordExposure: false }), { variant: 'v2', release: 'shop:1.5', enrolled: true });
  await flags.close();
  assert.equal(sent.filter((s) => s.url.endsWith('/v1/events')).length, 0);
});

test('outside any experiment, the flag’s value is the release and the identity is not enrolled', async () => {
  const doc = environmentDocument({ enabled: true, value: 'shop:1.4', v2: null });
  const { flags } = source(() => ({ status: 200, body: doc }));
  await until(() => flags.ready!());
  const a = await flags.assign('visitor-3', { recordExposure: true });
  assert.equal(a.release, 'shop:1.4');
  assert.equal(a.enrolled, false);
  assert.equal(a.variant, 'control');
});

test('a shipped v2 at 100% on the environment default serves v2’s release', async () => {
  const doc = environmentDocument({ enabled: true, value: 'shop:1.4', v2: { value: 'shop:1.5', weight: 100 } });
  const { flags } = source(() => ({ status: 200, body: doc }));
  await until(() => flags.ready!());
  const a = await flags.assign('visitor-4', { recordExposure: true });
  assert.equal(a.release, 'shop:1.5');
  assert.equal(a.enrolled, false);
});

test('a disabled flag maps to control with no release', async () => {
  const doc = environmentDocument({ enabled: false, value: 'shop:1.5', v2: { value: 'shop:1.6', weight: 100 } });
  const { flags } = source(() => ({ status: 200, body: doc }));
  await until(() => flags.ready!());
  assert.deepEqual(await flags.assign('visitor-5', { recordExposure: true }), { variant: 'control', release: undefined, enrolled: false });
  assert.deepEqual(await flags.assign('visitor-5', { recordExposure: false }), { variant: 'control', release: undefined, enrolled: false });
});

test('an enabled flag without a value maps to an undefined release', async () => {
  const doc = environmentDocument({ enabled: true, value: null, v2: null });
  const { flags } = source(() => ({ status: 200, body: doc }));
  await until(() => flags.ready!());
  const a = await flags.assign('visitor-6', { recordExposure: false });
  assert.equal(a.release, undefined);
  assert.equal(a.enrolled, false);
});

test('a flag missing from the environment maps to control with no release', async () => {
  const doc = environmentDocument({ enabled: true, value: 'shop:1.4', v2: null }, 'some_other_flag');
  const { flags } = source(() => ({ status: 200, body: doc }));
  await until(() => flags.ready!());
  assert.deepEqual(await flags.assign('visitor-7', { recordExposure: true }), { variant: 'control', release: undefined, enrolled: false });
});
