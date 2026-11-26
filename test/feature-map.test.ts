import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createConsole, TOKEN_HEADER } from '../src/console/server.ts';
import { AdminClient } from '../src/flagsmith/admin.ts';
import { Experiments } from '../src/flagsmith/experiments.ts';
import { buildFlagsmithMap, createMapReader, MAP_CACHE_MS, readMapFacts, type FlagsmithMap, type MapFacts } from '../src/flagsmith/feature-map.ts';
import { flagKey, SEED, seededState, startFakeAdmin, type FakeAdminState } from './fake-admin.ts';

const MENUS = ['Environments', 'Segments', 'Lifecycle', 'Audit Log', 'Segment Change Requests', 'Integrations', 'Compare', 'Project Settings'];
const INTEGRATIONS = [
  'Amplitude', 'Backstage', 'Code References', 'Datadog', 'Dynatrace', 'Flagsmith MCP Server', 'GitHub', 'GitLab', 'Grafana',
  'Heap', 'Jira', 'Mixpanel', 'New Relic', 'Rudderstack', 'Segment', 'Sentry', 'Slack', 'Webhook',
];
const DASH = 'http://localhost:8000';

const facts = (over: Partial<MapFacts> = {}): MapFacts => ({
  flag: 'shop_release',
  envKey: 'envKeyX',
  version: { imageTag: '2.291.0', isEnterprise: false },
  environment: { id: 3, name: 'Production', project: 2 },
  environments: 1,
  feature: { id: 4, initialValue: 'shop:1.4', variants: [{ key: 'v2', value: 'shop:1.5' }], tagIds: [7, 8], lifecycleStage: 'permanent', segmentOverrides: 2 },
  tags: [{ id: 7, label: 'release', isPermanent: true }, { id: 8, label: 'Unhealthy', isPermanent: false }],
  segments: [{ id: 11, name: 'turnout-preview' }],
  lifecycleCounts: { new: 0, live: 0, stale: 0, permanent: 1, needs_monitoring: 0, to_remove: 0 },
  codeReferences: [],
  healthProviders: ['Webhook'],
  auditVisible: 0,
  evaluations: { days: 7, total: 38521 },
  experiment: { id: 12, name: 'shop_release: shop:1.6 vs shop:1.5', status: 'running' },
  experimentsOnFlag: 3,
  metrics: ['order_placed', 'doc_latency_ms', 'server_error'],
  eventStore: 'connected',
  events: { accepted: 324, rejected: 2 },
  ledgerEntries: 2,
  integrations: { grafana: 0, webhook: 0 },
  ...over,
});
const byName = (map: FlagsmithMap, name: string) => {
  const item = map.items.find((i) => i.name === name);
  assert.ok(item, `no item "${name}"`);
  return item;
};

describe('the feature map', () => {
  test('lists every dashboard menu and every integration, plus the features Turnout uses without a menu', () => {
    const map = buildFlagsmithMap(facts(), { dashboardUrl: `${DASH}/`, now: new Date('2026-11-17T12:00:00Z') });
    assert.deepEqual(map.items.filter((i) => i.kind === 'menu').map((i) => i.name), MENUS);
    assert.deepEqual(map.items.filter((i) => i.kind === 'integration').map((i) => i.name).sort(), [...INTEGRATIONS].sort());
    for (const name of ['Multivariate flag', 'Experiments', 'Metrics', 'Feature Health', 'Flag Analytics', 'Prometheus events counter']) byName(map, name);
    assert.equal(new Set(map.items.map((i) => i.id)).size, map.items.length, 'ids are unique');
    assert.deepEqual(map.flagsmith, { version: '2.291.0', dashboardUrl: DASH, projectId: 2, environment: 'Production', flag: 'shop_release' });
    assert.equal(map.generatedAt, '2026-11-17T12:00:00.000Z');
    const total = Object.values(map.counts).reduce((a, b) => a + b, 0);
    assert.equal(total, map.items.length);
  });

  test('every item has one plain sentence; every "not available here" says what it needs and cites Flagsmith source', () => {
    const map = buildFlagsmithMap(facts(), { dashboardUrl: DASH });
    for (const item of map.items) {
      assert.match(item.what, /^[A-Z"“].*[.)]$/, `${item.name}: ${item.what}`);
      if (item.status === 'not-available-locally') {
        assert.ok(item.needs, `${item.name} needs`);
        assert.match(item.source ?? '', /\.(py|ts|tsx):\d+/, `${item.name} source`);
      }
    }
  });

  test('statuses for this demo', () => {
    const map = buildFlagsmithMap(facts(), { dashboardUrl: DASH });
    const status = (name: string) => byName(map, name).status;
    for (const name of ['Environments', 'Segments', 'Project Settings', 'Multivariate flag', 'Experiments', 'Metrics', 'Feature Health', 'Flag Analytics']) {
      assert.equal(status(name), 'used', name);
    }
    for (const name of ['Lifecycle', 'Integrations', 'Prometheus events counter']) assert.equal(status(name), 'used-read-only', name);
    for (const name of ['Audit Log', 'Segment Change Requests', ...INTEGRATIONS.filter((n) => n !== 'Code References')]) {
      assert.equal(status(name), 'not-available-locally', name);
    }
    assert.equal(status('Compare'), 'not-used');
    assert.equal(status('Code References'), 'not-used', 'until a scan names the flag');
  });

  test('live values come from the facts', () => {
    const map = buildFlagsmithMap(facts(), { dashboardUrl: DASH });
    assert.equal(byName(map, 'Segments').live, '1 segment, including turnout-preview; 2 segment overrides on shop_release');
    assert.equal(byName(map, 'Lifecycle').live, 'shop_release is permanent; project: permanent 1');
    assert.equal(byName(map, 'Audit Log').live, "0 entries visible through the API; 2 decisions in Turnout's ledger");
    assert.equal(byName(map, 'Segment Change Requests').live, 'this image: 2.291.0, is_enterprise false');
    assert.equal(byName(map, 'Feature Health').live, 'provider: Webhook; shop_release is tagged Unhealthy');
    assert.equal(byName(map, 'Tags').live, 'release (permanent), Unhealthy');
    assert.equal(byName(map, 'Flag Analytics').live, '38,521 evaluations in the last 7 days');
    assert.equal(byName(map, 'Prometheus events counter').live, 'accepted 324 · rejected 2');
    assert.equal(byName(map, 'Multivariate flag').live, 'control → shop:1.4 · v2 → shop:1.5');
    assert.equal(byName(map, 'Grafana').live, 'none configured on this instance');
    assert.equal(byName(map, 'Datadog').live, null, 'not read');
  });

  test("links follow Flagsmith's dashboard routes", () => {
    const map = buildFlagsmithMap(facts(), { dashboardUrl: DASH });
    const link = (name: string) => byName(map, name).link;
    assert.equal(link('Environments'), `${DASH}/project/2/environment/envKeyX/features?feature=4`);
    assert.equal(link('Segments'), `${DASH}/project/2/segments/11`);
    assert.equal(link('Lifecycle'), `${DASH}/project/2/lifecycle/permanent`);
    assert.equal(link('Audit Log'), `${DASH}/project/2/audit-log`);
    assert.equal(link('Segment Change Requests'), `${DASH}/project/2/change-requests`);
    assert.equal(link('Compare'), `${DASH}/project/2/compare`);
    assert.equal(link('Project Settings'), `${DASH}/project/2/settings?tab=feature-health`);
    assert.equal(link('Grafana'), `${DASH}/project/2/integrations`);
    assert.equal(link('Experiments'), `${DASH}/project/2/environment/envKeyX/experiments/12`);
    assert.equal(link('Metrics'), `${DASH}/project/2/environment/envKeyX/metrics`);
    assert.equal(link('Flag Analytics'), `${DASH}/project/2/environment/envKeyX/features?feature=4&tab=usage`);
    assert.equal(link('Feature Health'), `${DASH}/project/2/environment/envKeyX/features?feature=4&tab=health`);
    assert.equal(link('Prometheus events counter'), null);
  });

  test('Code References turns "used" once a scan names the flag, and says whether any reference is in the app', () => {
    const scan = (file: string) => ({
      repositoryUrl: 'https://github.com/acme/app',
      revision: 'abc123def4567890',
      scannedAt: '2026-11-17T00:00:00Z',
      references: [{ file, line: 2, permalink: `https://github.com/acme/app/blob/abc123def4567890/${file}#L2` }],
    });
    const used = byName(buildFlagsmithMap(facts({ codeReferences: [scan('turnout.config.yml')] }), { dashboardUrl: DASH }), 'Code References');
    assert.equal(used.status, 'used');
    assert.equal(used.live, '1 reference: turnout.config.yml:2');
    assert.match(used.what, /none in demo\//);
    assert.deepEqual(used.details, [{ text: 'turnout.config.yml:2 @ abc123def456', href: 'https://github.com/acme/app/blob/abc123def4567890/turnout.config.yml#L2' }]);
    const inApp = byName(buildFlagsmithMap(facts({ codeReferences: [scan('demo/shop/server.ts')] }), { dashboardUrl: DASH }), 'Code References');
    assert.match(inApp.what, /1 reference in app code/);
  });

  test('missing facts blank values and links, never the map', () => {
    const empty = facts({
      version: null, environment: null, environments: null, feature: null, tags: null, segments: null, lifecycleCounts: null, codeReferences: null,
      healthProviders: null, auditVisible: null, evaluations: null, experiment: null, experimentsOnFlag: null, metrics: null, eventStore: null,
      events: null, ledgerEntries: null, integrations: null,
    });
    const map = buildFlagsmithMap(empty, { dashboardUrl: DASH });
    assert.equal(map.items.length, buildFlagsmithMap(facts(), { dashboardUrl: DASH }).items.length);
    for (const item of map.items) {
      assert.equal(item.live, null, item.name);
      assert.equal(item.link, null, item.name);
    }
  });
});

describe('reading the facts from Flagsmith', () => {
  let state: FakeAdminState;
  let fake: { apiUrl: string; close: () => Promise<void> };
  let api: AdminClient;
  before(async () => {
    state = seededState();
    state.tags.push({ id: 50, label: 'release', color: '#0AADDF', description: '', is_permanent: true, project: SEED.projectId });
    state.features[0]!.tags = [50];
    state.segments.push({ id: 51, name: 'turnout-preview', project: SEED.projectId, rules: [] });
    state.healthProviders.push({ name: 'Webhook', project: SEED.projectId, created_by: null, webhook_url: 'http://localhost:8000/api/v1/feature-health/SECRET' });
    state.evaluations = [{ day: '2026-11-16', count: 100 }, { day: '2026-11-17', count: 23 }];
    state.codeScans.push({
      project: SEED.projectId,
      repositoryUrl: 'https://github.com/acme/app',
      revision: 'abc123',
      at: '2026-11-17T00:00:00Z',
      references: [{ feature_name: 'shop_release', file_path: 'turnout.config.yml', line_number: 2 }],
    });
    fake = await startFakeAdmin(state);
    api = new AdminClient(fake.apiUrl, { apiKey: SEED.adminKey });
  });
  after(() => fake.close());

  test('every value, from its own endpoint', async () => {
    const f = await readMapFacts({ api, envKey: SEED.envKey, flag: 'shop_release', readEvents: async () => ({ accepted: 5, rejected: 0 }) });
    assert.deepEqual(f.version, { imageTag: '2.291.0', isEnterprise: false });
    assert.deepEqual(f.environment, { id: 3, name: 'Production', project: SEED.projectId });
    assert.equal(f.environments, 1);
    assert.equal(f.feature?.id, SEED.featureId);
    assert.equal(f.feature?.lifecycleStage, 'permanent', 'the permanent tag wins over code references');
    assert.equal(f.feature?.segmentOverrides, 1);
    assert.deepEqual(f.tags, [{ id: 50, label: 'release', isPermanent: true }]);
    assert.deepEqual(f.segments?.map((s) => s.name), ['experiment-9-rollout', 'turnout-preview']);
    assert.equal(f.lifecycleCounts?.permanent, 1);
    assert.equal(f.codeReferences?.[0]?.references[0]?.permalink, 'https://github.com/acme/app/blob/abc123/turnout.config.yml#L2');
    assert.deepEqual(f.healthProviders, ['Webhook']);
    assert.equal(f.auditVisible, 0);
    assert.deepEqual(f.evaluations, { days: 7, total: 123 });
    assert.deepEqual(f.experiment, { id: SEED.experimentId, name: 'shop_release: shop:1.5 vs shop:1.4', status: 'completed' });
    assert.deepEqual(f.metrics, ['order_placed', 'doc_latency_ms', 'server_error']);
    assert.equal(f.eventStore, 'not connected');
    assert.deepEqual(f.events, { accepted: 5, rejected: 0 });
    assert.equal(f.integrations?.grafana, 0);
    assert.equal(f.integrations?.webhook, 0);
    assert.equal(f.integrations?.github, 0);
    assert.ok(!JSON.stringify(f).includes('SECRET'), "the health provider's secret URL never leaves the server");
  });

  test('an endpoint that fails blanks only its own value', async () => {
    state.failWhen = (_m, path) => path.endsWith('/feature-lifecycle-counts/');
    const f = await readMapFacts({ api, envKey: SEED.envKey, flag: 'shop_release' });
    assert.equal(f.lifecycleCounts, null);
    assert.equal(f.environments, 1);
  });

  test('the console reader caches the map briefly (evaluation data allows 5 reads a minute)', async () => {
    let t = 1_000_000;
    const reader = createMapReader({
      experiments: async () => new Experiments(api, { envKey: SEED.envKey, experimentId: SEED.experimentId }),
      dashboardUrl: DASH,
      now: () => t,
    });
    const reads = () => state.requests.filter((r) => r.path.includes('/evaluation-data/')).length;
    const before = reads();
    const [a, b] = await Promise.all([reader.read(), reader.read()]);
    assert.equal(a, b);
    assert.equal(reads() - before, 1);
    t += MAP_CACHE_MS - 1;
    await reader.read();
    assert.equal(reads() - before, 1);
    t += 2;
    await reader.read();
    assert.equal(reads() - before, 2);
    assert.equal(byName(a, 'Experiments').live, `experiment ${SEED.experimentId} is completed; 1 experiment on shop_release so far`);
  });
});

describe('the console serves the map', () => {
  let fake: { apiUrl: string; close: () => Promise<void> };
  let server: http.Server;
  let base = '';
  before(async () => {
    const state = seededState();
    state.flags.get(flagKey(SEED.envKey, SEED.featureId));
    fake = await startFakeAdmin(state);
    server = createConsole({
      experiments: new Experiments(new AdminClient(fake.apiUrl, { apiKey: SEED.adminKey }), { envKey: SEED.envKey, experimentId: SEED.experimentId }),
      feedUrl: 'http://127.0.0.1:9',
      snapshotDir: mkdtempSync(join(tmpdir(), 'sy-map-snap-')),
      ledgerDir: mkdtempSync(join(tmpdir(), 'sy-map-ledger-')),
      uiDir: fileURLToPath(new URL('../src/console/ui/', import.meta.url)),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await fake.close();
  });

  test('/flagsmith is a page with the token; /api/flagsmith-map needs it and answers the map', async () => {
    const page = await (await fetch(`${base}/flagsmith`)).text();
    const token = page.match(/<meta name="turnout-console" content="([\w-]{32})">/)?.[1];
    assert.ok(token, 'the page carries the API token');
    assert.equal((await fetch(`${base}/api/flagsmith-map`)).status, 403);
    const res = await fetch(`${base}/api/flagsmith-map`, { headers: { [TOKEN_HEADER]: token } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const map = (await res.json()) as FlagsmithMap;
    assert.equal(map.flagsmith.flag, 'shop_release');
    assert.equal(map.flagsmith.dashboardUrl, DASH);
    assert.deepEqual(map.items.filter((i) => i.kind === 'menu').map((i) => i.name), MENUS);
  });
});
