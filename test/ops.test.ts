// The deployment files: what Compose publishes and where, which networks each service joins, who the containers run
// as, that every setting the code reads is documented in .env.example, and the start scripts' reset option.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');

type Service = {
  ports?: string[];
  networks?: string[];
  user?: string;
  environment?: Record<string, string>;
  profiles?: string[];
};
type ComposeFile = { services: Record<string, Service>; networks?: Record<string, unknown> };
const compose = (path: string) => YAML.parse(read(path), { merge: true }) as ComposeFile;
const flagsmith = compose('compose.flagsmith.yml');
const turnout = compose('compose.turnout.yml');
const demo = compose('compose.demo.yml');
const services = { ...flagsmith.services, ...turnout.services, ...demo.services };

describe('compose: published ports', () => {
  test('only the proxy and the console\'s other-devices port follow TURNOUT_PUBLISH_HOST; the rest stay on 127.0.0.1', () => {
    const published = Object.entries(services).flatMap(([name, s]) => (s.ports ?? []).map((p) => `${name} ${p}`));
    assert.deepEqual(published.sort(), [
      'console ${TURNOUT_PUBLISH_HOST:-127.0.0.1}:8091:8091', // judge link only: the cookie is always required
      'console 127.0.0.1:8001:8001', // Flagsmith's dashboard with Turnout's tour, this machine only
      'console 127.0.0.1:8090:8090', // this machine's console: loopback Host names are trusted here only
      'flagsmith 127.0.0.1:8000:8000', // the dashboard and admin API keep the official placeholder secrets
      'tryit 127.0.0.1:8085:8085', // Try it with your app: your versions through Turnout, this machine only
      'tryit 127.0.0.1:8086-8088:8086-8088', // each version on its own (previews, never counted), this machine only
      'turnout ${TURNOUT_PUBLISH_HOST:-127.0.0.1}:8080:8080',
    ]);
    assert.equal(String(services.console!.environment!.CONSOLE_DEVICE_PORT), '8091');
  });

  test('Flagsmith keeps idle connections open longer than Node does (4 s), so no request lands on a closed socket', () => {
    assert.ok(Number(flagsmith.services.flagsmith!.environment!.GUNICORN_KEEP_ALIVE) > 4);
  });

  test("the task processor's port is not published (its health check runs inside the container)", () => {
    assert.equal(flagsmith.services['flagsmith-task-processor']!.ports, undefined);
  });
});

describe('compose: networks', () => {
  const nets = (name: string) => [...(services[name]!.networks ?? ['default'])].sort();

  test('the proxy is off the default network: Flagsmith over sdk, the console over feed, the shops over apps', () => {
    assert.deepEqual(nets('turnout'), ['apps', 'feed', 'sdk']);
    assert.deepEqual(nets('flagsmith'), ['default', 'sdk']);
    for (const name of ['postgres', 'migrate-db', 'flagsmith-task-processor']) assert.deepEqual(nets(name), ['default'], name);
  });

  test('the console and the CLI reach Flagsmith on default and the proxy on feed, never the shops', () => {
    assert.deepEqual(nets('console'), ['default', 'feed']);
    assert.deepEqual(nets('cli'), ['default', 'feed']);
    assert.equal(services.console!.environment!.TURNOUT_FEED_URL, 'http://turnout:8081');
    assert.equal(services.console!.environment!.TURNOUT_PROXY_URL, 'http://turnout:8080');
  });

  test('the shops sit on apps only', () => {
    for (const name of ['shop-1-4', 'shop-1-5', 'shop-1-6']) assert.deepEqual(nets(name), ['apps'], name);
  });

  test('each network is declared once, in the file that owns it', () => {
    assert.deepEqual(Object.keys(flagsmith.networks ?? {}), ['sdk']);
    assert.deepEqual(Object.keys(turnout.networks ?? {}).sort(), ['apps', 'feed']);
    assert.deepEqual(Object.keys(demo.networks ?? {}), ['apps'], 'the demo file names the network its shops join');
  });
});

describe('compose: any app', () => {
  test('the shops live in compose.demo.yml, which compose.yaml includes, and the proxy does not depend on them', () => {
    assert.deepEqual(Object.keys(turnout.services).filter((n) => n.startsWith('shop')), []);
    assert.deepEqual(Object.keys(demo.services).sort(), ['shop-1-4', 'shop-1-5', 'shop-1-6']);
    assert.match(read('compose.yaml'), /- compose\.demo\.yml/);
    assert.deepEqual(Object.keys((services.turnout as { depends_on?: Record<string, unknown> }).depends_on ?? {}), ['flagsmith']);
  });

  test('the routing config is mounted read-only into the proxy, the console and the CLI, never baked into the image', () => {
    for (const name of ['turnout', 'console', 'cli']) {
      assert.ok(
        (services[name] as { volumes?: string[] }).volumes?.includes('${TURNOUT_CONFIG_FILE:-./turnout.config.yml}:/app/turnout.config.yml:ro'),
        name,
      );
      assert.deepEqual((services[name] as { extra_hosts?: string[] }).extra_hosts, ['host.docker.internal:host-gateway'], name);
    }
    assert.doesNotMatch(read('Dockerfile'), /COPY[^\n]*turnout\.config\.yml/);
  });
});

describe('compose: users and settings', () => {
  test('the console and the CLI, which write bind mounts, run as TURNOUT_UID:TURNOUT_GID (default 1000)', () => {
    for (const name of ['console', 'cli']) assert.equal(services[name]!.user, '${TURNOUT_UID:-1000}:${TURNOUT_GID:-1000}', name);
    assert.equal(services.turnout!.user, undefined, 'the proxy keeps the image user (its state is a named volume)');
  });

  test("the proxy receives every setting it reads that .env can change", () => {
    const env = services.turnout!.environment!;
    for (const key of ['TURNOUT_SERVER_KEY', 'TURNOUT_PREVIEW_TOKEN', 'TURNOUT_SECURE_COOKIES', 'TURNOUT_ACCESS_LOG']) {
      assert.equal(env[key], `\${${key}:-}`, key);
    }
  });

  test('the shops allow framing from the console hosts, and links default to 127.0.0.1', () => {
    for (const name of ['shop-1-4', 'shop-1-5', 'shop-1-6']) {
      assert.equal(services[name]!.environment!.SHOP_FRAME_HOSTS, '${TURNOUT_CONSOLE_HOSTS:-}', name);
      assert.equal(services[name]!.environment!.SHOP_FRAME_ANCESTORS, '${SHOP_FRAME_ANCESTORS:-}', name);
    }
    assert.equal(services['shop-1-6']!.environment!.SEEDED_DELAY_MS, '60');
    const consoleEnv = services.console!.environment!;
    assert.equal(consoleEnv.TURNOUT_PUBLIC_SHOP_URL, '${TURNOUT_PUBLIC_SHOP_URL:-http://127.0.0.1:8080}');
    assert.equal(consoleEnv.FLAGSMITH_DASHBOARD_URL, '${FLAGSMITH_DASHBOARD_URL:-http://127.0.0.1:8000}');
  });
});

describe('.env.example', () => {
  const example = read('.env.example');
  const documented = new Set([...example.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)].map((m) => m[1]!));

  // Every variable name the code reads: process.env.X, process.env['X'], env.X (an env object) and env('X') (the CLI's helper).
  function readByCode(): Map<string, string> {
    const found = new Map<string, string>();
    for (const dir of ['src', 'demo']) {
      for (const entry of readdirSync(join(root, dir), { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !/\.(ts|js)$/.test(entry.name)) continue;
        const file = join(entry.parentPath, entry.name);
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(/\b(?:process\.env\.|process\.env\[\s*'|env\.|env\(\s*')([A-Z][A-Z0-9_]+)\b/g)) {
          if (!found.has(m[1]!)) found.set(m[1]!, file.slice(root.length));
        }
      }
    }
    return found;
  }

  test('documents every environment variable the code reads', () => {
    const read = readByCode();
    assert.ok(read.size >= 30, `found ${read.size} variables`);
    const missing = [...read].filter(([name]) => !documented.has(name)).map(([name, file]) => `${name} (${file})`);
    assert.deepEqual(missing, [], 'add these to .env.example, or say there that Compose sets them');
  });

  test("documents every ${VAR} Compose reads from it", () => {
    const vars = new Set(
      [read('compose.turnout.yml'), read('compose.flagsmith.yml')].flatMap((t) => [...t.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]!)),
    );
    assert.ok(vars.has('TURNOUT_UID') && vars.has('TURNOUT_PUBLISH_HOST'));
    assert.deepEqual([...vars].filter((v) => !documented.has(v)), []);
  });

  test('links default to 127.0.0.1, where Compose publishes', () => {
    assert.match(example, /^TURNOUT_PUBLIC_SHOP_URL=http:\/\/127\.0\.0\.1:8080$/m);
    assert.match(example, /^FLAGSMITH_DASHBOARD_URL=http:\/\/127\.0\.0\.1:8000$/m);
    assert.match(example, /^TURNOUT_PUBLISH_HOST=127\.0\.0\.1$/m);
  });

  test('every active line is NAME=value, with no secret filled in', () => {
    for (const line of example.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      assert.match(line, /^[A-Z][A-Z0-9_]*=/, line);
    }
    for (const key of ['TURNOUT_SERVER_KEY', 'TURNOUT_ADMIN_KEY', 'FLAGSMITH_ADMIN_PASSWORD', 'TURNOUT_JUDGE_TOKEN', 'TURNOUT_PREVIEW_TOKEN', 'TURNOUT_HEALTH_WEBHOOK', 'GITHUB_TOKEN']) {
      assert.match(example, new RegExp(`^${key}=$`, 'm'), key);
    }
  });
});

describe('CI', () => {
  const ci = read('.github/workflows/ci.yml');

  test('masks the server key before writing it to GITHUB_OUTPUT', () => {
    const mask = ci.indexOf('::add-mask::$key');
    const output = ci.indexOf('server-key=$key" >> "$GITHUB_OUTPUT"');
    assert.ok(mask > 0 && output > mask, 'add-mask comes first');
  });

  test('runs the containers as the runner user instead of opening up permissions', () => {
    assert.doesNotMatch(ci, /chmod (777|666)/);
    assert.match(ci, /TURNOUT_UID=\$\(id -u\)" >> "\$GITHUB_ENV"/);
    assert.match(ci, /TURNOUT_GID=\$\(id -g\)" >> "\$GITHUB_ENV"/);
  });

  test('parses as YAML', () => {
    assert.ok((YAML.parse(ci) as { jobs: Record<string, unknown> }).jobs.smoke);
  });
});

describe('the reusable Action', () => {
  type Step = { name?: string; env?: Record<string, string>; run?: string };
  const action = YAML.parse(read('action.yml')) as { runs: { steps: Step[] } };
  const step = (name: string) => action.runs.steps.find((s) => s.name === name)!;

  test('check gets the optional admin key, so created and paused experiments are told from completed ones', () => {
    const env = step('turnout check').env!;
    assert.equal(env.TURNOUT_SERVER_KEY, '${{ inputs.server-key }}');
    assert.equal(env.TURNOUT_ADMIN_KEY, '${{ inputs.admin-key }}');
    assert.equal(env.TURNOUT_ENV_FILE, '/dev/null/none');
    assert.match(step('turnout check').run!, /cli\.ts" check$/);
  });

  test('check treats an empty admin key as none and never asks for one', () => {
    assert.match(read('src/cli.ts'), /check: async \(\) => \{[^}]*process\.env\.TURNOUT_ADMIN_KEY \|\| undefined/);
  });
});

describe('start scripts', () => {
  test('line endings: .bat files CRLF, .sh files LF', () => {
    for (const bat of ['turnout.bat', 'setup.bat']) {
      const text = read(bat);
      assert.equal(text.split('\n').length, text.split('\r\n').length, `${bat} has a bare LF`);
    }
    for (const sh of ['turnout.sh', 'setup.sh']) assert.ok(!read(sh).includes('\r'), `${sh} has a CR`);
  });

  test('links on this machine use 127.0.0.1 unless .env keeps the shop on localhost', () => {
    for (const script of ['turnout.sh', 'turnout.bat']) {
      const text = read(script);
      assert.doesNotMatch(text, /http:\/\/localhost:80[0-9]0/, `${script} hard-codes localhost`);
      assert.match(text, /TURNOUT_PUBLIC_SHOP_URL=/, script);
    }
  });

  test('turnout.sh exports TURNOUT_UID/GID on Linux', () => {
    const text = read('turnout.sh');
    assert.match(text, /export TURNOUT_UID TURNOUT_GID/);
    assert.doesNotMatch(text, /--user/);
  });

  const sh = spawnSync('sh', ['-c', 'exit 0']).status === 0;
  test('sh turnout.sh: reset takes --yes; other options are refused before anything starts', { skip: !sh && 'no sh' }, () => {
    const run = (...args: string[]) => spawnSync('sh', [join(root, 'turnout.sh'), ...args], { encoding: 'utf8', timeout: 20_000 });
    const help = run('--help');
    assert.equal(help.status, 0);
    assert.match(help.stdout, /reset \[--yes\]/);
    for (const args of [['reset', '--nope'], ['status', '--yes'], ['reset', '--yes', 'more'], ['bogus']]) {
      const r = run(...args);
      assert.equal(r.status, 1, args.join(' '));
      assert.match(r.stdout, /Not started\./, args.join(' '));
      assert.doesNotMatch(r.stdout, /Turnout\n =+/, `${args.join(' ')} got past the option check`);
    }
  });

  // A copy of turnout.sh in an empty folder, with a docker stand-in on PATH that logs its arguments.
  const sandbox = (dockerBody: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'turnout-tree-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(dir, 'turnout.sh'), read('turnout.sh'));
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\necho "$*" >> "${join(dir, 'docker.log').replaceAll('\\', '/')}"\n${dockerBody}\n`);
    chmodSync(join(bin, 'docker'), 0o755);
    const run = (...args: string[]) =>
      spawnSync('sh', [join(dir, 'turnout.sh'), ...args], {
        encoding: 'utf8',
        timeout: 20_000,
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, TURNOUT_NO_BROWSER: '1' },
      });
    const calls = () => (existsSync(join(dir, 'docker.log')) ? readFileSync(join(dir, 'docker.log'), 'utf8') : '');
    return { dir, run, calls, done: () => rmSync(dir, { recursive: true, force: true }) };
  };

  test('sh turnout.sh status on a fresh checkout runs no setup check, so Docker creates no .env folder', { skip: !sh && 'no sh' }, () => {
    const box = sandbox('exit 0');
    try {
      const r = box.run('status');
      assert.equal(r.status, 0);
      assert.match(r.stdout, /Not set up yet: run sh turnout\.sh first/);
      assert.match(box.calls(), /compose ps/);
      assert.doesNotMatch(box.calls(), /compose run/);
      assert.ok(!existsSync(join(box.dir, '.env')));
    } finally {
      box.done();
    }
  });

  test('sh turnout.sh reset deletes nothing when Docker cannot remove the volumes', { skip: !sh && 'no sh' }, () => {
    const box = sandbox('case "$*" in *"down -v"*) exit 1 ;; esac\nexit 0');
    try {
      mkdirSync(join(box.dir, '.turnout'));
      writeFileSync(join(box.dir, '.turnout', 'ledger.jsonl'), '{}\n');
      const r = box.run('reset', '--yes');
      assert.equal(r.status, 1);
      assert.match(r.stdout, /nothing deleted/);
      assert.match(r.stdout, /Not reset\./);
      assert.ok(existsSync(join(box.dir, '.turnout', 'ledger.jsonl')), 'the ledger is kept');
      assert.doesNotMatch(box.calls(), /compose up/, 'and nothing starts');
    } finally {
      box.done();
    }
  });

  test('turnout.bat: status checks .env before the setup check; reset stops when down -v fails', () => {
    const bat = read('turnout.bat');
    const status = bat.split(/^:status\r?$/m)[1]!.split(/^:stop\r?$/m)[0]!;
    assert.match(status, /if exist "\.env" if not exist "\.env\\" set "SY_READY=1"/);
    assert.match(status, /if defined SY_READY call :doctor/);
    assert.doesNotMatch(status, /^call :doctor/m);
    const reset = bat.split(/^:reset_wipe\r?$/m)[1]!.split(/^goto :start/m)[0]!;
    assert.match(reset, /down -v\r?\nif errorlevel 1 \(/);
    assert.ok(reset.indexOf('errorlevel 1') < reset.indexOf('rmdir'), 'checked before anything is deleted');
  });

  test('sh setup.sh: a BusyBox lsof (Alpine), which ignores its options, does not mark free ports as used', { skip: !sh && 'no sh' }, () => {
    // Stand-ins on PATH: docker isn't running (so the Docker port list is empty), ss and nc see nothing, and lsof
    // prints what the test gives it whatever the options.
    const bin = mkdtempSync(join(tmpdir(), 'turnout-bin-'));
    const fake = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    fake('docker', 'exit 1');
    fake('ss', 'exit 1');
    fake('nc', 'exit 1');
    const ports = (lsofOutput: string) => {
      fake('lsof', `printf '${lsofOutput}'`);
      const r = spawnSync('sh', [join(root, 'setup.sh'), '--check'], {
        encoding: 'utf8',
        timeout: 20_000,
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
      });
      return r.stdout.split('[5/8]')[1]!.split('[6/8]')[0]!;
    };
    try {
      // BusyBox: one row per open file of every process, tab-separated, no header.
      const busybox = ports('1\\t/bin/busybox\\t/dev/null\\n1\\t/bin/busybox\\t/dev/pts/0\\n');
      for (const p of [8000, 8080, 8090, 8091]) assert.match(busybox, new RegExp(`port ${p} is free`));
      assert.doesNotMatch(busybox, /is used by/);
      // The real lsof: a header, then the listening socket.
      const real = ports('COMMAND  PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\\nnode    4242 me   21u IPv4 0x1 0t0 TCP *:8080 (LISTEN)\\n');
      assert.match(real, /port 8080 is used by node \(PID 4242\)/);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test('turnout.bat: reset takes /yes; other options are refused before anything starts', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
    // The full path: cmd may be set not to look in the current directory (NoDefaultCurrentDirectoryInExePath).
    const bat = join(root, 'turnout.bat');
    const run = (args: string) =>
      spawnSync('cmd.exe', ['/d', '/s', '/c', `""${bat}" ${args}"`], { cwd: root, encoding: 'utf8', timeout: 20_000, windowsVerbatimArguments: true });
    const help = run('/?');
    assert.equal(help.status, 0);
    assert.match(help.stdout, /reset \[\/yes\]/);
    for (const args of ['reset /nope', 'status /yes', 'reset /yes more', 'bogus']) {
      const r = run(args);
      assert.equal(r.status, 1, args);
      assert.match(r.stdout, /Not started\./, args);
      assert.doesNotMatch(r.stdout, /Turnout\r?\n\s+=+/, `${args} got past the option check`);
    }
  });
});
