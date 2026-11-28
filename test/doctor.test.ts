// turnout doctor: gatherFacts() against the admin fake plus stand-ins for the proxy, the console and Flagsmith's
// Prometheus endpoint; evaluate() (pure) on those facts and on variations of them; the table; GET /api/doctor and /setup.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { evaluate, formatReport, gatherFacts, PINNED_FLAGSMITH_VERSION, runDoctor, summarize, writeProblem, type DoctorCheck, type DoctorFacts, type DoctorOptions } from '../src/commands/doctor.ts';
import { parseConfig } from '../src/config.ts';
import { createConsole } from '../src/console/server.ts';
import { ENV, initialState, startFakeFlagsmith } from './fake-flagsmith.ts';
import { flagKey, SEED, seededState, startFakeAdmin, type FakeAdminState } from './fake-admin.ts';
import { AdminClient, type Metric } from '../src/flagsmith/admin.ts';
import { Experiments } from '../src/flagsmith/experiments.ts';

const SERVER_KEY = 'ser.seedkey';
const PREVIEW_TOKEN = 'preview-secret-token';
const WEBHOOK_SECRET = 'secretWebhookPath42';

const listen = (server: http.Server) =>
  new Promise<string>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
  );

const config = parseConfig({
  flag: 'shop_release',
  releases: { 'shop:1.4': 'http://shop-1-4:8080', 'shop:1.5': 'http://shop-1-5:8080', 'shop:1.6': 'http://shop-1-6:8080' },
  goal: { event: 'order_placed', when: { method: 'POST', path: '/checkout', status: '2xx' } },
  guardrails: ['doc_latency_ms', 'server_error'],
});

// A project as init leaves it, plus what init also creates: the server key, the event store, the tag, the provider.
function readyState(): FakeAdminState {
  const state = seededState();
  state.serverKeys.push({ envKey: SEED.envKey, key: SERVER_KEY, name: 'Turnout proxy' });
  state.warehouses.push({ id: 50, status: 'connected', warehouse_type: 'postgres', config: { source: 'flagsmith_database' }, envKey: SEED.envKey });
  state.tags.push({ id: 51, label: 'release', color: '#0AADDF', description: '', is_permanent: true, project: SEED.projectId });
  state.features[0]!.tags = [51];
  state.healthProviders.push({ name: 'Webhook', project: SEED.projectId, created_by: null, webhook_url: `http://localhost:8000/api/v1/feature-health/${WEBHOOK_SECRET}` });
  return state;
}

let state: FakeAdminState;
let admin: { apiUrl: string; close: () => Promise<void> };
const seenDebug: (string | undefined)[] = [];
const proxy = http.createServer((req, res) => {
  const debug = req.headers['x-turnout-debug'] as string | undefined;
  seenDebug.push(debug);
  const upstreams = Object.fromEntries(['shop:1.4', 'shop:1.5', 'shop:1.6'].map((l) => [l, { ok: true, status: 200, ms: 4 }]));
  res.writeHead(req.url === '/__turnout/health' ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    flagsmith: { ready: true, environmentAgeSeconds: 2, lastError: null },
    liveRelease: 'shop:1.4',
    fallbacks: {},
    undeliveredEvents: 0,
    ...(debug === PREVIEW_TOKEN ? { upstreams } : {}),
  }));
});
// Like the console: anything but a localhost Host header gets a 421.
const consoleStub = http.createServer((req, res) => res.writeHead(req.headers.host?.startsWith('localhost:') ? 200 : 421).end());
const metrics = http.createServer((_req, res) =>
  res.end('flagsmith_experimentation_sdk_events_total{result="accepted"} 1200.0\nflagsmith_experimentation_sdk_events_total{result="rejected"} 0.0\n'),
);
let options: DoctorOptions;
let facts: DoctorFacts;

before(async () => {
  state = readyState();
  admin = await startFakeAdmin(state);
  options = {
    apiUrl: admin.apiUrl,
    config,
    adminKey: SEED.adminKey,
    serverKey: SERVER_KEY,
    experimentRef: `${SEED.envKey}/${SEED.experimentId}`,
    previewToken: PREVIEW_TOKEN,
    healthWebhook: `http://flagsmith:8000/api/v1/feature-health/${WEBHOOK_SECRET}`,
    proxyUrl: await listen(proxy),
    consoleUrl: await listen(consoleStub),
    metricsUrl: `${await listen(metrics)}/metrics`,
  };
  facts = await gatherFacts(options);
});

after(async () => {
  for (const s of [proxy, consoleStub, metrics]) s.close();
  await admin.close();
});

const find = (checks: DoctorCheck[], name: string) => {
  const c = checks.find((x) => x.name === name);
  assert.ok(c, `no check named "${name}" in ${checks.map((x) => x.name).join(', ')}`);
  return c;
};
const variant = (change: (f: DoctorFacts) => void): DoctorCheck[] => {
  const copy = structuredClone(facts);
  change(copy);
  return evaluate(copy);
};
const value = <T>(g: unknown) => (g as { value: T }).value;

describe('doctor on a project set up the way init leaves it', () => {
  test('every check passes', () => {
    const checks = evaluate(facts);
    const bad = checks.filter((c) => c.status !== 'ok');
    assert.deepEqual(bad, [], 'nothing should differ');
    const names = checks.map((c) => `${c.area} / ${c.name}`);
    for (const expected of [
      'Flagsmith / API', 'Flagsmith / Version', 'Flagsmith / Admin user', 'Flagsmith / Event store',
      'Keys / Admin key', 'Keys / Environment', 'Keys / Server key',
      'Release flag / Flag', 'Release flag / Multivariate', 'Release flag / Tag "release"', 'Release flag / Values name releases',
      'Release flag / On in this environment', 'Release flag / Serving everyone else', 'Release flag / Preview segment',
      'Metrics / order_placed', 'Metrics / doc_latency_ms', 'Metrics / server_error',
      'Experiment / State', 'Feature Health / Webhook provider',
      'Turnout / Proxy', 'Turnout / shop:1.4', 'Turnout / shop:1.5', 'Turnout / shop:1.6', 'Turnout / Console',
      'Events / Flagsmith\'s counter', 'Events / Proxy deliveries',
    ]) assert.ok(names.includes(expected), `missing ${expected}`);
    assert.match(find(checks, 'State').actual, /no experiment running \(1 completed\); no split left behind/);
    assert.equal(find(checks, "Flagsmith's counter").actual, '1,200 accepted, 0 rejected');
  });

  test('asks the proxy for the release containers with the debug token, and the console as localhost', () => {
    assert.ok(seenDebug.includes(PREVIEW_TOKEN));
    assert.equal(value<number>(facts.console), 200);
  });

  test('reads only: no write reaches Flagsmith', () => {
    assert.deepEqual(state.requests.filter((r) => r.method !== 'GET'), []);
  });

  test('keys, tokens and the webhook path never appear in the report', async () => {
    const report = JSON.stringify(await runDoctor(options));
    for (const secret of [SEED.adminKey, SERVER_KEY, PREVIEW_TOKEN, WEBHOOK_SECRET]) assert.ok(!report.includes(secret), secret);
  });

  test('a running experiment is fine; the preview segment must outrank its rollout', async () => {
    state.experiments[0]!.status = 'running';
    state.experiments[0]!.experiment_rollout!.rollout_percentage = 100;
    state.segments.push({ id: 60, name: 'turnout-preview', project: SEED.projectId, rules: [{ type: 'ALL', rules: [{ type: 'ANY', conditions: [{ operator: 'EQUAL', property: 'preview', value: 'true' }] }], conditions: [] }] });
    const flag = state.flags.get(flagKey(SEED.envKey, SEED.featureId))!;
    flag.segment_overrides.push({ segment: { id: 60 }, priority: 5, enabled: true, value: { type: 'string', value: 'shop:1.4' }, variants: [{ id: SEED.v2Id, weight: 100 }] });
    try {
      let checks = evaluate(await gatherFacts(options));
      assert.equal(find(checks, 'State').status, 'ok');
      assert.match(find(checks, 'State').actual, /^experiment 9 running/);
      const preview = find(checks, 'Preview segment');
      assert.equal(preview.status, 'warn');
      assert.equal(preview.expected, "ranks above the experiment's rollout");
      assert.match(preview.fix ?? '', /preview before turnout release/);

      flag.segment_overrides.find((o) => o.segment.id === 60)!.priority = -1; // above the rollout (priority 0)
      checks = evaluate(await gatherFacts(options));
      assert.equal(find(checks, 'Preview segment').status, 'ok');
      assert.equal(find(checks, 'Preview segment').actual, 'serves shop:1.5 to browsers that opened the preview link');
    } finally {
      state.experiments[0]!.status = 'completed';
      state.experiments[0]!.experiment_rollout!.rollout_percentage = 0;
      state.segments.pop();
      flag.segment_overrides = flag.segment_overrides.filter((o) => o.segment.id !== 60);
    }
  });
});

describe('evaluate: each difference, with expected and actual', () => {
  test('another Flagsmith version is a warning', () => {
    const c = find(variant((f) => (value<{ image_tag: string }>(f.version).image_tag = '2.290.0')), 'Version');
    assert.deepEqual([c.status, c.expected, c.actual], ['warn', PINNED_FLAGSMITH_VERSION, '2.290.0']);
    assert.ok(c.fix);
  });

  test('a variant value that is not an allowlisted release fails', () => {
    const c = find(variant((f) => (value<{ multivariate_options: { string_value: string }[] }>(f.feature).multivariate_options[0]!.string_value = 'shop:9.9')), 'Values name releases');
    assert.equal(c.status, 'fail');
    assert.equal(c.expected, 'each one of shop:1.4, shop:1.5, shop:1.6');
    assert.match(c.actual, /v2 = "shop:9\.9" not in turnout\.config\.yml/);
  });

  test('a flag without variants is not multivariate', () => {
    const c = find(variant((f) => (value<{ multivariate_options: unknown[] }>(f.feature).multivariate_options = [])), 'Multivariate');
    assert.deepEqual([c.status, c.actual], ['fail', 'not multivariate (no variants)']);
  });

  test('a missing flag stops the flag checks there', () => {
    const checks = variant((f) => (f.feature = { value: null }));
    assert.deepEqual([find(checks, 'Flag').status, find(checks, 'Flag').actual], ['fail', 'missing']);
    assert.ok(!checks.some((c) => c.name === 'Values name releases' || c.area === 'Experiment'));
  });

  test('a metric with the wrong direction or aggregation fails; a missing one too', () => {
    let c = find(variant((f) => (value<{ definition: { event: string }; direction: string }[]>(f.metrics).find((m) => m.definition.event === 'doc_latency_ms')!.direction = 'up')), 'doc_latency_ms');
    assert.deepEqual([c.status, c.expected, c.actual], ['fail', 'mean, down is better (guardrail)', 'mean, up is better']);
    c = find(variant((f) => (f.metrics = { value: value<Metric[]>(f.metrics).filter((m) => m.definition.event !== 'order_placed') })), 'order_placed');
    assert.deepEqual([c.status, c.actual], ['fail', 'missing']);
  });

  test('a split left behind fails, with how much traffic it covers', () => {
    const c = find(variant((f) => {
      const seg = value<{ project: { segments: { name: string; rules: { conditions: { value: string }[] }[] }[] } }>(f.document).project.segments.find((s) => s.name === 'experiment-9-rollout')!;
      seg.rules[0]!.conditions[0]!.value = '50';
    }), 'State');
    assert.equal(c.status, 'fail');
    assert.match(c.actual, /experiment 9 isn't running, but its split still covers 50% of visitors/);
  });

  test('a paused experiment is a warning that says how to finish it', () => {
    const c = find(variant((f) => (value<{ status: string }[]>(f.experiments)[0]!.status = 'paused')), 'State');
    assert.deepEqual([c.status, c.actual], ['warn', 'experiment 9 is paused']);
    assert.match(c.fix ?? '', /Ship winner or Revert/);
  });

  // The experiment-9-rollout segment in the environment document, to shape it per test.
  type DocSeg = { name: string; rules: unknown[]; feature_states: { metadata: unknown }[] };
  const rolloutSeg = (f: DoctorFacts) => value<{ project: { segments: DocSeg[] } }>(f.document).project.segments.find((s) => s.name === 'experiment-9-rollout')!;
  const split50 = { type: 'ALL', conditions: [{ operator: 'PERCENTAGE_SPLIT', value: '50.0', property_: '$.identity.key' }] };
  const audience = (...conditions: { property_: string; value: string }[]) => ({
    type: 'ANY',
    conditions: [],
    rules: conditions.map((c) => ({ type: 'ALL', conditions: [{ operator: 'EQUAL', ...c }] })),
  });

  test("a created or paused experiment's split is its own, not one left behind", () => {
    for (const status of ['created', 'paused']) {
      const c = find(variant((f) => {
        value<{ status: string }[]>(f.experiments)[0]!.status = status;
        rolloutSeg(f).rules = [split50];
      }), 'State');
      assert.deepEqual([c.status, c.actual], ['warn', `experiment 9 is ${status}; its split covers 50% of visitors`]);
    }
  });

  test('a split left behind that is limited to an audience says so', () => {
    const c = find(variant((f) => (rolloutSeg(f).rules = [split50, audience({ property_: 'plan', value: 'beta' }, { property_: 'region', value: 'eu' })])), 'State');
    assert.equal(c.status, 'fail');
    assert.equal(c.actual, "experiment 9 isn't running, but its split still covers 50% of visitors matching any of its 2 audience segments");
  });

  test("a running experiment's audience on traits the proxy never sends is a warning", () => {
    const running = (rules: unknown[]) => variant((f) => {
      value<{ status: string }[]>(f.experiments)[0]!.status = 'running';
      const seg = rolloutSeg(f);
      seg.rules = rules;
      for (const s of seg.feature_states) s.metadata = { experiment: { id: 9, name: 'x', in_experiment: true } };
    });
    let checks = running([split50, audience({ property_: 'plan', value: 'beta' })]);
    assert.equal(find(checks, 'State').status, 'ok');
    assert.match(find(checks, 'State').actual, /^experiment 9 running: .*\(its split covers 50% of visitors matching its audience segment\)$/);
    const a = find(checks, 'Audience');
    assert.equal(a.status, 'warn');
    assert.match(a.actual, /audience reads trait plan, which the proxy never sends/);
    assert.match(a.fix ?? '', /turnout release/);

    checks = running([split50, audience({ property_: 'preview', value: 'true' })]);
    assert.deepEqual([find(checks, 'Audience').status, find(checks, 'Audience').actual], ['ok', 'the split covers 50% of visitors matching its audience segment']);

    checks = running([split50]);
    assert.ok(!checks.some((c) => c.name === 'Audience'), 'no audience, no check');

    // IS_NOT_SET on a trait the proxy never sends matches every visitor (flag_engine segments/evaluator.py:518-519).
    const notSet = { type: 'ANY', conditions: [], rules: [{ type: 'ALL', conditions: [{ operator: 'IS_NOT_SET', property_: 'plan', value: null }] }] };
    checks = running([split50, notSet]);
    const u = find(checks, 'Audience');
    assert.equal(u.status, 'ok');
    assert.equal(u.actual, 'the split covers 50% of visitors matching its audience segment; its "is not set" condition on trait plan matches every visitor');
    assert.doesNotMatch(u.actual, /match no visitor/);
  });

  test('the tag missing from the flag is a warning', () => {
    const c = find(variant((f) => (value<{ tags: number[] }>(f.feature).tags = [])), 'Tag "release"');
    assert.deepEqual([c.status, c.actual], ['warn', 'the tag exists, but not on the flag']);
  });

  test('a release container that is down fails and names the service to start', () => {
    const c = find(variant((f) => (value<{ upstreams: Record<string, unknown> }>(f.proxy).upstreams['shop:1.6'] = { ok: false, ms: 3000, error: 'ENOTFOUND' })), 'shop:1.6');
    assert.deepEqual([c.status, c.expected, c.actual], ['fail', 'container shop-1-6 answers', 'unreachable (ENOTFOUND)']);
    assert.match(c.fix ?? '', /docker compose up -d shop-1-6/);
  });

  test('without the preview token the containers are not checked, which is a warning', () => {
    const checks = variant((f) => {
      delete value<{ upstreams?: unknown }>(f.proxy).upstreams;
      f.given.previewToken = false;
    });
    assert.deepEqual([find(checks, 'Release containers').status, find(checks, 'Release containers').actual], ['warn', 'not checked: needs TURNOUT_PREVIEW_TOKEN']);
  });

  test('the Feature Health provider at another URL fails, without showing either URL', () => {
    const c = find(variant((f) => (f.given.healthWebhook = 'http://flagsmith:8000/api/v1/feature-health/other')), 'Webhook provider');
    assert.deepEqual([c.status, c.actual], ['fail', 'exists, at a different URL']);
    assert.ok(!JSON.stringify(c).includes('feature-health'));
    assert.equal(find(variant((f) => (f.given.healthWebhook = undefined)), 'Webhook provider').status, 'ok');
  });

  test('a server key for another environment fails', () => {
    const c = find(variant((f) => (value<{ api_key: string }>(f.document).api_key = 'otherEnv')), 'Server key');
    assert.deepEqual([c.status, c.actual], ['fail', 'valid, but for another environment']);
    const refused = find(variant((f) => (f.document = { error: 'x', status: 403 })), 'Server key');
    assert.deepEqual([refused.status, refused.actual], ['fail', 'refused (HTTP 403)']);
  });

  test('without the admin key only the key fails; nothing that needs it is reported', () => {
    const checks = variant((f) => {
      f.given.adminKey = false;
      for (const k of ['organisations', 'environment', 'warehouses', 'feature', 'flag', 'tags', 'metrics', 'experiments', 'segments', 'providers'] as const) delete f[k];
    });
    assert.equal(find(checks, 'Admin key').status, 'fail');
    assert.equal(find(checks, 'Admin key').actual, 'not set');
    assert.ok(!checks.some((c) => ['Release flag', 'Metrics', 'Experiment'].includes(c.area)));
    assert.equal(find(checks, 'Server key').status, 'ok', 'the server key is checked on its own');
  });

  test('Flagsmith down: one failure with the fix; the proxy and console are still checked', () => {
    const checks = variant((f) => {
      f.version = { error: 'fetch failed (ECONNREFUSED)' };
      for (const k of ['organisations', 'environment', 'document', 'warehouses', 'feature', 'flag', 'tags', 'metrics', 'experiments', 'segments', 'providers'] as const) delete f[k];
    });
    const api = find(checks, 'API');
    assert.deepEqual([api.status, api.actual], ['fail', 'fetch failed (ECONNREFUSED)']);
    assert.match(api.fix ?? '', /docker compose up -d --wait flagsmith/);
    assert.equal(find(checks, 'Proxy').status, 'ok');
    assert.equal(find(checks, 'Console').status, 'ok');
  });

  test("events: rejections and an unreadable counter are warnings", () => {
    assert.equal(find(variant((f) => (f.events = { accepted: 10, rejected: 3 })), "Flagsmith's counter").status, 'warn');
    const c = find(variant((f) => (f.events = null)), "Flagsmith's counter");
    assert.equal(c.status, 'warn');
    assert.match(c.fix ?? '', /docker compose run --rm cli doctor/);
  });

  test('events: from the host the unpublished counter is skipped, not a warning', async () => {
    const c = find(variant((f) => {
      f.events = null;
      f.fromHost = true;
    }), "Flagsmith's counter");
    assert.equal(c.status, 'ok');
    assert.match(c.actual, /^not checked from the host: .*port 9100 inside Compose only/);
    assert.equal(c.fix, undefined);
    // A counter that does answer from the host (someone published the port) is still read and checked.
    assert.equal(find(variant((f) => (f.fromHost = true)), "Flagsmith's counter").actual, '1,200 accepted, 0 rejected');
    // gatherFacts carries the option through.
    const fromHost = await gatherFacts({ ...options, fromHost: true, metricsUrl: 'http://127.0.0.1:9/metrics' });
    assert.equal(fromHost.fromHost, true);
    assert.equal(find(evaluate(fromHost), "Flagsmith's counter").status, 'ok');
    // Your own Flagsmith with no FLAGSMITH_METRICS_URL: nothing to read, so it's skipped rather than a warning.
    const own = find(variant((f) => {
      f.events = null;
      f.metricsUrl = undefined;
    }), "Flagsmith's counter");
    assert.equal(own.status, 'ok');
    assert.match(own.actual, /FLAGSMITH_METRICS_URL/);
  });

  test("the state folder and .env: checked only when given; one Ship or Revert can't write fails, with the chown fix", async () => {
    assert.ok(!evaluate(facts).some((c) => c.name === 'State folder' || c.name === '.env file'));
    const ok = find(variant((f) => (f.writable = [{ label: 'State folder', path: '.turnout', problem: null }])), 'State folder');
    assert.equal(ok.status, 'ok');
    assert.equal(ok.area, 'Turnout');
    const bad = find(variant((f) => (f.writable = [{ label: 'State folder', path: '.turnout', problem: 'EACCES: /app/.turnout is not writable by this process' }])), 'State folder');
    assert.equal(bad.status, 'fail');
    assert.match(bad.actual, /^EACCES/);
    assert.ok((bad.fix ?? '').includes('chown -R "$(id -u):$(id -g)" .turnout'), bad.fix);
    assert.match(bad.fix ?? '', /TURNOUT_UID/);
    const env = find(variant((f) => (f.writable = [{ label: '.env file', path: '.env', problem: 'EACCES: x' }])), '.env file');
    assert.equal(env.status, 'fail');
    assert.match(env.fix ?? '', /chown/);
    // gatherFacts checks the paths it is given; a folder that doesn't exist yet counts when its parent is writable.
    const dir = mkdtempSync(join(tmpdir(), 'doctor-state-'));
    writeFileSync(join(dir, '.env'), 'A=1');
    const gathered = await gatherFacts({ ...options, stateDir: join(dir, 'not-yet', '.turnout'), envFile: join(dir, '.env') });
    assert.deepEqual(gathered.writable?.map((w) => [w.label, w.problem]), [['State folder', null], ['.env file', null]]);
  });

  test('writeProblem: a read-only snapshots folder is reported with its code (POSIX permissions)', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-ro-'));
    const state = join(dir, '.turnout');
    mkdirSync(join(state, 'snapshots'), { recursive: true });
    assert.equal(writeProblem(state, 'dir'), null);
    chmodSync(join(state, 'snapshots'), 0o555);
    try {
      assert.match(writeProblem(state, 'dir') ?? '', /^EACCES: .*snapshots is not writable/);
    } finally {
      chmodSync(join(state, 'snapshots'), 0o755);
    }
  });

  test('writeProblem: a read-only file is reported on every platform', { skip: process.getuid?.() === 0 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-ro-'));
    const env = join(dir, '.env');
    writeFileSync(env, 'A=1');
    chmodSync(env, 0o444); // the read-only attribute on Windows
    try {
      assert.match(writeProblem(env, 'file') ?? '', /is not writable by this process$/);
    } finally {
      chmodSync(env, 0o644);
    }
  });

  test('the proxy without the flag loaded is a warning; the proxy down fails', () => {
    assert.equal(find(variant((f) => (value<{ flagsmith: { ready: boolean } }>(f.proxy).flagsmith.ready = false)), 'Proxy').status, 'warn');
    const checks = variant((f) => (f.proxy = { error: 'fetch failed (ECONNREFUSED)' }));
    assert.equal(find(checks, 'Proxy').status, 'fail');
    assert.ok(!checks.some((c) => c.name === 'shop:1.4' || c.name === 'Proxy deliveries'));
  });

  test('ok checks carry no fix', () => {
    for (const c of evaluate(facts)) assert.equal(c.fix, undefined, c.name);
  });
});

describe('the terminal table', () => {
  test('expected and fix under each mismatch; a summary line', () => {
    const checks = variant((f) => (value<{ image_tag: string }>(f.version).image_tag = '2.290.0'));
    const lines = formatReport({ at: '2026-11-17T00:00:00Z', checks, summary: summarize(checks) });
    const i = lines.findIndex((l) => l.includes('[WARN] Version'));
    assert.ok(i > 0);
    assert.match(lines[i]!, /2\.290\.0$/);
    assert.match(lines[i + 1]!, /expected: 2.295.2$/);
    assert.match(lines[i + 2]!, /fix: /);
    assert.ok(lines.includes('Flagsmith'), 'grouped under area headings');
    assert.match(lines.at(-1)!, /^\d+ ok, 1 warning, 0 failing\. Everything Turnout needs is in place\.$/);
  });
});

test('the pinned version is the image tag compose.flagsmith.yml uses', () => {
  const compose = readFileSync(new URL('../compose.flagsmith.yml', import.meta.url), 'utf8');
  const tags = new Set([...compose.matchAll(/flagsmith\/flagsmith:([\w.]+)/g)].map((m) => m[1]));
  assert.deepEqual([...tags], [PINNED_FLAGSMITH_VERSION]);
});

describe('GET /api/doctor and /setup on the console', () => {
  const report = { at: '2026-11-17T00:00:00Z', checks: [{ area: 'Flagsmith', name: 'API', expected: 'answers', actual: 'answers', status: 'ok' }], summary: { ok: 1, warn: 0, fail: 0 } };
  let fake: { apiUrl: string; close: () => void };
  let withDoctor: http.Server;
  let without: http.Server;
  let base = '';
  let baseWithout = '';
  let calls = 0;

  before(async () => {
    fake = await startFakeFlagsmith(initialState());
    const ui = mkdtempSync(join(tmpdir(), 'sy-ui-'));
    writeFileSync(join(ui, 'index.html'), '<head><meta name="turnout-console" content=""></head>console');
    writeFileSync(join(ui, 'setup.html'), '<head><meta name="turnout-console" content=""></head>setup');
    const common = {
      experiments: new Experiments(new AdminClient(fake.apiUrl, { apiKey: 'k' }), { envKey: ENV, experimentId: 7 }),
      feedUrl: 'http://127.0.0.1:9',
      snapshotDir: mkdtempSync(join(tmpdir(), 'sy-snap-')),
      ledgerDir: mkdtempSync(join(tmpdir(), 'sy-ledger-')),
      uiDir: ui,
    };
    withDoctor = createConsole({ ...common, doctor: async () => (calls++, report as never) });
    without = createConsole(common);
    base = await listen(withDoctor);
    baseWithout = await listen(without);
  });
  after(() => {
    withDoctor.close();
    without.close();
    fake.close();
  });

  const tokenFrom = async (url: string) => (await (await fetch(url)).text()).match(/name="turnout-console" content="([^"]+)"/)?.[1] ?? '';

  test('/setup serves setup.html with the API token', async () => {
    const res = await fetch(`${base}/setup`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.ok((await tokenFrom(`${base}/setup`)).length > 20);
  });

  test('answers the report with the token, and refuses without it', async () => {
    const token = await tokenFrom(`${base}/setup`);
    const res = await fetch(`${base}/api/doctor`, { headers: { 'x-turnout-console': token } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), report);
    const before = calls;
    assert.equal((await fetch(`${base}/api/doctor`)).status, 403);
    assert.equal(calls, before, 'the checks never run without the token');
  });

  test('404 when the console was started without the doctor', async () => {
    const token = await tokenFrom(`${baseWithout}/`);
    assert.equal((await fetch(`${baseWithout}/api/doctor`, { headers: { 'x-turnout-console': token } })).status, 404);
  });
});
