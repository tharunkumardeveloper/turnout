import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { parseEnv } from 'node:util';
import { assertWritableEnvFile, init, judgeLinks, localHost, RELEASE_TAG, writeEnv } from '../src/commands/init.ts';
import { parseConfig } from '../src/config.ts';
import { calls, emptyState, startFakeAdmin, type FakeAdminState } from './fake-admin.ts';

const config = parseConfig({
  flag: 'shop_release',
  releases: { 'shop:1.4': 'http://shop-1-4:8080', 'shop:1.5': 'http://shop-1-5:8080', 'shop:1.6': 'http://shop-1-6:8080' },
  goal: { event: 'order_placed', when: { method: 'POST', path: '/checkout', status: '2xx' } },
  guardrails: ['doc_latency_ms', 'server_error'],
});

let dir: string;
let envFile: string;
let fake: { apiUrl: string; close: () => Promise<void> } | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'switchyard-init-'));
  envFile = join(dir, '.env');
  delete process.env.SWITCHYARD_PREVIEW_TOKEN; // init only mints a token when none is set
});
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function run(state: FakeAdminState, keys: { adminKey?: string; serverKey?: string } = {}): Promise<string[]> {
  fake ??= await startFakeAdmin(state);
  const lines: string[] = [];
  await init({
    apiUrl: fake.apiUrl,
    dashboardUrl: 'http://localhost:8000',
    config,
    adminKey: keys.adminKey,
    serverKey: keys.serverKey,
    envFile,
    log: (l) => lines.push(l),
  });
  return lines;
}
const readEnv = () => parseEnv(readFileSync(envFile, 'utf8'));

test('a fresh instance is bootstrapped end to end and every key lands in .env', async () => {
  const state = emptyState();
  await run(state);

  // The first admin, as a superuser.
  assert.equal(state.users.length, 1);
  assert.equal(state.users[0]!.superuser, true);
  const signup = calls(state, 'POST', /^\/api\/v1\/auth\/users\/$/)[0]!;
  assert.equal((signup.body as { re_password: string }).re_password, state.users[0]!.password);

  // Organisation, project, environment, keys, event store.
  assert.deepEqual(state.organisations.map((o) => o.name), ['Switchyard']);
  assert.deepEqual(state.projects.map((p) => p.name), ['Switchyard demo']);
  assert.deepEqual(state.environments.map((e) => e.name), ['Production']);
  const env = state.environments[0]!;
  assert.equal(state.adminKeys.length, 1);
  assert.equal(state.serverKeys.length, 1);
  assert.equal(state.serverKeys[0]!.envKey, env.api_key);
  assert.equal(state.warehouses.length, 1);
  assert.deepEqual(state.warehouses[0]!.config, { source: 'flagsmith_database' });

  // The flag, tagged with a permanent "release" tag, with v2 → the second release.
  assert.equal(state.features.length, 1);
  const feature = state.features[0]!;
  assert.equal(feature.name, 'shop_release');
  assert.equal(feature.initial_value, 'shop:1.4');
  assert.equal(feature.default_enabled, true);
  assert.equal(state.tags.length, 1);
  assert.equal(state.tags[0]!.label, RELEASE_TAG);
  assert.equal(state.tags[0]!.is_permanent, true);
  assert.deepEqual(feature.tags, [state.tags[0]!.id]);
  assert.deepEqual(
    feature.multivariate_options.map((o) => [o.key, o.string_value, o.default_percentage_allocation]),
    [['v2', 'shop:1.5', 0]],
  );

  // Goal metric (occurrence, up) and guardrails (mean, down).
  assert.deepEqual(
    state.metrics.map((m) => [m.name, m.aggregation, m.direction, m.definition.event]),
    [
      ['order_placed', 'occurrence', 'up', 'order_placed'],
      ['doc_latency_ms', 'mean', 'down', 'doc_latency_ms'],
      ['server_error', 'mean', 'down', 'server_error'],
    ],
  );

  // The experiment, started: control is the first release, v2 gets half.
  assert.equal(state.experiments.length, 1);
  const experiment = state.experiments[0]!;
  assert.equal(experiment.status, 'running');
  assert.equal(experiment.name, 'shop_release: shop:1.5 vs shop:1.4');
  assert.deepEqual(
    experiment.metrics.map((m) => [m.metric_name, m.expected_direction]),
    [
      ['order_placed', 'increase'],
      ['doc_latency_ms', 'not_increase'],
      ['server_error', 'not_increase'],
    ],
  );
  assert.equal(experiment.experiment_rollout!.feature_state_value.value, 'shop:1.4');
  assert.deepEqual(experiment.experiment_rollout!.multivariate_feature_state_values, [
    { multivariate_feature_option: feature.multivariate_options[0]!.id, percentage_allocation: 50 },
  ]);

  // After signup, everything is authenticated with the new admin's token.
  const token = state.tokens[0]!;
  const afterSignup = state.requests.slice(state.requests.indexOf(signup) + 1);
  assert.ok(afterSignup.length > 0 && afterSignup.every((r) => r.authorization === `Token ${token}`));
  assert.equal(calls(state, 'PATCH', /mv-options/).length, 0);

  const saved = readEnv();
  assert.equal(saved.FLAGSMITH_ADMIN_EMAIL, state.users[0]!.email);
  assert.equal(saved.FLAGSMITH_ADMIN_PASSWORD, state.users[0]!.password);
  assert.equal(saved.SWITCHYARD_ADMIN_KEY, state.adminKeys[0]);
  assert.equal(saved.SWITCHYARD_SERVER_KEY, state.serverKeys[0]!.key);
  assert.equal(saved.SWITCHYARD_EXPERIMENT, `${env.api_key}/${experiment.id}`);
  assert.match(saved.SWITCHYARD_PREVIEW_TOKEN ?? '', /^[A-Za-z0-9_-]{24}$/);
});

test('the admin login is saved the moment it exists, so a later failure does not lose it', async () => {
  const state = emptyState();
  state.failWhen = (method, path) => method === 'POST' && path.endsWith('/warehouse-connections/');
  await assert.rejects(run(state), /warehouse-connections\/ → 500/);

  const saved = readEnv();
  assert.equal(saved.FLAGSMITH_ADMIN_EMAIL, state.users[0]!.email);
  assert.equal(saved.FLAGSMITH_ADMIN_PASSWORD, state.users[0]!.password);
  assert.equal(saved.SWITCHYARD_ADMIN_KEY, state.adminKeys[0]);
  assert.equal(saved.SWITCHYARD_SERVER_KEY, state.serverKeys[0]!.key);
  assert.equal(saved.SWITCHYARD_EXPERIMENT, undefined);

  // The instance now has users; re-running with the saved keys finishes the job.
  await run(state, { adminKey: saved.SWITCHYARD_ADMIN_KEY!, serverKey: saved.SWITCHYARD_SERVER_KEY! });
  assert.equal(state.users.length, 1);
  assert.equal(state.serverKeys.length, 1);
  assert.equal(state.warehouses.length, 1);
  assert.equal(state.experiments[0]!.status, 'running');
  assert.equal(readEnv().SWITCHYARD_EXPERIMENT, `${state.environments[0]!.api_key}/${state.experiments[0]!.id}`);
});

test('the login is kept even when the very next call fails', async () => {
  const state = emptyState();
  state.failWhen = (method, path) => method === 'GET' && path === '/api/v1/organisations/';
  await assert.rejects(run(state), /→ 500/);
  const saved = readEnv();
  assert.equal(saved.FLAGSMITH_ADMIN_PASSWORD, state.users[0]!.password);
});

test('re-running init with the keys in place changes nothing', async () => {
  const state = emptyState();
  await run(state);
  const first = readEnv();
  const before = {
    users: state.users.length,
    adminKeys: state.adminKeys.length,
    features: state.features.length,
    tags: state.tags.length,
    metrics: state.metrics.length,
    experiments: state.experiments.length,
    warehouses: state.warehouses.length,
  };
  const requestsBefore = state.requests.length;
  process.env.SWITCHYARD_PREVIEW_TOKEN = first.SWITCHYARD_PREVIEW_TOKEN; // the CLI loads .env into the environment

  await run(state, { adminKey: first.SWITCHYARD_ADMIN_KEY!, serverKey: first.SWITCHYARD_SERVER_KEY! });

  assert.deepEqual(
    {
      users: state.users.length,
      adminKeys: state.adminKeys.length,
      features: state.features.length,
      tags: state.tags.length,
      metrics: state.metrics.length,
      experiments: state.experiments.length,
      warehouses: state.warehouses.length,
    },
    before,
  );
  assert.equal(state.serverKeys.length, 1, 'no new server-side key when one is passed');
  const rerun = state.requests.slice(requestsBefore);
  assert.deepEqual(
    rerun.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`),
    [],
    'a second run only reads',
  );
  assert.ok(rerun.every((r) => r.path === '/version/' || r.authorization === `Api-Key ${first.SWITCHYARD_ADMIN_KEY}`));
  assert.deepEqual(readEnv(), first);
});

test('re-running init after every experiment finished starts nothing new (release does that)', async () => {
  const state = emptyState();
  await run(state);
  const first = readEnv();
  for (const e of state.experiments) e.status = 'completed';
  const count = state.experiments.length;
  process.env.SWITCHYARD_PREVIEW_TOKEN = first.SWITCHYARD_PREVIEW_TOKEN;

  const lines = await run(state, { adminKey: first.SWITCHYARD_ADMIN_KEY!, serverKey: first.SWITCHYARD_SERVER_KEY! });

  assert.equal(state.experiments.length, count, 'no new experiment');
  assert.ok(lines.some((l) => /already ran/.test(l) && /switchyard release/.test(l)));
});

test('on a fresh (e.g. wiped) instance, stale keys from an earlier instance are replaced', async () => {
  // .env still holds keys from an instance that was removed with `docker compose down -v`.
  writeFileSync(envFile, 'SWITCHYARD_ADMIN_KEY=org.stale\nSWITCHYARD_SERVER_KEY=ser.stale\n');
  const state = emptyState();
  await run(state, { adminKey: 'org.stale', serverKey: 'ser.stale' });
  const saved = readEnv();
  assert.ok(state.adminKeys.includes(saved.SWITCHYARD_ADMIN_KEY!), 'the admin key in .env works on this instance');
  assert.ok(state.serverKeys.some((k) => k.key === saved.SWITCHYARD_SERVER_KEY), 'the server key in .env belongs to this instance');
});

test('an instance that already has users needs an Organisation API key', async () => {
  const state = emptyState({ hasUsers: true });
  await assert.rejects(run(state), /already has users.*SWITCHYARD_ADMIN_KEY/);
  assert.deepEqual(state.requests.map((r) => r.path), ['/version/']);
  assert.equal(existsSync(envFile), false);
});

test('an existing instance is set up with the given Organisation API key, without minting another', async () => {
  const state = emptyState({ hasUsers: true, adminKeys: ['org.given'] });
  await run(state, { adminKey: 'org.given' });
  assert.equal(state.users.length, 0);
  assert.deepEqual(state.adminKeys, ['org.given']);
  assert.equal(calls(state, 'POST', /master-api-keys/).length, 0);
  const saved = readEnv();
  assert.equal(saved.SWITCHYARD_ADMIN_KEY, undefined);
  assert.equal(saved.FLAGSMITH_ADMIN_PASSWORD, undefined);
  assert.equal(saved.SWITCHYARD_SERVER_KEY, state.serverKeys[0]!.key);
  assert.equal(state.experiments[0]!.status, 'running');
});

test('a config with a single release cannot start an experiment', async () => {
  const state = emptyState({ hasUsers: true, adminKeys: ['org.given'] });
  fake = await startFakeAdmin(state);
  const one = parseConfig({ flag: 'shop_release', releases: { 'shop:1.4': 'http://a:1' }, goal: { event: 'order_placed', when: { method: 'POST', path: '/checkout' } } });
  await assert.rejects(
    init({ apiUrl: fake.apiUrl, dashboardUrl: 'http://x', config: one, adminKey: 'org.given', envFile, log: () => {} }),
    /at least two releases/,
  );
  assert.equal(state.features.length, 0);
});

test('.env being a directory fails before anything is sent to Flagsmith', async () => {
  mkdirSync(envFile);
  const state = emptyState();
  await assert.rejects(run(state), /is a directory \(Docker creates one when the file is missing\)/);
  assert.equal(state.requests.length, 0);
  assert.throws(() => assertWritableEnvFile(envFile), /is a directory/);
  assert.throws(() => writeEnv(envFile, { A: '1' }), /is a directory/);
  assert.doesNotThrow(() => assertWritableEnvFile(join(dir, 'missing.env')));
});

test('writeEnv replaces existing keys in place and appends new ones', () => {
  writeFileSync(envFile, '# comment\nFLAGSMITH_API_URL=http://flagsmith:8000/api/v1/\nSWITCHYARD_SERVER_KEY=\nGITHUB_TOKEN=\n');
  writeEnv(envFile, { SWITCHYARD_SERVER_KEY: 'ser.abc', SWITCHYARD_EXPERIMENT: 'envKey1/7' });
  assert.equal(
    readFileSync(envFile, 'utf8'),
    '# comment\nFLAGSMITH_API_URL=http://flagsmith:8000/api/v1/\nSWITCHYARD_SERVER_KEY=ser.abc\nGITHUB_TOKEN=\nSWITCHYARD_EXPERIMENT=envKey1/7\n',
  );
  writeEnv(envFile, { SWITCHYARD_EXPERIMENT: 'envKey1/8' });
  assert.match(readFileSync(envFile, 'utf8'), /\nSWITCHYARD_EXPERIMENT=envKey1\/8\n$/);
  assert.equal(readFileSync(envFile, 'utf8').match(/SWITCHYARD_EXPERIMENT=/g)!.length, 1);
});

test('writeEnv only matches whole key names at the start of a line', () => {
  writeFileSync(envFile, 'SWITCHYARD_ADMIN_KEY_OLD=1\n# SWITCHYARD_ADMIN_KEY=commented\nSWITCHYARD_ADMIN_KEY=2');
  writeEnv(envFile, { SWITCHYARD_ADMIN_KEY: '3' });
  assert.equal(readFileSync(envFile, 'utf8'), 'SWITCHYARD_ADMIN_KEY_OLD=1\n# SWITCHYARD_ADMIN_KEY=commented\nSWITCHYARD_ADMIN_KEY=3');
});

test('writeEnv creates a missing file and adds a newline to one without', () => {
  writeEnv(envFile, { A: '1' });
  assert.equal(readFileSync(envFile, 'utf8'), 'A=1\n');
  writeFileSync(envFile, 'A=1');
  writeEnv(envFile, { B: '2' });
  assert.equal(readFileSync(envFile, 'utf8'), 'A=1\nB=2\n');
});

test('writeEnv keeps CRLF line endings of the lines it does not touch', () => {
  writeFileSync(envFile, 'A=1\r\nB=2\r\n');
  writeEnv(envFile, { A: 'x' });
  assert.equal(readFileSync(envFile, 'utf8'), 'A=x\r\nB=2\r\n');
});

test('writeEnv refuses newlines in values and unsafe names, leaving the file alone', () => {
  writeFileSync(envFile, 'A=1\n');
  assert.throws(() => writeEnv(envFile, { B: 'x\nINJECTED=1' }), /Refusing to write B/);
  assert.throws(() => writeEnv(envFile, { B: 'x\ry' }), /Refusing to write B/);
  assert.throws(() => writeEnv(envFile, { 'B=1\nC': 'x' }), /Refusing/);
  assert.throws(() => writeEnv(envFile, { 'lower': 'x' }), /Refusing/);
  assert.throws(() => writeEnv(envFile, { 'A.B': 'x' }), /Refusing/);
  assert.equal(readFileSync(envFile, 'utf8'), 'A=1\n');
});

// ---------- the judge links init prints ----------

test('judge links: 127.0.0.1 on this machine; other devices need SWITCHYARD_CONSOLE_HOSTS', () => {
  const lines = judgeLinks('tok', {});
  assert.equal(lines[0], 'Judge mode: http://127.0.0.1:8090/judge');
  assert.match(lines[1]!, /set SWITCHYARD_CONSOLE_HOSTS and SWITCHYARD_PUBLISH_HOST=0\.0\.0\.0/);
  assert.ok(!lines.join('\n').includes('tok'), 'no key link that only this machine could open');
  // An older .env keeps the shop on localhost: the console link follows it, so the Shop tab stays same-site.
  assert.equal(judgeLinks('tok', { SWITCHYARD_PUBLIC_SHOP_URL: 'http://localhost:8080' })[0], 'Judge mode: http://localhost:8090/judge');
  assert.equal(judgeLinks('tok', { SWITCHYARD_PUBLIC_SHOP_URL: 'not a url' })[0], 'Judge mode: http://127.0.0.1:8090/judge');
});

test("localHost: 127.0.0.1 unless the shop URL uses another loopback name (the CLI's console and watcher links use it)", () => {
  assert.equal(localHost({}), '127.0.0.1');
  assert.equal(localHost({ SWITCHYARD_PUBLIC_SHOP_URL: 'http://localhost:8080' }), 'localhost');
  assert.equal(localHost({ SWITCHYARD_PUBLIC_SHOP_URL: 'http://192.168.1.20:8080' }), '127.0.0.1');
  assert.equal(localHost({ SWITCHYARD_PUBLIC_SHOP_URL: 'nonsense' }), '127.0.0.1');
});

test('judge links: with console hosts, the link for other devices uses the first host (or the shop URL\'s)', () => {
  const ready = judgeLinks('tok', {
    SWITCHYARD_CONSOLE_HOSTS: ' 192.168.1.20 , demo.local',
    SWITCHYARD_PUBLISH_HOST: '0.0.0.0',
    SWITCHYARD_PUBLIC_SHOP_URL: 'http://192.168.1.20:8080',
  });
  assert.deepEqual(ready, [
    'Judge mode: http://127.0.0.1:8090/judge',
    'Judge link for other devices: http://192.168.1.20:8091/judge?key=tok',
    '  On this machine too, open that link: the Shop tab needs the console and the shop on the same hostname.',
  ]);
  const byShop = judgeLinks('tok', { SWITCHYARD_CONSOLE_HOSTS: '192.168.1.20,demo.local', SWITCHYARD_PUBLISH_HOST: '0.0.0.0', SWITCHYARD_PUBLIC_SHOP_URL: 'http://demo.local:8080' });
  assert.equal(byShop[1], 'Judge link for other devices: http://demo.local:8091/judge?key=tok');

  // Hosts set, but published on loopback and the shop URL still local: say what else is needed.
  const half = judgeLinks('tok', { SWITCHYARD_CONSOLE_HOSTS: '192.168.1.20' });
  assert.equal(half[1], 'Judge link for other devices: http://192.168.1.20:8091/judge?key=tok');
  assert.match(half[2]!, /SWITCHYARD_PUBLISH_HOST=0\.0\.0\.0/);
  assert.match(half[3]!, /SWITCHYARD_PUBLIC_SHOP_URL=http:\/\/192\.168\.1\.20:8080/);
});

test('init prints the judge links from the settings it is given', async () => {
  fake = await startFakeAdmin(emptyState());
  const lines: string[] = [];
  await init({
    apiUrl: fake.apiUrl,
    dashboardUrl: 'http://127.0.0.1:8000',
    config,
    adminKey: undefined,
    envFile,
    log: (l) => lines.push(l),
    env: { SWITCHYARD_CONSOLE_HOSTS: '10.0.0.5', SWITCHYARD_PUBLISH_HOST: '0.0.0.0', SWITCHYARD_PUBLIC_SHOP_URL: 'http://10.0.0.5:8080' },
  });
  const token = readEnv().SWITCHYARD_JUDGE_TOKEN!;
  assert.ok(token);
  assert.ok(lines.includes('Judge mode: http://127.0.0.1:8090/judge'));
  assert.ok(lines.includes(`Judge link for other devices: http://10.0.0.5:8091/judge?key=${token}`));
  assert.ok(!lines.some((l) => l.includes('localhost:8090')));
});

test('writeEnv writes $ in values literally, both when replacing and when appending', () => {
  writeFileSync(envFile, 'PASS=old\n');
  writeEnv(envFile, { PASS: "p$&w$1$$x$'$`", OTHER: '$&$$' });
  assert.equal(readFileSync(envFile, 'utf8'), "PASS=p$&w$1$$x$'$`\nOTHER=$&$$\n");
});
