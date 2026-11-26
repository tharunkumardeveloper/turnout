// Server mode: the start-up refusal, doctor's server-only checks, and the files that make up the mode
// (compose.server.yml, deploy/Caddyfile, the scripts). Local mode must not change.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { parse } from 'yaml';
import { evaluate } from '../src/commands/doctor.ts';
import { evaluateServer, hostnameProblem, modeOf, parseRestartPolicies, secretProblem, serverSecretProblems, type ServerFacts } from '../src/server-mode.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const SECRET = 'a'.repeat(48);
const good = {
  TURNOUT_MODE: 'server',
  TURNOUT_HOSTNAME: 'turnout.example.com',
  FLAGSMITH_DJANGO_SECRET_KEY: SECRET,
  FLAGSMITH_WAREHOUSE_SECRET: SECRET,
  POSTGRES_PASSWORD: SECRET,
  TURNOUT_JUDGE_TOKEN: SECRET,
  TURNOUT_PREVIEW_TOKEN: SECRET,
  TURNOUT_PUBLISH_HOST: '127.0.0.1',
};

describe('server mode: the start-up refusal', () => {
  test('mode is local unless .env says server', () => {
    assert.equal(modeOf({}), 'local');
    assert.equal(modeOf({ TURNOUT_MODE: 'local' }), 'local');
    assert.equal(modeOf({ TURNOUT_MODE: ' Server ' }), 'server');
  });

  test('placeholders, empty and short secrets are refused', () => {
    for (const v of ['', 'secret', 'password', 'changeme', 'CHANGE-ME-please-123456', '<your secret>', '${X}', 'short']) assert.ok(secretProblem(v), v);
    assert.equal(secretProblem(SECRET), null);
  });

  test('hostnames: a DNS name or localhost, never a URL or an IP', () => {
    assert.equal(hostnameProblem('turnout.example.com'), null);
    assert.equal(hostnameProblem('localhost'), null);
    for (const h of ['', 'https://x.example.com', 'x.example.com:443', 'nodot', '203.0.113.9']) assert.ok(hostnameProblem(h), h);
  });

  test("the official file's secrets are refused by name, never echoed", () => {
    const problems = serverSecretProblems({ ...good, FLAGSMITH_DJANGO_SECRET_KEY: 'secret', POSTGRES_PASSWORD: 'password' });
    assert.deepEqual(problems.map((p) => p.name), ['FLAGSMITH_DJANGO_SECRET_KEY', 'POSTGRES_PASSWORD']);
    assert.ok(!JSON.stringify(problems).includes('"secret"') && !JSON.stringify(problems).includes('password"'), 'values never appear');
    assert.deepEqual(serverSecretProblems(good), []);
  });

  test('tokens: empty is fine before init (init writes them), required after; a placeholder never', () => {
    const before = { ...good, TURNOUT_JUDGE_TOKEN: '', TURNOUT_PREVIEW_TOKEN: '' };
    assert.deepEqual(serverSecretProblems(before), []);
    assert.deepEqual(serverSecretProblems(before, true).map((p) => p.name), ['TURNOUT_JUDGE_TOKEN', 'TURNOUT_PREVIEW_TOKEN']);
    assert.deepEqual(serverSecretProblems({ ...good, TURNOUT_PREVIEW_TOKEN: 'changeme' }).map((p) => p.name), ['TURNOUT_PREVIEW_TOKEN']);
  });

  test('nothing else may be published: TURNOUT_PUBLISH_HOST stays 127.0.0.1, no other-device console hosts', () => {
    assert.deepEqual(serverSecretProblems({ ...good, TURNOUT_PUBLISH_HOST: '0.0.0.0', TURNOUT_CONSOLE_HOSTS: 'x' }).map((p) => p.name), ['TURNOUT_PUBLISH_HOST', 'TURNOUT_CONSOLE_HOSTS']);
  });
});

const facts = (over: Partial<ServerFacts> = {}): ServerFacts => ({
  hostname: 'turnout.example.com',
  tls: 'public',
  https: { value: { authorized: true, error: null, issuer: "Let's Encrypt", validTo: 'Feb 1 2027', selfSigned: false } },
  cookies: { value: { setCookies: 1, secure: 1, status: 200 } },
  readOnly: { value: { postStatus: 405 } },
  ports: [8000, 8080, 8090, 8091].map((port) => ({ port, reachable: false, detail: 'ECONNREFUSED' })),
  portsLoopback: false,
  secrets: [],
  restart: [{ service: 'caddy', policy: 'unless-stopped' }],
  ...over,
});
const status = (checks: ReturnType<typeof evaluateServer>, name: string) => checks.find((c) => c.name === name)?.status;

describe("server mode: doctor's checks", () => {
  test('all in place: every server check is ok', () => {
    const checks = evaluateServer(facts());
    assert.deepEqual(checks.map((c) => c.name), ['HTTPS', 'Secure cookies', 'Public judge view', 'Private ports', 'Secrets', 'Restart policies']);
    assert.ok(checks.every((c) => c.status === 'ok'), JSON.stringify(checks));
  });

  test("a self-signed certificate: ok with Caddy's internal CA (CI), failing for a public hostname", () => {
    const selfSigned = { value: { authorized: false, error: 'SELF_SIGNED_CERT_IN_CHAIN', issuer: 'Caddy Local Authority', validTo: null, selfSigned: true } };
    const internal = evaluateServer(facts({ tls: 'internal', https: selfSigned }));
    assert.equal(status(internal, 'HTTPS'), 'ok');
    assert.match(internal[0]!.actual, /self-signed/);
    assert.equal(status(evaluateServer(facts({ https: selfSigned })), 'HTTPS'), 'fail');
  });

  test('cookies without Secure, a reachable private port, a placeholder, a missing restart policy: failing', () => {
    const checks = evaluateServer(
      facts({
        cookies: { value: { setCookies: 2, secure: 1, status: 200 } },
        readOnly: { value: { postStatus: 202 } },
        ports: [{ port: 8000, reachable: true, detail: 'accepted a connection' }, { port: 8090, reachable: false, detail: 'ECONNREFUSED' }],
        secrets: [{ name: 'POSTGRES_PASSWORD', problem: 'a placeholder' }],
        restart: [{ service: 'caddy', policy: 'unless-stopped' }, { service: 'shop-1-4', policy: 'no' }],
      }),
    );
    for (const name of ['Secure cookies', 'Public judge view', 'Private ports', 'Secrets', 'Restart policies']) assert.equal(status(checks, name), 'fail', name);
    assert.match(checks.find((c) => c.name === 'Private ports')!.actual, /8000/);
  });

  test('restart policies read by the scripts; none given is a warning, not a failure', () => {
    assert.deepEqual(parseRestartPolicies('/togglewars-caddy-1=unless-stopped,shop=,'), [
      { service: 'togglewars-caddy-1', policy: 'unless-stopped' },
      { service: 'shop', policy: 'no' },
    ]);
    assert.equal(parseRestartPolicies(''), null);
    assert.equal(status(evaluateServer(facts({ restart: null })), 'Restart policies'), 'warn');
  });

  test('local mode: doctor has no server facts and adds no server checks', () => {
    const local = evaluate({
      apiUrl: 'http://flagsmith:8000/api/v1/',
      expectedVersion: '2.291.0',
      config: { flag: 'f', releases: [], goal: 'g', guardrails: [] },
      given: { adminKey: false, serverKey: false, envKey: undefined, previewToken: false, healthWebhook: undefined },
      version: { error: 'down' },
      proxy: { error: 'down' },
      console: 'self',
      metricsUrl: undefined,
      events: null,
    });
    assert.ok(!local.some((c) => c.area === 'Server mode'));
  });
});

describe('server mode: compose.server.yml and the Caddyfile', () => {
  const overlay = parse(read('compose.server.yml'), { merge: true, customTags: [{ tag: '!override', collection: 'seq', resolve: (v: unknown) => v }] });
  const services = overlay.services as Record<string, Record<string, any>>;

  test('Caddy is pinned, owns 80 and 443, and is the only service published beyond 127.0.0.1', () => {
    assert.match(services.caddy!.image, /^caddy:\d+\.\d+\.\d+(-alpine)?$/);
    assert.deepEqual(services.caddy!.ports, ['80:80', '443:443', '443:443/udp']);
    for (const [name, s] of Object.entries(services)) {
      if (name === 'caddy') continue;
      for (const p of s.ports ?? []) assert.match(String(p), /^127\.0\.0\.1:/, `${name}: ${p}`);
    }
    assert.deepEqual(services.turnout!.ports, ['127.0.0.1:8080:8080']);
    assert.deepEqual(services.console!.ports, ['127.0.0.1:8090:8090', '127.0.0.1:8091:8091']);
  });

  test('every long-running service restarts; the one-off migration only on failure', () => {
    for (const name of ['caddy', 'turnout', 'console', 'postgres', 'flagsmith', 'flagsmith-task-processor', 'shop-1-4', 'shop-1-5', 'shop-1-6']) {
      assert.equal(services[name]!.restart, 'unless-stopped', name);
    }
    assert.equal(services['migrate-db']!.restart, 'on-failure');
    const base = [read('compose.flagsmith.yml'), read('compose.turnout.yml'), read('compose.demo.yml')]
      .flatMap((t) => Object.keys(parse(t, { merge: true }).services ?? {}));
    for (const name of base) if (name !== 'cli' && name !== 'migrate-db') assert.ok(services[name]?.restart, `${name} has no restart policy in server mode`);
  });

  test("the console's autopilot runs the public story (on by default); no separate traffic service doubles it up", () => {
    assert.equal(services.console!.environment.TURNOUT_AUTOPILOT, '${TURNOUT_AUTOPILOT:-on}');
    assert.equal(services.traffic, undefined);
    assert.equal(services.console!.environment.CONSOLE_PUBLIC_PORT, 8092);
  });

  test('secure cookies on both proxies; the edge network has only Caddy, the live proxy, the console (and doctor)', () => {
    assert.equal(services.turnout!.environment.TURNOUT_SECURE_COOKIES, '1');
    assert.equal(services['turnout-live']!.environment.TURNOUT_SECURE_COOKIES, '1');
    assert.deepEqual(services['turnout-live']!.ports, [], 'the live proxy is reached through Caddy only');
    const onEdge = Object.entries(services).filter(([, s]) => (s.networks ?? []).includes('edge')).map(([n]) => n).sort();
    assert.deepEqual(onEdge, ['caddy', 'cli', 'console', 'turnout-live'], 'the simulated proxy is not public');
    assert.ok(!(services.flagsmith!.networks ?? []).includes('edge'));
  });

  test("Flagsmith's placeholder secrets are replaced by required variables", () => {
    for (const name of ['flagsmith', 'flagsmith-task-processor', 'migrate-db']) {
      const env = services[name]!.environment;
      assert.match(env.DJANGO_SECRET_KEY, /^\$\{FLAGSMITH_DJANGO_SECRET_KEY:\?/);
      assert.match(env.WAREHOUSE_CREDENTIALS_SECRET, /^\$\{FLAGSMITH_WAREHOUSE_SECRET:\?/);
      assert.match(env.DATABASE_URL, /\$\{POSTGRES_PASSWORD:\?/);
    }
    assert.match(services.postgres!.environment.POSTGRES_PASSWORD, /^\$\{POSTGRES_PASSWORD:\?/);
  });

  test('Caddyfile: the hostname from the environment; only GET/HEAD /judge* to the console; the rest to the proxy', () => {
    const caddy = read('deploy/Caddyfile');
    assert.match(caddy, /^\{\$TURNOUT_HOSTNAME\} \{/m);
    assert.match(caddy, /@judge path \/judge \/judge\/\*/);
    assert.match(caddy, /@read method GET HEAD/);
    const proxied = [...caddy.matchAll(/reverse_proxy (\S+)/g)].map((m) => m[1]);
    assert.deepEqual(proxied, ['console:8092', 'turnout-live:8080'], 'never console:8090, never flagsmith, never the simulated proxy');
    assert.match(caddy, /respond "[^"]+" 405/);
  });
});

describe('server mode: the scripts', () => {
  const sh = read('turnout.sh');
  const bat = read('turnout.bat');

  test('every compose command goes through the mode-aware wrapper', () => {
    assert.deepEqual(sh.split('\n').filter((l) => /^\s*[^#\s]/.test(l) && l.includes('docker compose ') && !/echo/.test(l)), ['  docker compose $COMPOSE_FILES "$@"']);
    assert.match(sh, /COMPOSE_FILES="-f compose.yaml -f compose.server.yml"/);
    assert.ok(!bat.split(/\r?\n/).some((l) => /^\s*docker compose (up|run|ps|--profile)/.test(l)), 'turnout.bat uses !DC!');
    assert.match(bat, /set "DC=docker compose -f compose.yaml -f compose.server.yml"/);
  });

  test('server mode refuses placeholders before starting, and never opens a browser', () => {
    assert.match(sh, /cli --build --no-deps cli server-check/);
    assert.match(sh, /cli --no-deps cli server-check --after-init/);
    assert.match(sh, /\[ "\$MODE" = server \] && return 0 # a server has no one at its screen/);
    assert.match(bat, /run --rm --build --no-deps cli server-check/);
    assert.match(bat, /if defined SY_SERVER endlocal & exit \/b 0/);
  });
});
