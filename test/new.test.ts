import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseEnv } from 'node:util';
import YAML from 'yaml';
import { loadConfig } from '../src/config.ts';
import { DEFAULT_IMAGE, eventFromPath, parseReleases, parseSuccess, writeNew, type NewAnswers } from '../src/commands/new.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'turnover-new-'));
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

test('success: "METHOD /path status", status defaulting to 2xx; the event is named after the path', () => {
  assert.deepEqual(parseSuccess('post /signup'), { method: 'POST', path: '/signup', status: '2xx' });
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
  assert.deepEqual(written, ['turnover.config.yml', 'turnover.compose.yml', 'flagsmith.compose.yml', '.env']);

  const config = loadConfig(join(dir, 'turnover.config.yml'));
  assert.equal(config.flag, 'landing_release');
  assert.deepEqual([...config.releases].map(([l, u]) => [l, u.href]), [['landing:1', 'http://landing-1:8080/'], ['landing:2', 'http://landing-2:8080/']]);
  assert.deepEqual(config.goal, { event: 'signup', when: { method: 'POST', path: '/signup', status: '2xx' }, header: false });
  assert.equal(config.traffic, 50);

  const compose = YAML.parse(readFileSync(join(dir, 'turnover.compose.yml'), 'utf8'), { merge: true });
  assert.deepEqual(compose.include, ['flagsmith.compose.yml']);
  assert.deepEqual(Object.keys(compose.services).sort(), ['cli', 'console', 'landing-1', 'landing-2', 'turnover']);
  for (const name of ['turnover', 'console', 'cli']) {
    const s = compose.services[name];
    assert.equal(s.image, DEFAULT_IMAGE, name);
    assert.ok(s.volumes.includes('./turnover.config.yml:/app/turnover.config.yml:ro'), name);
    assert.equal(s.environment.FLAGSMITH_API_URL, 'http://flagsmith:8000/api/v1/', name);
    assert.deepEqual(s.extra_hosts, ['host.docker.internal:host-gateway'], name);
  }
  assert.equal(compose.services.landing_1, undefined);
  assert.equal(compose.services['landing-2'].image, 'landing:2');
  assert.deepEqual(compose.services.cli.profiles, ['tools']);
  assert.ok(compose.services.cli.volumes.includes('./.env:/app/.env'));
  assert.equal(compose.services.turnover.depends_on.flagsmith.condition, 'service_healthy');
  assert.deepEqual(compose.services.console.ports, ['127.0.0.1:8090:8090']);
  assert.equal(readFileSync(join(dir, 'flagsmith.compose.yml'), 'utf8'), flagsmithCompose);
  assert.ok(existsSync(join(dir, '.env')) && existsSync(join(dir, '.turnover')));
});

test('your own Flagsmith: its URL in compose, no bundled Flagsmith, and the project, environment and key in .env', () => {
  const dir = tmp();
  writeFileSync(join(dir, '.env'), 'OTHER=kept\n');
  const written = writeNew({
    answers: { ...base, flagsmith: 'https://flags.example.com/api/v1/', releases: ['http://host.docker.internal:3000', 'http://host.docker.internal:3001'], project: 'Web', environment: 'Production', flag: 'web_release', image: 'turnover:local' },
    dir,
    adminKey: 'org.secret',
    log: quiet,
  });
  assert.ok(!written.includes('flagsmith.compose.yml'));
  const compose = YAML.parse(readFileSync(join(dir, 'turnover.compose.yml'), 'utf8'), { merge: true });
  assert.equal(compose.include, undefined);
  assert.equal(compose.services.turnover.environment.FLAGSMITH_API_URL, 'https://flags.example.com/api/v1/');
  assert.equal(compose.services.turnover.image, 'turnover:local');
  assert.equal(compose.services.turnover.depends_on, undefined);
  assert.deepEqual(Object.keys(compose.services).sort(), ['cli', 'console', 'turnover']);
  assert.doesNotMatch(readFileSync(join(dir, 'turnover.compose.yml'), 'utf8'), /org\.secret/, 'the key stays out of the compose file');
  assert.deepEqual({ ...parseEnv(readFileSync(join(dir, '.env'), 'utf8')) }, { OTHER: 'kept', TURNOVER_PROJECT: 'Web', TURNOVER_ENVIRONMENT: 'Production', TURNOVER_ADMIN_KEY: 'org.secret' });
  assert.equal(loadConfig(join(dir, 'turnover.config.yml')).flag, 'web_release');
});

test('new refuses to overwrite without --force, and checks traffic and the Flagsmith answer', () => {
  const dir = tmp();
  writeNew({ answers: base, dir, flagsmithCompose, log: quiet });
  assert.throws(() => writeNew({ answers: base, dir, flagsmithCompose, log: quiet }), /--force/);
  writeNew({ answers: { ...base, traffic: 10 }, dir, flagsmithCompose, force: true, log: quiet });
  assert.equal(loadConfig(join(dir, 'turnover.config.yml')).traffic, 10);
  assert.throws(() => writeNew({ answers: { ...base, traffic: 0 }, dir: tmp(), flagsmithCompose, log: quiet }), /traffic/);
  assert.throws(() => writeNew({ answers: { ...base, flagsmith: 'yes' }, dir: tmp(), log: quiet }), /bundled/);
});

test('the CLI runs new without questions from flags', () => {
  const dir = tmp();
  const out = execFileSync(
    process.execPath,
    ['src/cli.ts', 'new', '--yes', '--dir', dir, '--release', 'a=http://localhost:3000', '--release', 'b=http://localhost:3001', '--success', 'POST /join 201', '--traffic', '25', '--flag', 'site_release'],
    { encoding: 'utf8', env: { ...process.env, TURNOVER_ENV_FILE: join(dir, 'none.env') } },
  );
  assert.match(out, /wrote turnover\.config\.yml/);
  const config = loadConfig(join(dir, 'turnover.config.yml'));
  assert.deepEqual([config.flag, config.goal.event, config.goal.when!.status, config.traffic], ['site_release', 'join', '201', 25]);
  assert.equal(config.releases.get('a')!.hostname, 'host.docker.internal');
});

test('success can come from a response header: "header <event>"', () => {
  const dir = tmp();
  execFileSync(
    process.execPath,
    ['src/cli.ts', 'new', '--yes', '--dir', dir, '--release', 'a=http://localhost:3000', '--release', 'b=http://localhost:3001', '--success', 'header signed_up'],
    { encoding: 'utf8', env: { ...process.env, TURNOVER_ENV_FILE: join(dir, 'none.env') } },
  );
  const config = loadConfig(join(dir, 'turnover.config.yml'));
  assert.deepEqual([config.goal.event, config.goal.header, config.goal.when], ['signed_up', true, undefined]);
  assert.match(readFileSync(join(dir, 'turnover.config.yml'), 'utf8'), /X-Turnover-Event: signed_up/);
});
