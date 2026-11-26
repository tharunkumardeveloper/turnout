#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { check } from './commands/check.ts';
import { formatReport, runDoctor, type DoctorOptions } from './commands/doctor.ts';
import { init, judgeLinks, localHost, writeEnv } from './commands/init.ts';
import { DEFAULT_RELEASES, DEFAULT_SUCCESS, readFileIfExists, writeNew, type NewAnswers } from './commands/new.ts';
import { createInterface } from 'node:readline/promises';
import { preview } from './commands/preview.ts';
import { release } from './commands/release.ts';
import { revert, ship, status } from './commands/ship.ts';
import { simulate } from '../demo/simulator/simulate.ts';
import { defaultHypothesis, describeGoal, loadConfig } from './config.ts';
import { createFlagSource } from './flagsmith/flag-source.ts';
import { DEFAULT_RATES, parseRates } from './console/judge.ts';
import { createConsole, listenForOtherDevices, listenForPublic } from './console/server.ts';
import { autopilotFromEnv } from './console/autopilot.ts';
import { AdminClient } from './flagsmith/admin.ts';
import { scanAndSubmit } from './flagsmith/code-refs.ts';
import { Experiments, latestExperiment, parseExperimentRef } from './flagsmith/experiments.ts';
import { createFeedServer, TrafficFeed } from './proxy/feed.ts';
import { createProxy, type ReleaseMemory } from './proxy/server.ts';
import { decide } from './decide.ts';
import { DEFAULT_GUARD_THRESHOLD, Watcher } from './health.ts';
import { modeOf, serverSecretProblems } from './server-mode.ts';

const USAGE = `Usage: turnout <command> [options]

Commands:
  proxy      Route visitors by the Flagsmith flag and send events (port 8080)
  console    Traffic map, results, Ship winner and Revert (127.0.0.1:8090); judge mode on /judge
  new        Set Turnout up for your app: four questions → turnout.config.yml and turnout.compose.yml
             [--flagsmith bundled|<api url>] [--release <label=url | url | image> …] [--success "POST /signup 2xx" | "header signup"]
             [--traffic <1-100>] [--flag <name>] [--event <name>] [--port <app port>] [--image <turnout image>]
             [--project <name|id>] [--environment <name|key>] [--admin-key <key>] [--dir <path>] [--force] [--yes]
  init       Bootstrap Flagsmith: event store, tagged flag, metrics, experiment
             [--project <name|id> --environment <name|key>]  reuse your existing project and environment
             (env TURNOUT_PROJECT, TURNOUT_ENVIRONMENT); creates no organisation, project or environment
  preview    Serve a new release to your team only: preview <label>
  release    Start the next experiment on the same flag: release <label> [--hypothesis "…"]
             [--split <1-99>]  % of visitors in the experiment who get the new release (default 50)
             [--aa | <label> --against-itself]  A/A run: the live release on both arms (any winner is noise)
             [--mde <pct>] [--daily-visitors <n>]  size the launch estimate (default a 10% relative lift)
  status     Flagsmith's results for an experiment [--refresh]
  ship       Ship the winner on the same flag [--winner <variant>] [--yes] [--accept-losing-guardrails]
  revert     Send everyone back to control, drain the split and complete [--yes]
  check      Find experiment splits left behind on any flag (read-only, server key; with an admin key it
             also reads each experiment's status, so created and paused experiments are not counted, and
             runs the Experiment Doctor on running and recent experiments: exposures, tracking, sample ratio)
  doctor     Check that everything is set up as expected: Flagsmith, keys, flag, metrics, proxy, shops [--json]
  demo       Drive labelled simulated visitors through the proxy [--visitors 2000] [--rate v2=0.13]
             [--concurrency 20] [--seed 42] [--target http://turnout:8080]
             [--flow shop|goal]  goal: land on /, then send the config's goal request (default for non-shop apps)
  server-check  Server mode: refuse placeholder Flagsmith secrets and tokens (names only, never values) [--after-init]
  code-refs  Find the flag's name in this checkout and submit it to Flagsmith's Code References [--project <id>]
             (repository: GitHub Actions' variables, an https GitHub "origin" remote, or TURNOUT_REPOSITORY_URL)

Options for any command:
  --api-url <url>      Flagsmith's API, e.g. http://127.0.0.1:8000/api/v1/ (env FLAGSMITH_API_URL)
  --server-key <ser.>  Server-side environment key (env TURNOUT_SERVER_KEY)
  --admin-key <key>    Organisation API key (env TURNOUT_ADMIN_KEY; asked for when a command needs it)

status, ship and revert take an experiment link (…/environment/<key>/experiments/<id>)
or default to the flag's latest experiment in TURNOUT_EXPERIMENT's environment.
`;

const ENV_FILE = process.env.TURNOUT_ENV_FILE ?? '.env';
if (existsSync(ENV_FILE)) {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch {
    // a directory Docker created in place of a missing file; init explains it
  }
}

const parseCommandLine = () =>
  parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      'api-url': { type: 'string' },
      'server-key': { type: 'string' },
      'admin-key': { type: 'string' },
      'accept-losing-guardrails': { type: 'boolean' },
      winner: { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
      refresh: { type: 'boolean' },
      json: { type: 'boolean' },
      visitors: { type: 'string' },
      rate: { type: 'string', multiple: true },
      concurrency: { type: 'string' },
      seed: { type: 'string' },
      target: { type: 'string' },
      hypothesis: { type: 'string' },
      split: { type: 'string' },
      aa: { type: 'boolean' },
      'against-itself': { type: 'boolean' },
      mde: { type: 'string' },
      'daily-visitors': { type: 'string' },
      project: { type: 'string' },
      environment: { type: 'string' },
      flagsmith: { type: 'string' },
      release: { type: 'string', multiple: true },
      success: { type: 'string' },
      traffic: { type: 'string' },
      flag: { type: 'string' },
      event: { type: 'string' },
      port: { type: 'string' },
      image: { type: 'string' },
      'proxy-port': { type: 'string' },
      'console-port': { type: 'string' },
      'flagsmith-port': { type: 'string' },
      'app-env-file': { type: 'string' },
      dir: { type: 'string' },
      force: { type: 'boolean' },
      flow: { type: 'string' },
      'after-init': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
let parsed: ReturnType<typeof parseCommandLine>;
try {
  parsed = parseCommandLine();
} catch (error) {
  // An unknown option or a missing value: say which, without Node's stack trace.
  console.error(`turnout: ${(error as Error).message}`);
  console.error('Run turnout --help for the commands and their options.');
  process.exit(1);
}
const { values: cliFlags, positionals: args } = parsed;
const [name, ...positionals] = args;

// A whole number option within bounds, or the fallback when it isn't given.
function wholeNumber(option: 'visitors' | 'concurrency' | 'seed', fallback: number, min: number, max: number): number {
  const raw = cliFlags[option];
  if (raw === undefined) return fallback;
  const value = raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`--${option} expects a whole number from ${min} to ${max}, got "${raw}"`);
  return value;
}

// --split: the share of the experiment's visitors who get the new release. 0 or 100 would leave one side empty.
function splitOption(): number | undefined {
  const raw = cliFlags.split;
  if (raw === undefined) return undefined;
  const value = raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value >= 100) throw new Error(`--split expects a percentage above 0 and below 100, got "${raw}"`);
  return value;
}

// A positive number option (--mde, --daily-visitors), or undefined when not given.
function positiveOption(option: 'mde' | 'daily-visitors', max: number): number | undefined {
  const raw = cliFlags[option];
  if (raw === undefined) return undefined;
  const value = raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > max) throw new Error(`--${option} expects a number above 0 and up to ${max}, got "${raw}"`);
  return value;
}

const env = (key: string, fallback?: string): string => {
  const value = process.env[key] || fallback;
  if (!value) {
    console.error(`turnout: ${key} is not set (see .env.example)`);
    process.exit(1);
  }
  return value;
};

const STATE_DIR = process.env.TURNOUT_STATE_DIR ?? '.turnout';
const SNAPSHOTS = join(STATE_DIR, 'snapshots');
const apiUrl = () => cliFlags['api-url'] ?? env('FLAGSMITH_API_URL', 'http://flagsmith:8000/api/v1/');
const serverKey = () => cliFlags['server-key'] ?? env('TURNOUT_SERVER_KEY');
const configPath = () => env('TURNOUT_CONFIG', 'turnout.config.yml');
const github = () =>
  process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY ? { token: process.env.GITHUB_TOKEN, repository: process.env.GITHUB_REPOSITORY } : undefined;

// The Organisation API key: a flag, the environment, or typed in (not echoed, never stored).
let adminKeyCache: string | undefined;
async function adminKey(): Promise<string> {
  adminKeyCache ??= cliFlags['admin-key'] ?? process.env.TURNOUT_ADMIN_KEY ?? (await promptSecret('Flagsmith Organisation API key: '));
  if (!adminKeyCache) {
    console.error('turnout: an Organisation API key is needed: --admin-key, TURNOUT_ADMIN_KEY, or run in a terminal to be asked');
    process.exit(1);
  }
  return adminKeyCache;
}

function promptSecret(question: string): Promise<string | undefined> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return Promise.resolve(undefined);
  process.stdout.write(question);
  return new Promise((resolve) => {
    let typed = '';
    stdin.setRawMode(true);
    stdin.resume();
    const onData = (data: Buffer) => {
      for (const ch of data.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(typed.trim() || undefined);
        }
        if (ch === '\u0003') process.exit(130);
        typed = ch === '\u007f' || ch === '\b' ? typed.slice(0, -1) : typed + ch;
      }
    };
    stdin.on('data', onData);
  });
}

const adminApi = async () => new AdminClient(apiUrl(), { apiKey: await adminKey() });
const envKey = () => parseExperimentRef(env('TURNOUT_EXPERIMENT')).envKey;

// An explicit experiment link wins; otherwise the flag's latest experiment.
const experiments = async (): Promise<Experiments> =>
  positionals[0]
    ? new Experiments(await adminApi(), parseExperimentRef(positionals[0]))
    : latestExperiment(await adminApi(), envKey(), loadConfig(configPath()).flag);

// The live release, kept across restarts so a cold start without Flagsmith serves the right one.
function fileMemory(dir: string): ReleaseMemory {
  const file = join(dir, 'live-release');
  return {
    load: () => (existsSync(file) ? readFileSync(file, 'utf8').trim() || undefined : undefined),
    save: (release) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, `${release}\n`);
    },
  };
}

async function proxy(): Promise<void> {
  const config = loadConfig(configPath());
  const flags = createFlagSource({
    apiUrl: apiUrl(),
    serverKey: serverKey(),
    flag: config.flag,
    onUndelivered: (r) => console.warn(`turnout: event ${r.event} not accepted by Flagsmith: ${r.status} (HTTP ${r.httpStatus})${r.error ? ` ${r.error}` : ''}`),
  });
  const port = Number(env('PORT', '8080'));
  const feedPort = Number(env('FEED_PORT', '8081'));
  const feed = new TrafficFeed();
  const previewToken = process.env.TURNOUT_PREVIEW_TOKEN || undefined;
  const server = createProxy({
    config,
    flags,
    receipts: flags.receipts,
    onTraffic: (e) => feed.publish(e),
    memory: fileMemory(STATE_DIR),
    secureCookies: process.env.TURNOUT_SECURE_COOKIES === '1',
    log: process.env.TURNOUT_ACCESS_LOG === '0' ? () => {} : undefined,
    ...(previewToken ? { previewToken, debugToken: previewToken } : {}),
  } as Parameters<typeof createProxy>[0]);
  const feedServer = createFeedServer(feed);
  server.listen(port, () => console.log(`turnout proxy on :${port}, routing flag "${config.flag}" across ${[...config.releases.keys()].join(', ')}`));
  feedServer.listen(feedPort, () => console.log(`traffic feed on :${feedPort} (internal)`));

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    feedServer.close();
    // Flush buffered events, but never hang a deploy on an unreachable Flagsmith.
    await Promise.race([flags.close(), new Promise((r) => setTimeout(r, 12_000))]);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

async function demo(): Promise<void> {
  // Every option is checked before any traffic is sent.
  const rates: Record<string, number> = { control: 0.1, v2: 0.13 };
  for (const r of cliFlags.rate ?? []) {
    const [key, value, ...rest] = r.split('=');
    const rate = value === undefined || value.trim() === '' ? Number.NaN : Number(value);
    if (!key || rest.length || !(rate >= 0 && rate <= 1)) throw new Error(`--rate expects <variant>=<0..1>, got "${r}"`);
    rates[key] = rate;
  }
  const target = cliFlags.target ?? process.env.TURNOUT_PROXY_URL ?? 'http://turnout:8080';
  if (!URL.canParse(target) || !['http:', 'https:'].includes(new URL(target).protocol)) throw new Error(`--target expects the proxy's http(s) URL, got "${target}"`);
  const visitors = wholeNumber('visitors', 2000, 1, 1_000_000);
  const concurrency = wholeNumber('concurrency', 20, 1, 1000);
  const seed = wholeNumber('seed', 42, 0, 2 ** 32 - 1);
  console.log(`Simulating ${visitors} labelled visitors through ${target}`);
  console.log(`True conversion rates (inputs, not evidence): ${Object.entries(rates).map(([k, v]) => `${k} ${+(v * 100).toFixed(2)}%`).join(', ')}`);
  const debugToken = process.env.TURNOUT_PREVIEW_TOKEN;
  const config = loadConfig(configPath());
  const flow = cliFlags.flow ?? ([...config.releases.keys()].every((l) => l.startsWith('shop:')) ? 'shop' : 'goal');
  if (flow !== 'shop' && flow !== 'goal') throw new Error(`--flow expects shop or goal, got "${flow}"`);
  const goalRule = config.goal.when;
  if (flow === 'goal' && !goalRule) throw new Error('--flow goal needs goal.when in the config: the success request to send (a header-only goal has none)');
  console.log(`Flow: ${flow === 'shop' ? 'the demo shop (browse, cart, checkout)' : `land on /, then ${goalRule!.method} ${goalRule!.path}`}`);
  const report = await simulate({
    target,
    visitors,
    rates,
    concurrency,
    seed,
    ...(flow === 'goal' && goalRule ? { goal: goalRule } : {}),
    ...(debugToken ? { debugToken } : {}),
  });
  console.log(`\nDone in ${(report.durationMs / 1000).toFixed(1)} s`);
  for (const [variant, v] of Object.entries(report.byVariant)) {
    console.log(`  ${variant}: ${v.visitors} visitors, ${v.orders} conversions (${((v.orders / v.visitors) * 100).toFixed(1)}%), ${v.pageErrors} page errors`);
  }
  console.log(`  by release: ${Object.entries(report.byRelease).map(([r, v]) => `${r} ${v.visitors}`).join(', ')}`);
  if (report.failedOrders) console.log(`  ${report.failedOrders} orders failed`);
  console.log('\nThe proxy sends events to Flagsmith every 2 s. Wait a few seconds, then run: turnout status --refresh');
}

// What doctor reads. Inside Compose the services have their own names; with --api-url on localhost (outside
// Docker) the published ports. `self`: the console is asking, so it doesn't check itself over HTTP.
function doctorOptions(self = false): DoctorOptions {
  const api = apiUrl();
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(api).hostname);
  // 127.0.0.1, not localhost: Compose publishes on 127.0.0.1 only, and on Windows localhost first waits on ::1.
  const at = (port: number, service: string) => `http://${local ? '127.0.0.1' : service}:${port}`;
  return {
    apiUrl: api,
    config: loadConfig(configPath()),
    adminKey: cliFlags['admin-key'] ?? (process.env.TURNOUT_ADMIN_KEY || undefined),
    serverKey: cliFlags['server-key'] ?? (process.env.TURNOUT_SERVER_KEY || undefined),
    experimentRef: process.env.TURNOUT_EXPERIMENT || undefined,
    previewToken: process.env.TURNOUT_PREVIEW_TOKEN || undefined,
    healthWebhook: process.env.TURNOUT_HEALTH_WEBHOOK || undefined,
    proxyUrl: (local ? undefined : process.env.TURNOUT_PROXY_URL) || at(8080, 'turnout'),
    consoleUrl: self ? undefined : process.env.TURNOUT_CONSOLE_URL || at(8090, 'console'),
    // Your own Flagsmith (not the bundled "flagsmith" service): its metrics port is yours to publish, so it's read
    // only when FLAGSMITH_METRICS_URL names it.
    metricsUrl:
      (local ? undefined : process.env.FLAGSMITH_METRICS_URL) ||
      (local || new URL(api).hostname === 'flagsmith' ? `${at(9100, 'flagsmith')}/metrics` : undefined),
    fromHost: local, // Compose doesn't publish 9100: an unreadable counter is skipped, not a warning
    stateDir: STATE_DIR, // Ship and Revert write here (the console's own copy when the console is asking)
    // init and release write .env; the console doesn't mount it, and a missing one is created by init.
    envFile: !self && existsSync(ENV_FILE) ? ENV_FILE : undefined,
    // Server mode (TURNOUT_MODE=server in .env): HTTPS, Secure cookies, private ports, secrets, restart policies.
    ...(!self && modeOf(process.env) === 'server'
      ? {
          server: {
            hostname: process.env.TURNOUT_HOSTNAME ?? '',
            tls: /internal/.test(process.env.TURNOUT_CADDY_TLS ?? '') ? ('internal' as const) : ('public' as const),
            edgeAddress: process.env.TURNOUT_EDGE_ADDRESS || undefined,
            env: process.env,
            restartPolicies: process.env.TURNOUT_RESTART_POLICIES || undefined,
          },
        }
      : {}),
  };
}

const decision = () => ({
  yes: cliFlags.yes ?? false,
  acceptLosingGuardrails: cliFlags['accept-losing-guardrails'] ?? false,
  snapshotDir: SNAPSHOTS,
  ledgerDir: STATE_DIR,
  ...(github() ? { github: github()! } : {}),
});

const commands: Record<string, () => Promise<void>> = {
  proxy,
  demo,
  check: async () => {
    // The admin key is optional here and never asked for: check runs in CI with only a server key.
    const adminKeyGiven = cliFlags['admin-key'] ?? (process.env.TURNOUT_ADMIN_KEY || undefined);
    const leftovers = await check({ apiUrl: apiUrl(), serverKey: serverKey(), adminKey: adminKeyGiven });
    process.exitCode = leftovers > 0 ? 1 : 0;
  },
  doctor: async () => {
    const options = doctorOptions();
    const report = await runDoctor(options);
    if (cliFlags.json) console.log(JSON.stringify(report, null, 2));
    else for (const line of [`Turnout doctor: Flagsmith at ${options.apiUrl}, proxy at ${options.proxyUrl}`, ...formatReport(report)]) console.log(line);
    process.exitCode = report.summary.fail > 0 ? 1 : 0;
  },
  // Server mode's start-up refusal: turnout.sh / turnout.bat run it before starting anything public.
  'server-check': async () => {
    const problems = serverSecretProblems(process.env, cliFlags['after-init'] ?? false);
    for (const p of problems) console.error(`  ${p.name}: ${p.problem}`);
    if (problems.length) throw new Error(`server mode refuses to start: ${problems.length} setting${problems.length === 1 ? '' : 's'} above (values are never shown)`);
    console.log('Server mode: no placeholder secrets or tokens.');
  },
  'code-refs': async () => {
    // The project: --project, TURNOUT_PROJECT_ID, or the environment in TURNOUT_EXPERIMENT.
    const api = await adminApi();
    const given = cliFlags.project ?? (process.env.TURNOUT_PROJECT_ID || undefined);
    if (!given && !process.env.TURNOUT_EXPERIMENT) throw new Error('name the Flagsmith project: --project <id>, TURNOUT_PROJECT_ID, or run init first');
    const projectId = given ? Number(given) : (await api.get<{ project: number }>(`/api/v1/environments/${envKey()}/`)).project;
    if (!Number.isInteger(projectId) || projectId <= 0) throw new Error(`--project expects a Flagsmith project id, got "${given}"`);
    await scanAndSubmit({ api, projectId, flags: [loadConfig(configPath()).flag], root: process.cwd() });
  },
  status: async () => status({ experiments: await experiments(), refresh: cliFlags.refresh ?? false }),
  ship: async () => ship({ experiments: await experiments(), ...(cliFlags.winner ? { winner: cliFlags.winner } : {}), ...decision() }),
  revert: async () => revert({ experiments: await experiments(), ...decision() }),
  release: async () => {
    const label = positionals[0];
    const aa = cliFlags.aa === true || cliFlags['against-itself'] === true;
    if (!label && !aa) throw new Error('Usage: turnout release <release label> [--hypothesis "…"] [--split <1-99>], or turnout release --aa');
    const split = splitOption();
    const mde = positiveOption('mde', 1000);
    const dailyVisitors = positiveOption('daily-visitors', 1e9);
    const config = loadConfig(configPath());
    const { experimentId } = await release({
      ...(split !== undefined ? { split } : {}),
      ...(mde !== undefined ? { mde } : {}),
      ...(dailyVisitors !== undefined ? { dailyVisitors } : {}),
      aa,
      apiUrl: apiUrl(),
      adminKey: await adminKey(),
      envKey: envKey(),
      flag: config.flag,
      releases: new Set(config.releases.keys()),
      newRelease: label ?? '',
      hypothesis: cliFlags.hypothesis ?? defaultHypothesis(label ?? '', config.goal.event),
    });
    writeEnv(ENV_FILE, { TURNOUT_EXPERIMENT: `${envKey()}/${experimentId}` });
  },
  preview: async () => {
    const label = positionals[0];
    if (!label) throw new Error('Usage: turnout preview <release label>');
    const config = loadConfig(configPath());
    await preview({
      apiUrl: apiUrl(),
      adminKey: await adminKey(),
      envKey: envKey(),
      flag: config.flag,
      releases: new Set(config.releases.keys()),
      newRelease: label,
    });
  },
  console: async () => {
    const port = Number(env('CONSOLE_PORT', '8090'));
    const key = await adminKey();
    const hosts = process.env.TURNOUT_CONSOLE_HOSTS?.split(',').map((h) => h.trim()).filter(Boolean);
    const judgeToken = process.env.TURNOUT_JUDGE_TOKEN || undefined;
    const config = loadConfig(configPath());
    const previewToken = process.env.TURNOUT_PREVIEW_TOKEN || undefined;
    const consoleServerKey = process.env.TURNOUT_SERVER_KEY || undefined;
    const judge = {
      flag: config.flag,
      releases: [...config.releases.keys()],
      goal: config.goal.event,
      apiUrl: apiUrl(),
      adminKey: key,
      proxyUrl: process.env.TURNOUT_PROXY_URL || 'http://turnout:8080',
      shopUrl: process.env.TURNOUT_PUBLIC_SHOP_URL || 'http://127.0.0.1:8080',
      dashboardUrl: process.env.FLAGSMITH_DASHBOARD_URL || 'http://127.0.0.1:8000',
      rates: parseRates(process.env.TURNOUT_DEMO_RATES || DEFAULT_RATES),
      ...(Number(process.env.TURNOUT_DEMO_CONCURRENCY) >= 1 ? { concurrency: Math.min(200, Math.floor(Number(process.env.TURNOUT_DEMO_CONCURRENCY))) } : {}),
      ...(previewToken ? { previewToken } : {}),
      ...(consoleServerKey ? { serverKey: consoleServerKey } : {}),
    };
    const latest = () => latestExperiment(new AdminClient(apiUrl(), { apiKey: key }), envKey(), loadConfig(configPath()).flag);
    // The Feature Health bridge and the guard share the console's lock, so they never act during a Ship or a job.
    const lock = { busy: false };
    const healthWebhookUrl = process.env.TURNOUT_HEALTH_WEBHOOK || undefined;
    const guardOn = process.env.TURNOUT_GUARD === 'revert';
    let watcher: Watcher | undefined;
    if (healthWebhookUrl || guardOn || process.env.TURNOUT_GUARD === 'off') {
      const environment = await new AdminClient(apiUrl(), { apiKey: key }).get<{ name: string; project: number }>(`/api/v1/environments/${envKey()}/`);
      const dashboard = judge.dashboardUrl.replace(/\/$/, '');
      watcher = new Watcher({
        experiments: latest,
        flag: config.flag,
        environmentName: environment.name,
        ...(healthWebhookUrl ? { healthWebhookUrl } : {}),
        guard: { enabled: guardOn, threshold: Number(process.env.TURNOUT_GUARD_THRESHOLD || DEFAULT_GUARD_THRESHOLD) },
        lock,
        revert: async (exps, reason) => {
          await decide({
            experiments: exps,
            action: 'revert',
            acceptLosingGuardrails: true,
            snapshotDir: SNAPSHOTS,
            ledgerDir: STATE_DIR,
            ...(github() ? { github: github()! } : {}),
            by: 'guard',
            guardReason: reason,
          });
        },
        links: (e) => [
          { title: "Flagsmith's results page", url: `${dashboard}/project/${environment.project}/environment/${envKey()}/experiments/${e.id}` },
          { title: 'Turnout judge mode', url: `http://${localHost(process.env)}:${port}/judge` },
        ],
        log: (line) => console.log(line),
      });
      watcher.start();
    }
    const autopilot = process.env.CONSOLE_PUBLIC_PORT ? autopilotFromEnv(process.env) : null;
    if (autopilot) console.log('autopilot on: the judge story runs by itself (TURNOUT_AUTOPILOT=on)');
    const server = createConsole({
      experiments: latest,
      lock,
      ...(watcher ? { watcher } : {}),
      feedUrl: env('TURNOUT_FEED_URL', 'http://turnout:8081'),
      ...(process.env.FLAGSMITH_METRICS_URL ? { metricsUrl: process.env.FLAGSMITH_METRICS_URL } : {}),
      snapshotDir: SNAPSHOTS,
      ledgerDir: STATE_DIR,
      ...(github() ? { github: github()! } : {}),
      ...(hosts?.length ? { allowedHosts: hosts } : {}),
      ...(judgeToken ? { judgeToken } : {}),
      judge,
      ...(process.env.FLAGSMITH_ADMIN_EMAIL
        ? { flagsmithLogin: { email: process.env.FLAGSMITH_ADMIN_EMAIL, ...(process.env.FLAGSMITH_ADMIN_PASSWORD ? { password: process.env.FLAGSMITH_ADMIN_PASSWORD } : {}) } }
        : {}),
      doctor: () => runDoctor({ ...doctorOptions(true), adminKey: key }), // GET /api/doctor and the /setup page
      uiDir: fileURLToPath(new URL('./console/ui/', import.meta.url)),
      site: {
        url: process.env.TURNOUT_PUBLIC_SHOP_URL || 'http://127.0.0.1:8080',
        dashboardUrl: process.env.FLAGSMITH_DASHBOARD_URL || 'http://127.0.0.1:8000',
        goal: describeGoal(config.goal),
      },
      // Server mode only: the public view is read-only, so the story runs by itself (compose.server.yml sets it).
      ...(autopilot ? { autopilot } : {}),
    });
    // Loopback only, unless Compose publishes it (and binds the published port to 127.0.0.1 itself).
    const host = process.env.CONSOLE_HOST ?? '127.0.0.1';
    // Other devices: a second port, where every request needs the judge cookie and never gets the admin password.
    // Compose publishes it on TURNOUT_PUBLISH_HOST and the main port on 127.0.0.1 only. Unset: no second port.
    const devicePort = process.env.CONSOLE_DEVICE_PORT ? Number(process.env.CONSOLE_DEVICE_PORT) : undefined;
    server.listen(port, host, () => {
      const here = localHost(process.env);
      console.log(`turnout console on ${host}:${port} (open http://${here}:${port})`);
      // The same links init prints: the key link only once other devices are set up (logs are kept).
      for (const line of judgeLinks(judgeToken ?? '', process.env)) console.log(line);
    });
    if (devicePort !== undefined) {
      const devices = listenForOtherDevices(server, devicePort, host, () => {
        const at = devices.address();
        console.log(`other devices (judge link only) on ${host}:${typeof at === 'object' && at ? at.port : devicePort}`);
      });
    }
    // Server mode: the read-only judge view, for Caddy only (compose.server.yml never publishes this port). Unset: none.
    const publicPort = process.env.CONSOLE_PUBLIC_PORT ? Number(process.env.CONSOLE_PUBLIC_PORT) : undefined;
    if (publicPort !== undefined) {
      listenForPublic(server, publicPort, host, () => console.log(`read-only judge view (server mode, behind Caddy) on ${host}:${publicPort}`));
    }
  },
  init: () => {
    const project = cliFlags.project ?? (process.env.TURNOUT_PROJECT || undefined);
    const environment = cliFlags.environment ?? (process.env.TURNOUT_ENVIRONMENT || undefined);
    if (environment && !project) throw new Error('--environment needs --project: the project it belongs to');
    return init({
      apiUrl: apiUrl(),
      dashboardUrl: process.env.FLAGSMITH_DASHBOARD_URL || 'http://127.0.0.1:8000',
      config: loadConfig(configPath()),
      adminKey: cliFlags['admin-key'] ?? (process.env.TURNOUT_ADMIN_KEY || undefined),
      serverKey: process.env.TURNOUT_SERVER_KEY || undefined,
      envFile: ENV_FILE,
      project,
      environment,
      // Code References scan this checkout: the demo's, not yours.
      ...(project ? {} : { codeReferences: { root: process.cwd() } }),
    });
  },
  new: newCommand,
};

// turnout new: each question has a default and a flag; in a terminal (without --yes) it asks, otherwise it doesn't.
async function newCommand(): Promise<void> {
  const ask = process.stdin.isTTY && !cliFlags.yes ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const q = async (question: string, fallback: string, given?: string): Promise<string> => {
    if (given !== undefined || !ask) return given ?? fallback;
    return (await ask.question(`${question} [${fallback}] `)).trim() || fallback;
  };
  try {
    const flagsmith = await q('1/4 Flagsmith: "bundled" (a fresh one next to your app) or your API URL (…/api/v1/)?', 'bundled', cliFlags.flagsmith);
    let project = cliFlags.project;
    let environment = cliFlags.environment;
    if (flagsmith !== 'bundled') {
      project = await q('    Your Flagsmith project (name or id)?', '', project);
      environment = (await q('    Environment (name or key; blank: Production or the only one)?', '', environment)) || undefined;
      if (!project) throw new Error('an existing Flagsmith needs --project: the project Turnout may add its flag to');
    }
    const releases = cliFlags.release ?? (await q('2/4 Releases, live first (label=url, url or image; space-separated)?', DEFAULT_RELEASES.join(' '))).split(/\s+/).filter(Boolean);
    const success = await q('3/4 Success: which request counts as a conversion? (or "header <event>": your app sends X-Turnout-Event: <event>; "none": judge on page speed only)', DEFAULT_SUCCESS, cliFlags.success);
    const traffic = Number(await q('4/4 Traffic: % of visitors in the experiment?', '100', cliFlags.traffic));
    const num = (raw: string | undefined, what: string) => {
      if (raw === undefined) return undefined;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`--${what} expects a port number, got "${raw}"`);
      return n;
    };
    const answers: NewAnswers = {
      flagsmith,
      releases,
      success,
      traffic,
      flag: cliFlags.flag,
      event: cliFlags.event,
      appPort: num(cliFlags.port, 'port'),
      proxyPort: num(cliFlags['proxy-port'], 'proxy-port'),
      consolePort: num(cliFlags['console-port'], 'console-port'),
      flagsmithPort: num(cliFlags['flagsmith-port'], 'flagsmith-port'),
      appEnvFile: cliFlags['app-env-file'],
      image: cliFlags.image,
      project: project || undefined,
      environment,
    };
    writeNew({
      answers,
      dir: cliFlags.dir ?? process.cwd(),
      force: cliFlags.force ?? false,
      adminKey: flagsmith === 'bundled' ? undefined : cliFlags['admin-key'],
      flagsmithCompose: readFileIfExists(fileURLToPath(new URL('../compose.flagsmith.yml', import.meta.url))),
    });
  } finally {
    ask?.close();
  }
}

const command = name ? commands[name] : undefined;
if (!command || cliFlags.help) {
  console.log(USAGE);
  process.exit(name && name !== 'help' && !cliFlags.help ? 1 : 0);
}
try {
  await command();
} catch (error) {
  // fetch() says only "fetch failed"; the reason (ECONNREFUSED, ENOTFOUND…) is in its cause.
  const e = error as Error & { cause?: { code?: string; message?: string } };
  const why = e.cause?.code ?? e.cause?.message;
  console.error(`turnout ${name}: ${e.message}${why && !e.message.includes(why) ? ` (${why})` : ''}`);
  process.exit(1);
}
