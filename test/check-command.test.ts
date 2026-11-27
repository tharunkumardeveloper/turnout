// check(): the environment-document fetch and its return value, and analyze()/describe() cases beyond
// test/check.test.ts.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { analyze, check, describe, type EnvironmentDocument } from '../src/commands/check.ts';

type Segment = EnvironmentDocument['project']['segments'][number];
// running: the id of the experiment Flagsmith's metadata names (the one running on the flag).
const fs = (name: string, opts: { running?: number; inExperiment?: boolean; variants?: { key?: string | null; weight: number }[] } = {}) => ({
  feature: { name },
  enabled: true,
  ...(opts.running ? { metadata: { experiment: { id: opts.running, ...(opts.inExperiment !== undefined ? { in_experiment: opts.inExperiment } : {}) } } } : {}),
  multivariate_feature_state_values: (opts.variants ?? []).map((v) => ({ multivariate_feature_option: { key: v.key }, percentage_allocation: v.weight })),
});
const seg = (id: number, rules: Segment['rules'], states: ReturnType<typeof fs>[]): Segment => ({ id, name: `experiment-${id}-rollout`, rules, feature_states: states });

test('a rollout without a percentage split covers everyone', () => {
  const [f] = analyze({ project: { segments: [seg(4, [{ conditions: [] }], [fs('a', { variants: [{ key: 'v2', weight: 50 }] })])] } });
  assert.equal(f!.coveragePercent, 100);
  assert.equal(f!.status, 'leftover');
});

test('a split on a trait other than the identity key is not the experiment’s coverage', () => {
  const rules = [{ conditions: [{ operator: 'PERCENTAGE_SPLIT', value: '0.0', property_: 'plan' }] }];
  assert.equal(analyze({ project: { segments: [seg(5, rules, [fs('a')])] } })[0]!.coveragePercent, 100);
  const unset = [{ conditions: [{ operator: 'PERCENTAGE_SPLIT', value: '0.0' }] }]; // no property_: the identity key
  assert.equal(analyze({ project: { segments: [seg(6, unset, [fs('a')])] } })[0]!.status, 'drained');
});

test('findings are sorted by experiment id; segments without overrides or rules are fine', () => {
  const doc: EnvironmentDocument = {
    project: {
      segments: [
        seg(12, undefined, [fs('b', { running: 12 })]),
        { id: 3, name: 'experiment-3-rollout' },
        seg(2, [], [fs('a', { variants: [{ key: null, weight: 30 }] })]),
        { id: 4, name: 'experiment-x-rollout', feature_states: [fs('ignored')] },
      ],
    },
  };
  const findings = analyze(doc);
  assert.deepEqual(findings.map((f) => [f.experimentId, f.flag, f.status]), [
    [2, 'a', 'leftover'],
    [12, 'b', 'running'],
  ]);
  assert.deepEqual(findings[0]!.variants, [{ key: '(unkeyed)', weight: 30 }]);
  const lines = describe(findings);
  assert.ok(lines[0]!.includes('(unkeyed) 30%'));
  assert.ok(lines.includes('· b: experiment 12 is running on 100% of identities (control only).'));
});

async function documentServer(status: number, body: unknown) {
  const seen: { path: string; key: string | undefined }[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url ?? '', key: req.headers['x-environment-key'] as string | undefined });
    const ok = req.url === '/api/v1/environment-document/';
    res.writeHead(ok ? status : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? body : { detail: 'Not found.' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('check() reads the environment document with the server key and returns the number of leftovers', async () => {
  const split = (value: string) => [{ conditions: [{ operator: 'PERCENTAGE_SPLIT', value, property_: '$.identity.key' }] }];
  const doc: EnvironmentDocument = {
    project: { segments: [seg(1, split('100.0'), [fs('a')]), seg(2, split('100.0'), [fs('b')]), seg(3, split('0.0'), [fs('c')]), seg(4, split('100'), [fs('d', { running: 4 })])] },
  };
  const server = await documentServer(200, doc);
  try {
    const lines: string[] = [];
    assert.equal(await check({ apiUrl: `${server.base}/api/v1/`, serverKey: 'ser.k', log: (l) => lines.push(l) }), 2);
    assert.deepEqual(server.seen, [{ path: '/api/v1/environment-document/', key: 'ser.k' }]);
    assert.equal(lines.filter((l) => l.startsWith('✗')).length, 2);
  } finally {
    await server.close();
  }
});

test('check() explains a refused key', async () => {
  const server = await documentServer(403, { detail: 'Invalid' });
  try {
    await assert.rejects(check({ apiUrl: `${server.base}/api/v1/`, serverKey: 'client-key', log: () => {} }), /\(403\)\. check needs a server-side key/);
  } finally {
    await server.close();
  }
});

test(
  'check() accepts an API URL without a trailing slash, like the SDK and AdminClient do',
  async () => {
    const server = await documentServer(200, { project: { segments: [] } });
    try {
      assert.equal(await check({ apiUrl: `${server.base}/api/v1`, serverKey: 'ser.k', log: () => {} }), 0);
    } finally {
      await server.close();
    }
  },
);

test('running means the metadata names this rollout’s own experiment', () => {
  const split = [{ conditions: [{ operator: 'PERCENTAGE_SPLIT', value: '100.0', property_: '$.identity.key' }] }];
  // Experiment 8 runs on the flag; Flagsmith puts its metadata on every segment override of the flag, so experiment
  // 3's old rollout carries id 8 and in_experiment false (api/experimentation/feature_state_metadata.py).
  const findings = analyze({
    project: {
      segments: [
        seg(3, split, [fs('a', { running: 8, inExperiment: false })]),
        seg(8, split, [fs('a', { running: 8, inExperiment: true })]),
        seg(9, split, [fs('b', { running: 9, inExperiment: false })]),
      ],
    },
  });
  assert.deepEqual(findings.map((f) => [f.experimentId, f.status]), [
    [3, 'leftover'],
    [8, 'running'],
    [9, 'leftover'],
  ]);
});

// The environment document plus the Admin API's experiment detail, for check with an Organisation API key.
async function flagsmithServer(doc: EnvironmentDocument, experiments: Record<number, { status: string; audience?: unknown } | number>) {
  const seen: { path: string; auth: string | undefined }[] = [];
  const server = http.createServer((req, res) => {
    const path = req.url ?? '';
    seen.push({ path, auth: req.headers.authorization });
    const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (path === '/api/v1/environment-document/') return send(200, doc);
    const m = /^\/api\/v1\/environments\/envKey1\/experiments\/(\d+)\/$/.exec(path);
    const e = m ? experiments[Number(m[1])] : undefined;
    if (e === undefined) return send(404, { detail: 'Not found.' });
    if (typeof e === 'number') return send(e, { detail: 'refused' });
    return send(200, { id: Number(m![1]), status: e.status, experiment_rollout: e.audience ? { rollout_percentage: 50, audience: e.audience } : null });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { apiUrl: `http://127.0.0.1:${port}/api/v1/`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const half = [{ type: 'ALL', conditions: [{ operator: 'PERCENTAGE_SPLIT', value: '50.0', property_: '$.identity.key' }] }];
const audienceRules = [...half, { type: 'ANY', conditions: [], rules: [{ type: 'ALL', conditions: [{ operator: 'EQUAL', value: 'beta', property_: 'plan' }] }, { type: 'ALL', conditions: [{ operator: 'EQUAL', value: 'eu', property_: 'region' }] }] }];
const v2 = { variants: [{ key: 'v2', weight: 50 }] };

test('with an admin key, created and paused experiments are not left behind; completed and deleted ones are', async () => {
  const doc: EnvironmentDocument = {
    api_key: 'envKey1',
    project: {
      segments: [
        seg(1, half, [fs('a', v2)]),
        seg(2, half, [fs('b', v2)]),
        seg(3, half, [fs('c', v2)]),
        seg(5, half, [fs('e', v2)]),
        seg(6, audienceRules, [fs('f', { ...v2, running: 6 })]),
      ],
    },
  };
  const server = await flagsmithServer(doc, {
    1: { status: 'created' },
    2: { status: 'paused' },
    3: { status: 'completed' },
    6: { status: 'running', audience: { match: 'any', segments: [{ id: 30, name: 'Beta', deleted: false }, { id: 31, name: 'EU', deleted: false }] } },
  });
  try {
    const lines: string[] = [];
    assert.equal(await check({ apiUrl: server.apiUrl, serverKey: 'ser.k', adminKey: 'org.admin', log: (l) => lines.push(l) }), 2);
    assert.ok(lines.includes('! a: experiment 1 is created but not started; its rollout already covers 50% of identities (v2 50%).'), lines.join('\n'));
    assert.ok(lines.includes('! b: experiment 2 is paused; its split still covers 50% of identities (v2 50%).'));
    assert.ok(lines.includes('✗ c: experiment 3 is completed, but its split still covers 50% of identities (v2 50%).'));
    assert.ok(lines.includes('✗ e: experiment 5 is deleted, but its split still covers 50% of identities (v2 50%).'));
    assert.ok(lines.includes('· f: experiment 6 is running on 50% of identities matching any of "Beta", "EU" (v2 50%).'));
    assert.ok(server.seen.filter((s) => s.path.includes('/experiments/')).every((s) => s.auth === 'Api-Key org.admin'));
    assert.ok(!server.seen.some((s) => s.path.includes('/experiments/4/')), 'only the experiments it needs');
  } finally {
    await server.close();
  }
});

test('a refused admin key leaves the findings as the environment document shows them, with a note', async () => {
  const doc: EnvironmentDocument = { api_key: 'envKey1', project: { segments: [seg(1, half, [fs('a', v2)])] } };
  const server = await flagsmithServer(doc, { 1: 401 });
  try {
    const lines: string[] = [];
    assert.equal(await check({ apiUrl: server.apiUrl, serverKey: 'ser.k', adminKey: 'org.revoked', log: (l) => lines.push(l) }), 1);
    assert.match(lines[0]!, /^✗ a: experiment 1 is not running \(created, paused or completed\)/);
    assert.equal(lines.at(-1), '(The Organisation API key was refused (HTTP 401): experiment statuses not read.)');
  } finally {
    await server.close();
  }
});

test('without an admin key, check never calls the Admin API', async () => {
  const doc: EnvironmentDocument = { api_key: 'envKey1', project: { segments: [seg(1, half, [fs('a', v2)])] } };
  const server = await flagsmithServer(doc, { 1: { status: 'created' } });
  try {
    assert.equal(await check({ apiUrl: server.apiUrl, serverKey: 'ser.k', log: () => {} }), 1);
    assert.deepEqual(server.seen.map((s) => s.path), ['/api/v1/environment-document/']);
  } finally {
    await server.close();
  }
});

test('an unreachable Flagsmith is named with the reason, not just "fetch failed"', async () => {
  const closed = http.createServer();
  await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
  const { port } = closed.address() as AddressInfo;
  await new Promise<void>((r) => closed.close(() => r()));
  await assert.rejects(
    check({ apiUrl: `http://127.0.0.1:${port}/api/v1/`, serverKey: 'ser.k', log: () => {} }),
    new RegExp(`^Error: Couldn't reach Flagsmith at http://127\\.0\\.0\\.1:${port}: ECONNREFUSED\\. Is --api-url \\(FLAGSMITH_API_URL\\) right\\?$`),
  );
});
