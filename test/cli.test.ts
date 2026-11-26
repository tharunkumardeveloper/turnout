// The CLI as a user runs it: `node src/cli.ts …` in a child process, with no .env and a clean environment.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'src', 'cli.ts');

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(TURNOUT_|FLAGSMITH_|GITHUB_)/.test(k) || k === 'NODE_TEST_CONTEXT') continue;
    env[k] = v;
  }
  return { ...env, TURNOUT_ENV_FILE: join(tmpdir(), `turnout-no-such-env-${process.pid}`), ...extra };
}

// Async, so an in-process fake server can answer the child.
function cli(args: string[], extra: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env: cleanEnv(extra), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 20_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('--help and -h print the usage and exit 0', async () => {
  for (const args of [['--help'], ['-h'], ['help'], [], ['check', '--help']]) {
    const r = await cli(args);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stdout, /^Usage: turnout <command> \[options\]/);
    assert.match(r.stdout, /init\s+Bootstrap Flagsmith/);
  }
});

test('an unknown command prints the usage and exits 1', async () => {
  const r = await cli(['bogus']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /Usage: turnout/);
});

test('the usage lists every option the commands take', async () => {
  const { stdout } = await cli(['--help']);
  for (const option of ['--visitors', '--rate', '--concurrency', '--seed', '--target', '--split', '--hypothesis', '--winner', '--project', '--json']) {
    assert.ok(stdout.includes(option), `${option} missing from the usage`);
  }
});

test('an unknown option or a missing value exits 1 naming it, without a stack trace', async () => {
  for (const [args, expected] of [
    [['check', '--no-such-option'], /^turnout: Unknown option '--no-such-option'/],
    [['demo', '--visitors'], /^turnout: Option '--visitors <value>' argument missing/],
  ] as const) {
    const r = await cli([...args]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, expected);
    assert.match(r.stderr, /Run turnout --help/);
    assert.doesNotMatch(r.stderr, /\bat .*node:internal|ERR_PARSE_ARGS/);
  }
});

test('demo rejects malformed numbers before sending any traffic', async () => {
  const runs: Promise<void>[] = [];
  for (const [args, expected] of [
    [['--visitors', 'abc'], /--visitors expects a whole number from 1 to 1000000, got "abc"/],
    [['--visitors', '0'], /--visitors expects a whole number/],
    [['--visitors', '2.5'], /--visitors expects a whole number/],
    [['--concurrency', '0'], /--concurrency expects a whole number from 1 to 1000, got "0"/],
    [['--seed', 'x'], /--seed expects a whole number/],
    [['--rate', 'v2=1.5'], /--rate expects <variant>=<0\.\.1>, got "v2=1\.5"/],
    [['--rate', 'v2='], /--rate expects <variant>=<0\.\.1>, got "v2="/],
    [['--rate', 'v2=-0.1'], /--rate expects/],
    [['--target', 'ftp://example.test'], /--target expects the proxy's http\(s\) URL, got "ftp:\/\/example\.test"/],
  ] as const) {
    runs.push(cli(['demo', ...args, ...(args[0] === '--target' ? [] : ['--target', 'http://127.0.0.1:9'])]).then((r) => {
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.stderr, expected);
      assert.equal(r.stdout, '', 'nothing simulated');
    }));
  }
  await Promise.all(runs);
});

test('release checks --split before asking for a key or touching Flagsmith', async () => {
  for (const split of ['0', '100', 'abc', '']) {
    const r = await cli(['release', 'shop:1.6', '--split', split]);
    assert.equal(r.code, 1, split);
    assert.match(r.stderr, new RegExp(`--split expects a percentage above 0 and below 100, got "${split}"`));
  }
});

test('release() itself refuses a split of 0 or 100 before calling Flagsmith', async () => {
  const { release } = await import('../src/commands/release.ts');
  const base = { apiUrl: 'http://127.0.0.1:9/api/v1/', adminKey: 'k', envKey: 'e', flag: 'f', releases: new Set(['a', 'b']), newRelease: 'b', hypothesis: 'h', log: () => {} };
  for (const split of [0, 100, Number.NaN]) {
    await assert.rejects(release({ ...base, split }), /The split must be a percentage above 0 and below 100/);
  }
});

test('check against an unreachable Flagsmith names the address and the reason', async () => {
  const closed = http.createServer();
  await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
  const { port } = closed.address() as AddressInfo;
  await new Promise<void>((r) => closed.close(() => r()));
  const r = await cli(['check', '--api-url', `http://127.0.0.1:${port}/api/v1/`, '--server-key', 'ser.x']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, new RegExp(`^turnout check: Couldn't reach Flagsmith at http://127\\.0\\.0\\.1:${port}: ECONNREFUSED`));
});

test('check without a server key exits 1 and names TURNOUT_SERVER_KEY', async () => {
  const r = await cli(['check']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /turnout: TURNOUT_SERVER_KEY is not set/);
});

test('release and preview without a label exit 1 with their usage', async () => {
  for (const command of ['release', 'preview']) {
    const r = await cli([command]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, new RegExp(`turnout ${command}: Usage: turnout ${command} <release label>`));
  }
});

test('demo rejects a malformed --rate before sending any traffic', async () => {
  const r = await cli(['demo', '--rate', 'v2', '--target', 'http://127.0.0.1:9']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--rate expects <variant>=<0\.\.1>, got "v2"/);
});

test('status without an experiment reference exits 1 naming TURNOUT_EXPERIMENT', async () => {
  const r = await cli(['status', '--admin-key', 'org.x']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /TURNOUT_EXPERIMENT is not set/);
});

// A one-route Flagsmith: the environment document, for `check`.
async function documentServer(doc: unknown, status = 200) {
  const seen: { path: string; key: string | undefined }[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url ?? '', key: req.headers['x-environment-key'] as string | undefined });
    res.writeHead(req.url === '/api/v1/environment-document/' ? status : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(doc));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { apiUrl: `http://127.0.0.1:${port}/api/v1/`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const rollout = (id: number, coverage: string, running: boolean) => ({
  id,
  name: `experiment-${id}-rollout`,
  rules: [{ type: 'ALL', rules: [], conditions: [{ operator: 'PERCENTAGE_SPLIT', value: coverage, property_: '$.identity.key' }] }],
  feature_states: [
    {
      feature: { name: 'shop_release' },
      enabled: true,
      ...(running ? { metadata: { experiment: { id } } } : {}),
      multivariate_feature_state_values: [{ multivariate_feature_option: { key: 'v2' }, percentage_allocation: 50 }],
    },
  ],
});

test('check exits 0 when nothing is left behind and 1 when a split is', async () => {
  const clean = await documentServer({ project: { segments: [rollout(1, '100.0', true)] } });
  try {
    const r = await cli(['check', '--api-url', clean.apiUrl, '--server-key', 'ser.cli']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /· shop_release: experiment 1 is running/);
    assert.deepEqual(clean.seen, [{ path: '/api/v1/environment-document/', key: 'ser.cli' }]);
  } finally {
    await clean.close();
  }

  const leftover = await documentServer({ project: { segments: [rollout(2, '100.0', false)] } });
  try {
    const r = await cli(['check', '--api-url', leftover.apiUrl], { TURNOUT_SERVER_KEY: 'ser.env' });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /✗ shop_release: experiment 2 is not running \(created, paused or completed\)/);
    assert.equal(leftover.seen[0]!.key, 'ser.env');
  } finally {
    await leftover.close();
  }
});

test('check with an admin key exits 0 for a paused experiment’s split, and never prompts for the key', async () => {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.url} ${req.headers.authorization ?? ''}`);
    const body = req.url === '/api/v1/environment-document/'
      ? { api_key: 'envA', project: { segments: [rollout(4, '100.0', false)] } }
      : req.url === '/api/v1/environments/envA/experiments/4/' ? { id: 4, status: 'paused', experiment_rollout: null } : null;
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(body ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/`;
  try {
    const paused = await cli(['check', '--api-url', apiUrl, '--server-key', 'ser.cli'], { TURNOUT_ADMIN_KEY: 'org.cli' });
    assert.equal(paused.code, 0, paused.stderr);
    assert.match(paused.stdout, /! shop_release: experiment 4 is paused; its split still covers 100% of identities/);
    assert.ok(seen.includes('/api/v1/environments/envA/experiments/4/ Api-Key org.cli'));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('check with a key Flagsmith refuses exits 1 with an explanation', async () => {
  const server = await documentServer({ detail: 'Invalid key' }, 403);
  try {
    const r = await cli(['check', '--api-url', server.apiUrl, '--server-key', 'env.client-side']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /turnout check: Couldn't read the environment document \(403\)\. check needs a server-side key/);
  } finally {
    await server.close();
  }
});

// The console's startup lines end up in `docker compose logs`: the judge key appears there only once other devices
// are set up (TURNOUT_CONSOLE_HOSTS), as init prints it.
function consoleBanner(extra: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'console'], {
      cwd: ROOT,
      env: cleanEnv({ TURNOUT_ADMIN_KEY: 'k', FLAGSMITH_API_URL: 'http://127.0.0.1:9/api/v1/', CONSOLE_PORT: '0', CONSOLE_DEVICE_PORT: '0', ...extra }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => child.kill(), 20_000);
    const take = (d: Buffer) => {
      out += d;
      if (/other devices \(judge link only\) on/.test(out) && /Judge mode/.test(out)) child.kill();
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

test('the console logs no judge key link while no other device is set up', async () => {
  const out = await consoleBanner({ TURNOUT_JUDGE_TOKEN: 'judge-token-in-logs' });
  assert.match(out, /Judge mode: http:\/\/127\.0\.0\.1:8090\/judge/);
  assert.match(out, /other devices \(judge link only\) on/);
  assert.doesNotMatch(out, /key=/);
  assert.doesNotMatch(out, /judge-token-in-logs/);

  const shared = await consoleBanner({ TURNOUT_JUDGE_TOKEN: 'judge-token-in-logs', TURNOUT_CONSOLE_HOSTS: '192.168.1.20' });
  assert.match(shared, /Judge link for other devices: http:\/\/192\.168\.1\.20:8091\/judge\?key=judge-token-in-logs/);
});
