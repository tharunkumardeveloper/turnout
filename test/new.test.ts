import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseEnv } from 'node:util';
import YAML from 'yaml';
import { loadConfig } from '../src/config.ts';
import { bundledFlagsmith, DEFAULT_IMAGE, eventFromPath, parseReleases, parseSuccess, renderCompose, writeNew, type NewAnswers } from '../src/commands/new.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'turnout-new-'));
const flagsmithCompose = readFileSync('compose.flagsmith.yml', 'utf8');
const quiet = () => {};
const base: NewAnswers = { flagsmith: 'bundled', releases: ['landing:1', 'landing:2'], success: 'POST /signup 2xx', traffic: 50 };

test('releases: label=url, a bare url, or an image (a service on the app port); localhost becomes the host machine', () => {
  const { releases, notes } = parseReleases(['old=http://localhost:3000', 'https://new.internal:8443/', 'ghcr.io/acme/web:2.0'], 3000);
  assert.deepEqual(releases, [
    { label: 'old', url: 'http://host.docker.internal:3000' },
    { label: 'v2', url: 'https://new.internal:8443' },
    { label: 'web:2.0', url: 'http://web-2-0:3000', image: 'ghcr.io/acme/web:2.0', service: 'web-2-0' },
  ]);
  assert.equal(notes.length, 1);
  assert.throws(() => parseReleases(['http://a:1']), /at least two/);
  assert.throws(() => parseReleases(['x=http://a:1', 'x=http://b:1']), /used twice/);
  assert.throws(() => parseReleases(['ftp://a', 'http://b']), /neither/);
});

test('success: "METHOD /path status", status defaulting to 2xx (2xx or 303 for a write); the event is named after the path', () => {
  assert.deepEqual(parseSuccess('post /signup'), { method: 'POST', path: '/signup', status: '2xx,303' }, 'a form post that redirects (303) counts too');
  assert.deepEqual(parseSuccess('GET /welcome'), { method: 'GET', path: '/welcome', status: '2xx' });
  assert.deepEqual(parseSuccess('POST /signup 201'), { method: 'POST', path: '/signup', status: '201' });
  assert.deepEqual(parseSuccess('POST /signup 2XX,302'), { method: 'POST', path: '/signup', status: '2xx,302' });
  assert.deepEqual(parseSuccess('PUT /api/orders/* 201'), { method: 'PUT', path: '/api/orders/*', status: '201' });
  assert.throws(() => parseSuccess('signup'), /POST \/signup 2xx/);
  assert.equal(eventFromPath('/signup'), 'signup');
  assert.equal(eventFromPath('/api/orders/*'), 'orders');
  assert.equal(eventFromPath('/'), 'goal');
  assert.equal(eventFromPath('/server_error'), 'goal', 'never a guardrail name');
});

test('bundled Flagsmith: a loadable config, a compose file with the proxy, console, CLI and image releases, and Flagsmith', () => {
  const dir = tmp();
  const written = writeNew({ answers: base, dir, flagsmithCompose, log: quiet });
  assert.deepEqual(written, ['turnout.config.yml', 'turnout.compose.yml', 'flagsmith.compose.yml', '.env']);

  const config = loadConfig(join(dir, 'turnout.config.yml'));
  assert.equal(config.flag, 'landing_release');
  assert.deepEqual([...config.releases].map(([l, u]) => [l, u.href]), [['landing:1', 'http://landing-1:8080/'], ['landing:2', 'http://landing-2:8080/']]);
  assert.deepEqual(config.goal, { event: 'signup', when: { method: 'POST', path: '/signup', status: '2xx' }, header: false });
  // A status list survives the YAML round trip: unquoted, "2xx,303" in a flow mapping is two entries ("303" a key).
  const listedDir = tmp();
  writeNew({ answers: { ...base, success: 'POST /signup' }, dir: listedDir, flagsmithCompose, log: quiet });
  assert.equal(loadConfig(join(listedDir, 'turnout.config.yml')).goal.when?.status, '2xx,303');
  assert.equal(config.traffic, 50);

  const compose = YAML.parse(readFileSync(join(dir, 'turnout.compose.yml'), 'utf8'), { merge: true });
  assert.deepEqual(compose.include, ['flagsmith.compose.yml']);
  assert.deepEqual(Object.keys(compose.services).sort(), ['cli', 'console', 'console-sim', 'landing-1', 'landing-2', 'turnout', 'turnout-sim']);
  for (const name of ['turnout', 'console', 'cli']) {
    const s = compose.services[name];
    assert.equal(s.image, DEFAULT_IMAGE, name);
    assert.ok(s.volumes.includes('./turnout.config.yml:/app/turnout.config.yml:ro'), name);
    assert.equal(s.environment.FLAGSMITH_API_URL, 'http://flagsmith:8000/api/v1/', name);
    assert.deepEqual(s.extra_hosts, ['host.docker.internal:host-gateway'], name);
  }
  assert.equal(compose.services.landing_1, undefined);
  assert.equal(compose.services['landing-2'].image, 'landing:2');
  assert.deepEqual(compose.services.cli.profiles, ['tools']);
  assert.ok(compose.services.cli.volumes.includes('./.env:/app/.env'));
  assert.equal(compose.services.turnout.depends_on.flagsmith.condition, 'service_healthy');
  assert.deepEqual(compose.services.console.ports, ['127.0.0.1:8090:8090']);
  // Another Turnout next to it: both host ports move.
  const other = YAML.parse(renderCompose({ ...base, proxyPort: 18080, consolePort: 18090 }, parseReleases(base.releases).releases), { merge: true });
  assert.deepEqual(other.services.turnout.ports, ['127.0.0.1:18080:8080']);
  assert.deepEqual(other.services.console.ports, ['127.0.0.1:18090:8090']);
  assert.equal(other.services.cli.environment.TURNOUT_PUBLIC_CONSOLE_PORT, '18090');
  assert.equal(other.services.cli.environment.TURNOUT_PUBLIC_SHOP_URL, 'http://127.0.0.1:18080');
  assert.equal(readFileSync(join(dir, 'flagsmith.compose.yml'), 'utf8'), bundledFlagsmith(flagsmithCompose, 8000));
  assert.ok(existsSync(join(dir, '.env')) && existsSync(join(dir, '.turnout')));
});

test('your own Flagsmith: its URL in compose, no bundled Flagsmith, and the project, environment and key in .env', () => {
  const dir = tmp();
  writeFileSync(join(dir, '.env'), 'OTHER=kept\n');
  const written = writeNew({
    answers: { ...base, flagsmith: 'https://flags.example.com/api/v1/', releases: ['http://host.docker.internal:3000', 'http://host.docker.internal:3001'], project: 'Web', environment: 'Production', flag: 'web_release', image: 'turnout:local' },
    dir,
    adminKey: 'org.secret',
    log: quiet,
  });
  assert.ok(!written.includes('flagsmith.compose.yml'));
  const compose = YAML.parse(readFileSync(join(dir, 'turnout.compose.yml'), 'utf8'), { merge: true });
  assert.equal(compose.include, undefined);
  assert.equal(compose.services.turnout.environment.FLAGSMITH_API_URL, 'https://flags.example.com/api/v1/');
  assert.equal(compose.services.turnout.image, 'turnout:local');
  assert.equal(compose.services.turnout.depends_on, undefined);
  assert.deepEqual(Object.keys(compose.services).sort(), ['cli', 'console', 'console-sim', 'turnout', 'turnout-sim']);
  assert.doesNotMatch(readFileSync(join(dir, 'turnout.compose.yml'), 'utf8'), /org\.secret/, 'the key stays out of the compose file');
  assert.deepEqual({ ...parseEnv(readFileSync(join(dir, '.env'), 'utf8')) }, { OTHER: 'kept', TURNOUT_PROJECT: 'Web', TURNOUT_ENVIRONMENT: 'Production', TURNOUT_ADMIN_KEY: 'org.secret' });
  assert.equal(loadConfig(join(dir, 'turnout.config.yml')).flag, 'web_release');
});

test('new refuses to overwrite without --force, and checks traffic and the Flagsmith answer', () => {
  const dir = tmp();
  writeNew({ answers: base, dir, flagsmithCompose, log: quiet });
  assert.throws(() => writeNew({ answers: base, dir, flagsmithCompose, log: quiet }), /--force/);
  writeNew({ answers: { ...base, traffic: 10 }, dir, flagsmithCompose, force: true, log: quiet });
  assert.equal(loadConfig(join(dir, 'turnout.config.yml')).traffic, 10);
  assert.throws(() => writeNew({ answers: { ...base, traffic: 0 }, dir: tmp(), flagsmithCompose, log: quiet }), /traffic/);
  assert.throws(() => writeNew({ answers: { ...base, flagsmith: 'yes' }, dir: tmp(), log: quiet }), /bundled/);
});

test('the CLI runs new without questions from flags', () => {
  const dir = tmp();
  const out = execFileSync(
    process.execPath,
    ['src/cli.ts', 'new', '--yes', '--dir', dir, '--release', 'a=http://localhost:3000', '--release', 'b=http://localhost:3001', '--success', 'POST /join 201', '--traffic', '25', '--flag', 'site_release'],
    { encoding: 'utf8', env: { ...process.env, TURNOUT_ENV_FILE: join(dir, 'none.env') } },
  );
  assert.match(out, /wrote turnout\.config\.yml/);
  const config = loadConfig(join(dir, 'turnout.config.yml'));
  assert.deepEqual([config.flag, config.goal.event, config.goal.when!.status, config.traffic], ['site_release', 'join', '201', 25]);
  assert.equal(config.releases.get('a')!.hostname, 'host.docker.internal');
});

test('success can come from a response header: "header <event>"', () => {
  const dir = tmp();
  execFileSync(
    process.execPath,
    ['src/cli.ts', 'new', '--yes', '--dir', dir, '--release', 'a=http://localhost:3000', '--release', 'b=http://localhost:3001', '--success', 'header signed_up'],
    { encoding: 'utf8', env: { ...process.env, TURNOUT_ENV_FILE: join(dir, 'none.env') } },
  );
  const config = loadConfig(join(dir, 'turnout.config.yml'));
  assert.deepEqual([config.goal.event, config.goal.header, config.goal.when], ['signed_up', true, undefined]);
  assert.match(readFileSync(join(dir, 'turnout.config.yml'), 'utf8'), /X-Turnout-Event: signed_up/);
});

test('success "none": a config with no goal, judged on page speed', async () => {
  const { renderConfig, parseReleases } = await import('../src/commands/new.ts');
  const { parseConfig } = await import('../src/config.ts');
  const { parse } = await import('yaml');
  const { releases } = parseReleases(['http://localhost:3001', 'http://localhost:3002']);
  const text = renderConfig({ flagsmith: 'bundled', releases: [], success: 'none', traffic: 50 }, releases);
  const c = parseConfig(parse(text));
  assert.equal(c.goal.speedOnly, true);
  assert.deepEqual(c.guardrails, ['server_error']);
  assert.equal(c.traffic, 50);
  assert.match(text, /No goal yet/);
});

test('the bundled Flagsmith gets no fixed container name and the port given, so two projects can run side by side', async () => {
  const { bundledFlagsmith } = await import('../src/commands/new.ts');
  const { readFileSync } = await import('node:fs');
  const out = bundledFlagsmith(readFileSync(new URL('../compose.flagsmith.yml', import.meta.url), 'utf8'), 8001);
  assert.doesNotMatch(out, /container_name:/);
  assert.match(out, /127\.0\.0\.1:8001:8000/);
  assert.doesNotMatch(out, /:8000:8000/);
});

test("--app-env-file gives each release image your app's .env", async () => {
  const { renderCompose, parseReleases } = await import('../src/commands/new.ts');
  const { parse } = await import('yaml');
  const { releases } = parseReleases(['main=shop-main:abc', 'new=shop-new:def'], 3000);
  const compose = parse(renderCompose({ flagsmith: 'bundled', releases: [], success: 'none', traffic: 100, appEnvFile: 'C:\Users\me\app\.env' }, releases));
  assert.deepEqual(compose.services['shop-main-abc'].env_file, ['C:\Users\me\app\.env']);
  assert.equal(compose.services['shop-main-abc'].image, 'shop-main:abc');
  assert.deepEqual(compose.services['shop-new-def'].env_file, ['C:\Users\me\app\.env']);
});

test('the bundled Flagsmith file is rewritten the same with Windows line endings (a core.autocrlf checkout)', async () => {
  const { bundledFlagsmith } = await import('../src/commands/new.ts');
  const { readFileSync } = await import('node:fs');
  const lf = readFileSync(new URL('../compose.flagsmith.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const out = bundledFlagsmith(lf.replace(/\n/g, '\r\n'), 8001);
  assert.doesNotMatch(out, /container_name:/);
  assert.match(out, /127\.0\.0\.1:8001:8000/);
});

test('turnout simulate services: only with the sim profile, on their own env file and state, console on 127.0.0.1', async () => {
  const { renderCompose, parseReleases } = await import('../src/commands/new.ts');
  const { parse } = await import('yaml');
  const { releases } = parseReleases(['http://localhost:3001', 'http://localhost:3002']);
  const c = parse(renderCompose({ flagsmith: 'bundled', releases: [], success: 'none', traffic: 100 }, releases));
  for (const name of ['turnout-sim', 'console-sim']) {
    assert.deepEqual(c.services[name].profiles, ['sim']);
    assert.deepEqual(c.services[name].env_file, [{ path: './.turnout/sim.env', required: false }]);
  }
  assert.equal(c.services['turnout-sim'].ports, undefined, 'the simulation proxy is never published');
  assert.deepEqual(c.services['console-sim'].ports, ['127.0.0.1:${TURNOUT_SIM_CONSOLE_PORT:-8099}:8090']);
  assert.equal(c.services['console-sim'].environment.TURNOUT_SIMULATED, '1');
  assert.ok(c.services['console-sim'].volumes.includes('./.turnout/sim:/app/.turnout'), 'its own snapshots and ledger');
});
