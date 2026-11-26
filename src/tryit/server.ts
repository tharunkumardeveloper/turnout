// "Try it with your app" (local only): Turnout on one, two or three versions of YOUR app, from the console.
//   1. You give each version as a Dockerfile (self-contained: COPY needs files, so use a git repo for those), a public
//      git repository (Docker builds straight from its URL) or an image name.
//   2. This service builds or pulls them over the Docker socket and runs each as a container on a private network
//      (try-a, try-b, try-c), memory-capped.
//   3. They go behind a Turnout proxy of their own (port 8085) on a flag of their own, tryit_release, in the same
//      Flagsmith environment, so the demo's flag is never touched. One version makes an A/A test (the same app on both
//      sides), two an A/B test, three an A/B/C test.
//   4. Judge mode's jobs run on it (start, simulated visitors, ask Flagsmith, decide), with the explorer simulator
//      (simulate-any.ts) instead of the demo shop's. The console serves judge mode's page for it at /try.
// It needs the Docker socket, which is root on the host: compose.turnout.yml starts it only in local mode, and the
// console exposes its API only to this machine.
import http from 'node:http';
import { hostname } from 'node:os';
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { parseConfig, type Config } from '../config.ts';
import { init as runInit } from '../commands/init.ts';
import { parseSuccess } from '../commands/new.ts';
import { simulateAny } from '../commands/simulate-any.ts';
import { createJudge, type Judge, type JudgeOptions } from '../console/judge.ts';
import { createConsole } from '../console/server.ts';
import { describeGoal } from '../config.ts';
import { AdminClient } from '../flagsmith/admin.ts';
import { latestExperiment } from '../flagsmith/experiments.ts';
import { createFlagSource } from '../flagsmith/flag-source.ts';
import { pinnable, readPin, setPin } from '../flagsmith/pins.ts';
import { createProxy, readCookie } from '../proxy/server.ts';
import { TrafficFeed } from '../proxy/feed.ts';
import type { Docker } from './docker.ts';

export const TRY_FLAG = 'tryit_release';
export const SLOTS = ['a', 'b', 'c'] as const;
export const NETWORK = 'turnout-try';
const LABELS = SLOTS.map((s) => `try:${s}`);

// folder: an uploaded project folder (value: its upload id; dockerfile: which Dockerfile in it, default "Dockerfile").
// imagefile: an uploaded image file, as docker save writes it (value: its upload id).
export type VersionSource = { kind: 'dockerfile' | 'git' | 'image' | 'folder' | 'imagefile'; value: string; port?: number; name?: string; dockerfile?: string };
export const UPLOAD_ID = /^[a-f0-9]{24}$/;
export const MAX_UPLOAD = 2 * 1024 ** 3;
export type BuildRequest = { versions: VersionSource[]; goal?: string; rates?: number[]; env?: string };
type Stage = { title: string; status: 'todo' | 'running' | 'done' | 'failed'; detail?: string };
/** One line of the build log: when, from whom (a version's letter, or Turnout / Flagsmith), how it reads. */
export type LogLine = { at: string; from: string; level: 'info' | 'step' | 'ok' | 'error'; text: string };

/** Docker's output as log lines: colour codes and carriage-return progress bars removed, one entry per line. */
export function cleanLines(text: string): string[] {
  return text
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^.*\r/, '').trimEnd())
    .filter((l) => l.trim());
}

export type BuildState = {
  status: 'idle' | 'building' | 'ready' | 'failed';
  kind: string | null; // "A/A", "A/B", "A/B/C"
  versions: { slot: string; label: string; name: string; source: VersionSource['kind']; port: number | null; stages: Stage[] }[];
  log: LogLine[];
  error: string | null;
  shop: string; // the try proxy, for previews and "be a visitor"
  goal: string | null;
};

/** Checks one version's source; the error says what to change. */
export function checkSource(v: VersionSource): string | null {
  const value = String(v.value ?? '').trim();
  if (!value) return 'is empty';
  if (v.kind === 'dockerfile') {
    if (!/^\s*FROM\s+\S+/im.test(value)) return 'has no FROM line: a Dockerfile starts from an image';
    return needsFolder(value) ? 'is a Dockerfile that copies files from your project (COPY or ADD), but a pasted Dockerfile arrives alone. Press "Choose project folder" and pick the folder it lives in instead: Turnout sends the folder with it' : null;
  }
  if (v.kind === 'folder') {
    if (!UPLOAD_ID.test(value)) return 'has an unknown upload';
    return /^[\w./ -]{1,200}$/.test(v.dockerfile ?? 'Dockerfile') && !(v.dockerfile ?? '').includes('..') ? null : 'names a Dockerfile Turnout cannot use';
  }
  if (v.kind === 'imagefile') return UPLOAD_ID.test(value) ? null : 'has an unknown upload';
  if (v.kind === 'git') return /^(https:\/\/|git@)[\w.@:/~-]+?(\.git)?(#[\w./:-]*)?$/.test(value) ? null : 'should be a public git URL, such as https://github.com/you/app.git (optionally #branch:folder)';
  if (v.kind === 'image') return /^[\w.\-/:@]+$/.test(value) ? null : 'should be an image name, such as nginx:alpine';
  return 'has an unknown kind';
}

/** True when a Dockerfile copies files from its build context (COPY/ADD of local paths, not --from another stage or a URL). */
export function needsFolder(dockerfile: string): boolean {
  return dockerfile.split(/\r?\n/).some((line) => {
    const m = line.match(/^\s*(COPY|ADD)\s+(.*)$/i);
    if (!m) return false;
    const args = m[2]!.trim();
    if (/--from=/i.test(args)) return false;
    const src = args.replace(/--\S+\s*/g, '').trim().replace(/^\[\s*"?/, '').split(/[\s",]+/)[0] ?? '';
    return !/^https?:\/\//i.test(src);
  });
}

/** "KEY=value" lines (your app's settings) → Docker's Env list; blank lines and # comments skipped. */
export function parseEnv(text: string | undefined): string[] {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && /^[A-Za-z_][A-Za-z0-9_]*=/.test(l))
    .slice(0, 100);
}

/** "A/A" for one version, "A/B" for two, "A/B/C" for three. */
/** Without a branch Docker fetches "master", which many repositories don't have: HEAD is the repository's default. */
export function defaultBranch(url: string): string {
  const u = url.trim();
  if (!u.includes('#')) return `${u}#HEAD`;
  return u.replace('#:', '#HEAD:');
}

/** Docker's answer when a repository can't be built, said so a person knows what to add. */
export function gitBuildError(message: string): string {
  if (/locate specified Dockerfile|Dockerfile.*no such file|failed to read dockerfile/i.test(message)) {
    return 'this repository has no Dockerfile at its root (or at the folder after the colon in repo.git#branch:folder). Turnout runs any app that has a working Dockerfile: add one to the repository, or build the image yourself and paste its name instead.';
  }
  if (/COPY with more than one source file/i.test(message)) return `the repository's own Dockerfile has a mistake: ${message.trim()} (a COPY of several files must end its destination with /, e.g. COPY a b /app/). Fix that line in the repository; the build log shows which step.`;
  if (/couldn't find remote ref/i.test(message)) return `that branch doesn't exist in the repository (${message.trim()}). Leave the branch out to use the repository's default one.`;
  if (/repository not found|could not read Username|authentication|not found/i.test(message)) {
    return `Docker couldn't fetch the repository (${message}). It must be a public git URL.`;
  }
  return message;
}

export const kindFor = (n: number) => (n <= 1 ? 'A/A' : 'ABC'.slice(0, n).split('').join('/'));

/** Display names: the image, the repository or "Dockerfile 2"; an A/A test's copy is "(copy)". */
export function namesFor(versions: VersionSource[]): Record<string, string> {
  const name = (v: VersionSource, i: number) =>
    v.name?.trim() || (v.kind === 'image' ? v.value.trim() : v.kind === 'git' ? v.value.trim().replace(/^.*\/([^/#]+?)(\.git)?(#.*)?$/, '$1') : v.kind === 'folder' ? `Folder ${i + 1}` : v.kind === 'imagefile' ? `Image file ${i + 1}` : `Dockerfile ${i + 1}`);
  const out: Record<string, string> = {};
  versions.forEach((v, i) => (out[LABELS[i]!] = name(v, i)));
  if (versions.length === 1) out[LABELS[1]!] = `${out[LABELS[0]!]} (copy)`;
  return out;
}

export type TryitOptions = {
  docker: Docker;
  apiUrl: string;
  adminKey: string;
  serverKey: string;
  envKey: string;
  dashboardUrl: string;
  publicShop: string; // the proxy as the browser reaches it, e.g. http://127.0.0.1:8085
  proxyPort: number;
  apiPort: number;
  consolePort?: number; // your app's console (the main console shows it at /app); unset: none
  uiDir?: string;
  stateDir: string;
  log?: (line: string) => void;
};

export function startTryit(o: TryitOptions) {
  const log = o.log ?? ((l: string) => console.log(l));
  const debugToken = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  mkdirSync(o.stateDir, { recursive: true });
  const api = new AdminClient(o.apiUrl, { apiKey: o.adminKey });
  const feed = new TrafficFeed();
  const flags = createFlagSource({ apiUrl: o.apiUrl, serverKey: o.serverKey, flag: TRY_FLAG });
  const lock = { busy: false };
  let judge: Judge | null = null;
  let proxyServer: http.Server | null = null;
  let appConsole: http.Server | null = null;
  let rates: Record<string, number> = {};
  let names: Record<string, string> = {};
  const state: BuildState = { status: 'idle', kind: null, versions: [], log: [], error: null, shop: o.publicShop, goal: null };
  // Uploads (a project folder as a tar, or an image file): kept in the state folder, the newest 6, so a few builds
  // can reuse them; the rest are removed.
  const uploads = join(o.stateDir, 'uploads');
  mkdirSync(uploads, { recursive: true });
  const uploadPath = (id: string) => {
    const file = join(uploads, `${id}.tar`);
    if (!UPLOAD_ID.test(id) || !existsSync(file)) throw new Error('an upload is gone (Try it restarted?): choose the folder or file again');
    return file;
  };
  function pruneUploads() {
    const files = readdirSync(uploads).map((f) => ({ f, t: statSync(join(uploads, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(6)) rmSync(join(uploads, f), { force: true });
  }
  async function receiveUpload(req: http.IncomingMessage): Promise<{ id: string; size: number }> {
    const id = randomBytes(12).toString('hex');
    const file = join(uploads, `${id}.tar`);
    let size = 0;
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(file);
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_UPLOAD) req.destroy(new Error('too large: up to 2 GB'));
      });
      req.on('error', (e) => (out.destroy(), reject(e)));
      out.on('error', reject);
      out.on('finish', () => resolve());
      req.pipe(out);
    }).catch((error) => {
      rmSync(file, { force: true });
      throw error;
    });
    pruneUploads();
    return { id, size };
  }
  const note = (text: string, from = 'Turnout', level: LogLine['level'] = 'info') => {
    for (const line of cleanLines(text)) state.log.push({ at: new Date().toISOString(), from, level, text: line.slice(0, 4000) });
    if (state.log.length > 600) state.log.splice(0, state.log.length - 600);
  };

  // The proxy for the built versions: rebuilt after each build, on the same port.
  async function serveProxy(config: Config): Promise<void> {
    if (proxyServer) {
      const old = proxyServer;
      proxyServer = null;
      old.closeAllConnections?.();
      await new Promise<void>((r) => old.close(() => r()));
    }
    const server = createProxy({ config, flags, receipts: flags.receipts, onTraffic: (e) => feed.publish(e), viewSwitch: true, previewToken: debugToken, debugToken, log: () => {} } as Parameters<typeof createProxy>[0]);
    await new Promise<void>((r) => server.listen(o.proxyPort, '0.0.0.0', () => r()));
    proxyServer = server;
  }

  // Your app's console: rebuilt after each build (new versions, new goal), on the same port, inside Docker's network.
  async function serveConsole(judgeOptions: JudgeOptions, goal: string | null): Promise<void> {
    if (appConsole) {
      const old = appConsole;
      appConsole = null;
      old.closeAllConnections?.();
      await new Promise<void>((r) => old.close(() => r()));
    }
    const server = createConsole({
      experiments: () => latestExperiment(api, o.envKey, TRY_FLAG),
      feedUrl: `http://127.0.0.1:${o.apiPort}/feed`,
      readEvents: async () => ({ accepted: flags.receipts.batches.events, rejected: 0 }),
      snapshotDir: join(o.stateDir, 'snapshots'),
      ledgerDir: o.stateDir,
      uiDir: o.uiDir!,
      judge: judgeOptions,
      judgePage: false,
      lock,
      site: { url: o.publicShop, dashboardUrl: o.dashboardUrl, goal, simulated: true },
    });
    await new Promise<void>((r) => server.listen(o.consolePort, '0.0.0.0', () => r()));
    appConsole = server;
  }

  // Waits until a container answers HTTP (any status), or gives up with its last log lines.
  async function waitUp(name: string, url: string, stage: Stage): Promise<void> {
    for (let i = 0; i < 90; i++) {
      const ok = await fetch(url, { signal: AbortSignal.timeout(2000) }).then(() => true).catch(() => false);
      if (ok) return;
      stage.detail = `waiting for it to answer (${i + 1} s)`;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`${name} didn't answer on ${url} within 90 s. Its last log lines: ${(await o.docker.logs(name)).slice(-600) || '(none)'}`);
  }

  async function build(req: BuildRequest): Promise<void> {
    const versions = req.versions.slice(0, 3);
    names = namesFor(versions);
    const releases = versions.length === 1 ? LABELS.slice(0, 2) : LABELS.slice(0, versions.length);
    rates = Object.fromEntries(releases.map((r, i) => [r, Math.min(1, Math.max(0, req.rates?.[versions.length === 1 ? 0 : i] ?? 0.1))]));
    Object.assign(state, {
      status: 'building', kind: kindFor(versions.length), error: null, log: [], goal: req.goal?.trim() || null,
      versions: versions.map((v, i) => ({
        slot: SLOTS[i]!, label: LABELS[i]!, name: names[LABELS[i]!]!, source: v.kind, port: null,
        stages: [{ title: { image: 'Pull the image', git: 'Build it from the repository', folder: `Build your folder with ${v.dockerfile || 'Dockerfile'}`, imagefile: 'Load your image file', dockerfile: 'Build the Dockerfile' }[v.kind], status: 'todo' }, { title: 'Start it', status: 'todo' }],
      })),
    } satisfies Partial<BuildState>);
    judge = null;
    try {
      await o.docker.ensureNetwork(NETWORK);
      await o.docker.connect(NETWORK, hostname());
      const upstream: Record<string, string> = {};
      for (const [i, v] of versions.entries()) {
        const slot = state.versions[i]!;
        const [get, run] = slot.stages;
        let image = v.kind === 'image' ? v.value.trim() : `turnout-try-${slot.slot}:latest`;
        get!.status = 'running';
        note(`${get!.title} (${slot.name})`, slot.slot.toUpperCase(), 'step');
        const onLog = (l: string) => {
          const last = cleanLines(l).at(-1);
          if (last) get!.detail = last.length > 90 ? `${last.slice(0, 89)}…` : last;
          note(l, slot.slot.toUpperCase());
        };
        if (v.kind === 'image') await o.docker.pull(image, onLog).catch(async (error) => {
          if (!(await o.docker.imageExists(image))) throw error; // a local-only image is fine
        });
        else if (v.kind === 'folder') await o.docker.buildFolder(image, uploadPath(v.value), v.dockerfile || 'Dockerfile', onLog).catch((error: Error) => {
          throw new Error(/locate specified Dockerfile|no such file/i.test(error.message) ? `your folder has no ${v.dockerfile || 'Dockerfile'} at its top level` : error.message);
        });
        else if (v.kind === 'imagefile') image = await o.docker.load(uploadPath(v.value), onLog);
        else if (v.kind === 'git') await o.docker.build(image, { remote: defaultBranch(v.value) }, onLog).catch((error: Error) => {
          throw new Error(`${slot.name} (version ${slot.slot.toUpperCase()}): ${gitBuildError(error.message)}`);
        });
        else await o.docker.build(image, { dockerfile: v.value }, onLog);
        get!.status = 'done';
        get!.detail = undefined;
        run!.status = 'running';
        const port = v.port || (await o.docker.exposedPort(image)) || 80;
        slot.port = port;
        const name = `turnout-try-${slot.slot}`;
        await o.docker.remove(name);
        // One version (A/A): the same container answers as try-a and try-b.
        const aliases = versions.length === 1 ? ['try-a', 'try-b'] : [`try-${slot.slot}`];
        await o.docker.run({ name, image, network: NETWORK, aliases, env: [`PORT=${port}`, ...parseEnv(req.env)] });
        await waitUp(name, `http://try-${slot.slot}:${port}/`, run!);
        run!.status = 'done';
        run!.detail = `answering on port ${port}`;
        upstream[slot.label] = `http://try-${slot.slot}:${port}`;
        note(`${slot.name} is running, answering on port ${port}`, slot.slot.toUpperCase(), 'ok');
      }
      for (const slot of SLOTS.slice(versions.length)) await o.docker.remove(`turnout-try-${slot}`);
      if (versions.length === 1) upstream[LABELS[1]!] = upstream[LABELS[0]!]!.replace('try-a', 'try-b');

      // The flag and its metrics in Flagsmith (idempotent): every slot label is a variant value, so a later build
      // with a different number of versions reuses the same flag.
      const goal = state.goal ? parseSuccess(state.goal) : null;
      const raw = {
        flag: TRY_FLAG,
        releases: Object.fromEntries(LABELS.map((l) => [l, upstream[l] ?? `http://try-${l.slice(4)}:80`])),
        ...(goal ? { goal: { event: goal.path.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').toLowerCase() || 'goal', when: goal } } : {}),
        guardrails: ['doc_latency_ms', 'server_error'],
        traffic: 100,
      };
      const initConfig = parseConfig(raw);
      note('Setting up the flag tryit_release and its metrics', 'Flagsmith', 'step');
      const env = await api.get<{ project: number }>(`/api/v1/environments/${o.envKey}/`);
      await runInit({
        apiUrl: o.apiUrl, dashboardUrl: o.dashboardUrl, config: initConfig, adminKey: o.adminKey, serverKey: o.serverKey,
        envFile: join(o.stateDir, 'init.env'), project: String(env.project), environment: o.envKey, log: (l) => note(l, 'Flagsmith'),
      });
      // The proxy routes only the versions built now.
      const config = parseConfig({ ...raw, releases: Object.fromEntries(releases.map((l) => [l, upstream[l]!])) });
      await serveProxy(config);
      const judgeOptions: JudgeOptions = {
          flag: TRY_FLAG, releases, goal: config.goal.event, apiUrl: o.apiUrl, adminKey: o.adminKey,
          proxyUrl: `http://127.0.0.1:${o.proxyPort}`, shopUrl: o.publicShop, dashboardUrl: o.dashboardUrl,
          previewToken: debugToken, serverKey: o.serverKey, rates, concurrency: 20,
          // This build's goal first, then the safety checks: a new build can bring a new goal, and a test takes the
          // metrics it is started with.
          metrics: [
            { name: config.goal.event, expected_direction: config.goal.speedOnly ? 'decrease' : 'increase' },
            ...config.guardrails.filter((g) => g !== config.goal.event).map((g) => ({ name: g, expected_direction: 'not_increase' })),
          ],
          deps: {
            // Your app isn't the demo shop: the explorer walks its own links and fills its forms (simulate-any.ts).
            simulate: async (opts) => {
              const report = await simulateAny({ target: opts.target, visitors: opts.visitors, concurrency: 20, releases, goal: config.goal.when, debugToken, rates, log: opts.log });
              const byRelease = Object.fromEntries(Object.entries(report.byRelease).map(([r, t]) => [r, { visitors: t.visitors, carts: 0, orders: t.goals, pageErrors: t.errors }]));
              return { byVariant: {}, byRelease, failedOrders: 0, durationMs: 0 };
            },
          },
        };
      judge = createJudge(
        judgeOptions,
        {
          experiments: () => latestExperiment(api, o.envKey, TRY_FLAG),
          // The proxy's own count of events sent to Flagsmith: the judge waits until it stops moving before asking
          // for results, so every visitor is counted (with null it waited a fixed 6 s and missed late ones).
          readEvents: async () => ({ accepted: flags.receipts.batches.events, rejected: 0 }),
          snapshotDir: join(o.stateDir, 'snapshots'),
          ledgerDir: o.stateDir,
          lock,
        },
      );
      // init leaves an experiment over every slot; start the one that matches what was built: 1 version → A/A,
      // 2 → A/B, 3 → A/B/C, so no visitor is ever routed to a slot with nothing behind it.
      note(`Starting the ${state.kind} test`, 'Flagsmith', 'step');
      const ran = await judge.run({ action: 'start', arms: versions.length === 1 ? 1 : versions.length });
      if (ran.status !== 202) throw new Error(`Couldn't start the ${state.kind} test: ${(ran.body as { error?: string })?.error ?? ran.status}`);
      for (let i = 0; i < 120 && judge.job()?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 500));
      if (judge.job()?.status === 'failed') throw new Error(`Couldn't start the ${state.kind} test: ${judge.job()?.error}`);
      // Your app's console: the console for tryit_release, with this build's goal, traffic and one-button runs.
      if (o.consolePort && o.uiDir) {
        await serveConsole(judgeOptions, describeGoal(config.goal));
        note("Your app's console is ready: the console shows it at /app", 'Turnout', 'ok');
      }
      state.status = 'ready';
      note(`Ready: the ${state.kind} test is running on ${Object.values(names).join(', ')}`, 'Turnout', 'ok');
    } catch (error) {
      state.status = 'failed';
      state.error = (error as Error).message;
      for (const v of state.versions) for (const s of v.stages) if (s.status === 'running') s.status = 'failed';
      note(state.error ?? 'failed', 'Turnout', 'error');
      log(`tryit: build failed: ${state.error}`);
    }
  }

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: http.IncomingMessage) =>
    new Promise<unknown>((resolve, reject) => {
      let text = '';
      req.on('data', (c) => {
        text += c;
        if (text.length > 512 * 1024) req.destroy(new Error('too large'));
      });
      req.on('end', () => {
        try {
          resolve(text ? JSON.parse(text) : {});
        } catch {
          reject(new Error('not JSON'));
        }
      });
      req.on('error', reject);
    });

  const apiServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://tryit');
      const p = url.pathname;
      if (p === '/api/try/status') return send(res, 200, { ...state, names, docker: await o.docker.ping() });
      if (p === '/api/try/upload' && req.method === 'POST') {
        if (state.status === 'building') return send(res, 409, { error: 'A build is running. Wait for it to finish.' });
        return send(res, 200, await receiveUpload(req));
      }
      if (p === '/api/try/build' && req.method === 'POST') {
        if (state.status === 'building') return send(res, 409, { error: 'A build is already running.' });
        if (lock.busy) return send(res, 409, { error: 'A test step is running. Wait for it to finish.' });
        const body = (await readBody(req)) as BuildRequest;
        const versions = Array.isArray(body.versions) ? body.versions.filter((v) => v && String(v.value ?? '').trim()) : [];
        if (!versions.length || versions.length > 3) return send(res, 400, { error: 'Give one, two or three versions.' });
        for (const [i, v] of versions.entries()) {
          const bad = checkSource(v);
          if (bad) return send(res, 400, { error: `Version ${'ABC'[i]} ${bad}.` });
        }
        if (body.goal?.trim()) {
          try {
            parseSuccess(body.goal);
          } catch (error) {
            return send(res, 400, { error: (error as Error).message });
          }
        }
        void build({ versions, goal: body.goal, rates: body.rates, env: typeof body.env === 'string' ? body.env.slice(0, 20_000) : undefined });
        return send(res, 202, { ok: true });
      }
      if (p === '/api/traffic' || p === '/feed/traffic') return feed.subscribe(res);
      // Your app's console reads the feed as the main console reads the proxy's: the stream and its summary.
      if (p === '/feed/summary') return send(res, 200, feed.summary());
      if (p === '/api/you') {
        const cookie = req.headers.cookie ?? '';
        const id = readCookie(cookie, 'tn_id');
        if (!id && !readCookie(cookie, 'tn_view')) return send(res, 200, { visited: false });
        const r = await fetch(`http://127.0.0.1:${o.proxyPort}/__turnout/receipt`, { headers: { cookie } }).catch(() => null);
        return send(res, 200, r?.ok ? { visited: true, ...((await r.json()) as object) } : { visited: Boolean(id) });
      }
      if (p === '/api/pin') {
        const identifier = readCookie(req.headers.cookie, 'tn_id');
        if (!pinnable(identifier)) return send(res, 409, { error: 'Open your app in this browser first: Turnout gives it a visitor id, and that is what gets pinned.' });
        const exps = await latestExperiment(api, o.envKey, TRY_FLAG);
        const featureId = (await exps.detail()).feature.id;
        if (req.method === 'GET') return send(res, 200, { pinned: await readPin(api, o.envKey, featureId, identifier) });
        const body = (await readBody(req)) as { release?: unknown };
        const release = body.release === null ? null : typeof body.release === 'string' && LABELS.includes(body.release) ? body.release : undefined;
        if (release === undefined) return send(res, 400, { error: 'release must be null or a try:a, try:b or try:c label' });
        return send(res, 200, { pinned: await setPin(api, o.envKey, featureId, identifier, release) });
      }
      if (p.startsWith('/api/judge/')) {
        if (!judge) return send(res, 404, { error: 'Nothing is built yet: give Turnout your versions in the console first.' });
        if (p === '/api/judge/state') return send(res, 200, { ...(await judge.state()), names, tryit: { kind: state.kind, goal: state.goal } });
        if (p === '/api/judge/job') return send(res, 200, { job: judge.job() });
        if (p === '/api/judge/run' && req.method === 'POST') {
          const ran = await judge.run(await readBody(req));
          return send(res, ran.status, ran.body);
        }
      }
      send(res, 404, { error: 'not found' });
    } catch (error) {
      if (!res.headersSent) send(res, 500, { error: (error as Error).message });
    }
  });
  apiServer.listen(o.apiPort, '0.0.0.0', () => log(`tryit: API on :${o.apiPort}, your versions through Turnout on :${o.proxyPort}`));
  return { state, apiServer, close: async () => { apiServer.close(); proxyServer?.close(); appConsole?.close(); await flags.close(); } };
}
