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
  dir = mkdtempSync(join(tmpdir(), 'turnover-init-'));
  envFile = join(dir, '.env');
  delete process.env.TURNOVER_PREVIEW_TOKEN; // init only mints a token when none is set
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
  assert.deepEqual(state.organisations.map((o) => o.name), ['Turnover']);
  assert.deepEqual(state.projects.map((p) => p.name), ['Turnover demo']);
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
  assert.equal(saved.TURNOVER_ADMIN_KEY, state.adminKeys[0]);
  assert.equal(saved.TURNOVER_SERVER_KEY, state.serverKeys[0]!.key);
  assert.equal(saved.TURNOVER_EXPERIMENT, `${env.api_key}/${experiment.id}`);
  assert.match(saved.TURNOVER_PREVIEW_TOKEN ?? '', /^[A-Za-z0-9_-]{24}$/);
});

test('the admin login is saved the moment it exists, so a later failure does not lose it', async () => {
  const state = emptyState();
  state.failWhen = (method, path) => method === 'POST' && path.endsWith('/warehouse-connections/');
  await assert.rejects(run(state), /warehouse-connections\/ → 500/);

  const saved = readEnv();
  assert.equal(saved.FLAGSMITH_ADMIN_EMAIL, state.users[0]!.email);
  assert.equal(saved.FLAGSMITH_ADMIN_PASSWORD, state.users[0]!.password);
  assert.equal(saved.TURNOVER_ADMIN_KEY, state.adminKeys[0]);
  assert.equal(saved.TURNOVER_SERVER_KEY, state.serverKeys[0]!.key);
  assert.equal(saved.TURNOVER_EXPERIMENT, undefined);

  // The instance now has users; re-running with the saved keys finishes the job.
  await run(state, { adminKey: saved.TURNOVER_ADMIN_KEY!, serverKey: saved.TURNOVER_SERVER_KEY! });
  assert.equal(state.users.length, 1);
  assert.equal(state.serverKeys.length, 1);
  assert.equal(state.warehouses.length, 1);
  assert.equal(state.experiments[0]!.status, 'running');
  assert.equal(readEnv().TURNOVER_EXPERIMENT, `${state.environments[0]!.api_key}/${state.experiments[0]!.id}`);
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
  process.env.TURNOVER_PREVIEW_TOKEN = first.TURNOVER_PREVIEW_TOKEN; // the CLI loads .env into the environment

  await run(state, { adminKey: first.TURNOVER_ADMIN_KEY!, serverKey: first.TURNOVER_SERVER_KEY! });

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
  assert.ok(rerun.every((r) => r.path === '/version/' || r.authorization === `Api-Key ${first.TURNOVER_ADMIN_KEY}`));
  assert.deepEqual(readEnv(), first);
});

test('re-running init after every experiment finished starts nothing new (release does that)', async () => {
  const state = emptyState();
  await run(state);
  const first = readEnv();
  for (const e of state.experiments) e.status = 'completed';
  const count = state.experiments.length;
  process.env.TURNOVER_PREVIEW_TOKEN = first.TURNOVER_PREVIEW_TOKEN;

  const lines = await run(state, { adminKey: first.TURNOVER_ADMIN_KEY!, serverKey: first.TURNOVER_SERVER_KEY! });

  assert.equal(state.experiments.length, count, 'no new experiment');
  assert.ok(lines.some((l) => /already ran/.test(l) && /turnover release/.test(l)));
});

test('on a fresh (e.g. wiped) instance, stale keys from an earlier instance are replaced', async () => {
  // .env still holds keys from an instance that was removed with `docker compose down -v`.
  writeFileSync(envFile, 'TURNOVER_ADMIN_KEY=org.stale\nTURNOVER_SERVER_KEY=ser.stale\n');
  const state = emptyState();
  await run(state, { adminKey: 'org.stale', serverKey: 'ser.stale' });
  const saved = readEnv();
  assert.ok(state.adminKeys.includes(saved.TURNOVER_ADMIN_KEY!), 'the admin key in .env works on this instance');
  assert.ok(state.serverKeys.some((k) => k.key === saved.TURNOVER_SERVER_KEY), 'the server key in .env belongs to this instance');
});

test('an instance that already has users needs an Organisation API key', async () => {
  const state = emptyState({ hasUsers: true });
  await assert.rejects(run(state), /already has users.*TURNOVER_ADMIN_KEY/);
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
  assert.equal(saved.TURNOVER_ADMIN_KEY, undefined);
  assert.equal(saved.FLAGSMITH_ADMIN_PASSWORD, undefined);
  assert.equal(saved.TURNOVER_SERVER_KEY, state.serverKeys[0]!.key);
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
  writeFileSync(envFile, '# comment\nFLAGSMITH_API_URL=http://flagsmith:8000/api/v1/\nTURNOVER_SERVER_KEY=\nGITHUB_TOKEN=\n');
  writeEnv(envFile, { TURNOVER_SERVER_KEY: 'ser.abc', TURNOVER_EXPERIMENT: 'envKey1/7' });
  assert.equal(
    readFileSync(envFile, 'utf8'),
    '# comment\nFLAGSMITH_API_URL=http://flagsmith:8000/api/v1/\nTURNOVER_SERVER_KEY=ser.abc\nGITHUB_TOKEN=\nTURNOVER_EXPERIMENT=envKey1/7\n',
  );
  writeEnv(envFile, { TURNOVER_EXPERIMENT: 'envKey1/8' });
  assert.match(readFileSync(envFile, 'utf8'), /\nTURNOVER_EXPERIMENT=envKey1\/8\n$/);
  assert.equal(readFileSync(envFile, 'utf8').match(/TURNOVER_EXPERIMENT=/g)!.length, 1);
});

test('writeEnv only matches whole key names at the start of a line', () => {
  writeFileSync(envFile, 'TURNOVER_ADMIN_KEY_OLD=1\n# TURNOVER_ADMIN_KEY=commented\nTURNOVER_ADMIN_KEY=2');
  writeEnv(envFile, { TURNOVER_ADMIN_KEY: '3' });
  assert.equal(readFileSync(envFile, 'utf8'), 'TURNOVER_ADMIN_KEY_OLD=1\n# TURNOVER_ADMIN_KEY=commented\nTURNOVER_ADMIN_KEY=3');
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

test('judge links: 127.0.0.1 on this machine; other devices need TURNOVER_CONSOLE_HOSTS', () => {
  const lines = judgeLinks('tok', {});
  assert.equal(lines[0], 'Judge mode: http://127.0.0.1:8090/judge');
  assert.match(lines[1]!, /set TURNOVER_CONSOLE_HOSTS and TURNOVER_PUBLISH_HOST=0\.0\.0\.0/);
  assert.ok(!lines.join('\n').includes('tok'), 'no key link that only this machine could open');
  // An older .env keeps the shop on localhost: the console link follows it, so the Shop tab stays same-site.
  assert.equal(judgeLinks('tok', { TURNOVER_PUBLIC_SHOP_URL: 'http://localhost:8080' })[0], 'Judge mode: http://localhost:8090/judge');
  assert.equal(judgeLinks('tok', { TURNOVER_PUBLIC_SHOP_URL: 'not a url' })[0], 'Judge mode: http://127.0.0.1:8090/judge');
});

test("localHost: 127.0.0.1 unless the shop URL uses another loopback name (the CLI's console and watcher links use it)", () => {
  assert.equal(localHost({}), '127.0.0.1');
  assert.equal(localHost({ TURNOVER_PUBLIC_SHOP_URL: 'http://localhost:8080' }), 'localhost');
  assert.equal(localHost({ TURNOVER_PUBLIC_SHOP_URL: 'http://192.168.1.20:8080' }), '127.0.0.1');
  assert.equal(localHost({ TURNOVER_PUBLIC_SHOP_URL: 'nonsense' }), '127.0.0.1');
});

test('judge links: with console hosts, the link for other devices uses the first host (or the shop URL\'s)', () => {
  const ready = judgeLinks('tok', {
    TURNOVER_CONSOLE_HOSTS: ' 192.168.1.20 , demo.local',
    TURNOVER_PUBLISH_HOST: '0.0.0.0',
    TURNOVER_PUBLIC_SHOP_URL: 'http://192.168.1.20:8080',
  });
  assert.deepEqual(ready, [
    'Judge mode: http://127.0.0.1:8090/judge',
    'Judge link for other devices: http://192.168.1.20:8091/judge?key=tok',
    '  On this machine too, open that link: the Shop tab needs the console and the shop on the same hostname.',
  ]);
  const byShop = judgeLinks('tok', { TURNOVER_CONSOLE_HOSTS: '192.168.1.20,demo.local', TURNOVER_PUBLISH_HOST: '0.0.0.0', TURNOVER_PUBLIC_SHOP_URL: 'http://demo.local:8080' });
  assert.equal(byShop[1], 'Judge link for other devices: http://demo.local:8091/judge?key=tok');

  // Hosts set, but published on loopback and the shop URL still local: say what else is needed.
  const half = judgeLinks('tok', { TURNOVER_CONSOLE_HOSTS: '192.168.1.20' });
  assert.equal(half[1], 'Judge link for other devices: http://192.168.1.20:8091/judge?key=tok');
  assert.match(half[2]!, /TURNOVER_PUBLISH_HOST=0\.0\.0\.0/);
  assert.match(half[3]!, /TURNOVER_PUBLIC_SHOP_URL=http:\/\/192\.168\.1\.20:8080/);
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
    env: { TURNOVER_CONSOLE_HOSTS: '10.0.0.5', TURNOVER_PUBLISH_HOST: '0.0.0.0', TURNOVER_PUBLIC_SHOP_URL: 'http://10.0.0.5:8080' },
  });
  const token = readEnv().TURNOVER_JUDGE_TOKEN!;
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

// Bring your own Flagsmith: an existing organisation with its own project, environments and flags.
function existingFlagsmith(): FakeAdminState {
  const state = emptyState({ hasUsers: true, adminKeys: ['org.given'] });
  state.organisations.push({ id: 900, name: 'Acme' });
  state.projects.push({ id: 901, name: 'Web', organisation: 900 }, { id: 902, name: 'Other', organisation: 900 });
  state.environments.push(
    { id: 903, name: 'Development', api_key: 'envDev', project: 901 },
    { id: 904, name: 'Production', api_key: 'envProd', project: 901 },
  );
  state.features.push({ id: 905, name: 'dark_mode', initial_value: null, default_enabled: false, multivariate_options: [], tags: [], project: 901 });
  return state;
}
const landing = parseConfig({
  flag: 'landing_release',
  releases: { 'landing:1': 'http://landing-1:8080', 'landing:2': 'http://landing-2:8080' },
  goal: { event: 'signup', when: { method: 'POST', path: '/signup' } },
  guardrails: ['doc_latency_ms', 'server_error'],
  traffic: 40,
});
async function runByo(state: FakeAdminState, project: string, environment?: string, serverKey?: string): Promise<string[]> {
  fake ??= await startFakeAdmin(state);
  const lines: string[] = [];
  await init({ apiUrl: fake.apiUrl, dashboardUrl: 'http://x', config: landing, adminKey: 'org.given', serverKey, envFile, project, environment, log: (l) => lines.push(l) });
  return lines;
}

test('--project reuses your project and environment: no organisation, project, environment, admin key or health provider created', async () => {
  const state = existingFlagsmith();
  await runByo(state, 'Web', 'Production');
  assert.equal(calls(state, 'POST', /^\/api\/v1\/(organisations|projects|environments)\/$/).length, 0);
  assert.equal(calls(state, 'POST', /master-api-keys|feature-health/).length, 0);
  assert.equal(state.organisations.length, 1);
  assert.equal(state.projects.length, 2);
  assert.equal(state.environments.length, 2);
  // Only Turnover's own things, in that environment.
  assert.deepEqual(state.features.map((f) => [f.name, f.project]), [['dark_mode', 901], ['landing_release', 901]]);
  assert.equal(state.serverKeys[0]!.envKey, 'envProd');
  assert.equal(state.experiments[0]!.envKey, 'envProd');
  assert.equal(state.experiments[0]!.experiment_rollout!.rollout_percentage, 40, 'traffic from the config');
  assert.equal(readEnv().TURNOVER_EXPERIMENT, `envProd/${state.experiments[0]!.id}`);
  // The other flag is never touched.
  assert.equal(state.requests.filter((r) => r.method !== 'GET' && r.path.includes('/features/905/')).length, 0);
});

test('--project takes ids and keys too, and picks the only environment or Production when none is named', async () => {
  const state = existingFlagsmith();
  await runByo(state, '901', 'envDev');
  assert.equal(state.experiments[0]!.envKey, 'envDev');
  await fake!.close();
  fake = undefined;
  const again = existingFlagsmith();
  await runByo(again, 'Web');
  assert.equal(again.experiments[0]!.envKey, 'envProd');
});

test('--project refuses a project or environment that does not exist, and a fresh instance, creating nothing', async () => {
  const state = existingFlagsmith();
  await assert.rejects(runByo(state, 'Nope'), /No Flagsmith project "Nope".*"Web" \(901\).*never creates/);
  await assert.rejects(runByo(state, 'Web', 'Staging'), /no environment "Staging".*"Development", "Production"/);
  assert.equal(calls(state, 'POST', /.*/).length, 0);
  await fake!.close();
  fake = undefined;
  const fresh = emptyState();
  await assert.rejects(runByo(fresh, 'Web'), /no users yet/);
  assert.equal(fresh.users.length, 0);
});

test('--project with several environments and none named or called Production asks for one', async () => {
  const state = existingFlagsmith();
  state.environments[1]!.name = 'Live';
  await assert.rejects(runByo(state, 'Web'), /several environments.*--environment/);
});

test('a flag that exists with values that are not releases is refused and left alone', async () => {
  const state = existingFlagsmith();
  state.features.push({
    id: 906,
    name: 'landing_release',
    initial_value: 'landing:1',
    default_enabled: true,
    multivariate_options: [{ id: 907, key: 'blue', string_value: 'blue-button', default_percentage_allocation: 0 }],
    tags: [],
    project: 901,
  });
  await assert.rejects(runByo(state, 'Web', 'Production'), /Flag "landing_release" already exists.*variant blue = "blue-button"/);
  assert.equal(state.requests.filter((r) => r.method !== 'GET' && /features|experiments|metrics/.test(r.path)).length, 0);
});

test('a flag that already routes these releases is reused', async () => {
  const state = existingFlagsmith();
  fake = await startFakeAdmin(state);
  const res = await fetch(new URL('/api/v1/projects/901/features/', fake.apiUrl), {
    method: 'POST',
    headers: { authorization: 'Api-Key org.given', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'landing_release', initial_value: 'landing:1', default_enabled: true }),
  });
  const { id } = (await res.json()) as { id: number };
  await runByo(state, 'Web', 'Production');
  assert.equal(state.features.filter((f) => f.name === 'landing_release').length, 1);
  assert.equal(state.experiments[0]!.feature.id, id);
});

test('--project mints a server key unless the one given reads that environment', async () => {
  const state = existingFlagsmith();
  state.serverKeys.push({ envKey: 'envDev', key: 'ser.dev', name: 'other' });
  await runByo(state, 'Web', 'Production', 'ser.dev');
  assert.equal(readEnv().TURNOVER_SERVER_KEY, state.serverKeys[1]!.key);
  assert.equal(state.serverKeys[1]!.envKey, 'envProd');
});

test('a secondary metric added to the config later is created and attached to the running experiment', async () => {
  const state = emptyState();
  await run(state);
  const first = readEnv();
  process.env.TURNOVER_PREVIEW_TOKEN = first.TURNOVER_PREVIEW_TOKEN;
  const withFunnel = parseConfig({
    flag: 'shop_release',
    releases: { 'shop:1.4': 'http://shop-1-4:8080', 'shop:1.5': 'http://shop-1-5:8080' },
    goal: { event: 'order_placed', when: { method: 'POST', path: '/checkout', status: '2xx' } },
    metrics: [{ event: 'add_to_cart', when: { method: 'POST', path: '/cart/add', status: '2xx,303' } }],
    guardrails: ['doc_latency_ms', 'server_error'],
  });
  const lines: string[] = [];
  await init({ apiUrl: fake!.apiUrl, dashboardUrl: 'http://x', config: withFunnel, adminKey: first.TURNOVER_ADMIN_KEY, serverKey: first.TURNOVER_SERVER_KEY, envFile, log: (l) => lines.push(l) });
  const metric = state.metrics.find((m) => m.name === 'add_to_cart')!;
  assert.deepEqual([metric.aggregation, metric.direction], ['occurrence', 'up']);
  const experiment = state.experiments[0]!;
  assert.equal(experiment.metrics[0]!.metric_name, 'order_placed', 'the goal stays primary');
  assert.deepEqual(experiment.metrics.find((m) => m.metric_name === 'add_to_cart')?.expected_direction, 'increase');
  assert.ok(lines.some((l) => /attached 1 new metric/.test(l)));
});
