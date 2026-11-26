// "Try it with your app" (local only): Turnout on one, two or three versions of YOUR app, from the console.
//   1. You give each version as a Dockerfile (self-contained: COPY needs files, so use a git repo for those), a public
//      git repository (Docker builds straight from its URL) or an image name.
//   2. This service builds or pulls them over the Docker socket and runs each as a container on a private network
//      (try-a, try-b, try-c), memory-capped.
//   3. They go behind a Turnout proxy of their own (port 8085) on a flag of their own, tryit_release, in the same
//      Flagsmith environment, so the demo's flag is never touched. One version makes an A/A test (the same app on both
//      sides), two an A/B test, three an A/B/C test.
//   4. Guided demo's jobs run on it (start, simulated visitors, ask Flagsmith, decide), with the explorer simulator
//      (simulate-any.ts) instead of the demo shop's. The console serves guided demo's page for it at /try.
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
import { gitToTar, hasGit, parseGitSource } from './gitsource.ts';
import { simulateAny } from '../commands/simulate-any.ts';
import { createJudge, type Judge, type JudgeOptions } from '../console/judge.ts';
import { createConsole } from '../console/server.ts';
import { describeGoal } from '../config.ts';
import { AdminClient } from '../flagsmith/admin.ts';
import { latestExperiment } from '../flagsmith/experiments.ts';
import { createFlagSource } from '../flagsmith/flag-source.ts';
import { pinnable, readPin, setPin } from '../flagsmith/pins.ts';
import { createProxy, readCookie, type ClickEvent } from '../proxy/server.ts';
import { TrafficFeed } from '../proxy/feed.ts';
import type { Docker } from './docker.ts';
import { common, describeAction, walk } from './discover.ts';
import { ActionLog, createTrickle, visitorsNeeded } from './watch.ts';
import { compareSnapshots, fetchRemoteSnapshot } from '../flagsmith/settings-check.ts';
import { DATABASE_KINDS, databaseFor, generatedDockerfile, missingSettings, tarAppend, tarIndex, wantsDatabase, type DatabaseKind } from './autobuild.ts';
import { readFileSync } from 'node:fs';

export const TRY_FLAG = 'tryit_release';
export const SLOTS = ['a', 'b', 'c'] as const;
export const NETWORK = 'turnout-try';
const LABELS = SLOTS.map((s) => `try:${s}`);

// folder: an uploaded project folder (value: its upload id; dockerfile: which Dockerfile in it, default "Dockerfile").
// imagefile: an uploaded image file, as docker save writes it (value: its upload id).
export type VersionSource = { kind: 'dockerfile' | 'git' | 'image' | 'folder' | 'imagefile'; value: string; port?: number; name?: string; dockerfile?: string };
export const UPLOAD_ID = /^[a-f0-9]{24}$/;
export const MAX_UPLOAD = 2 * 1024 ** 3;
export type BuildRequest = { versions: VersionSource[]; goal?: string; secondary?: { action: string; rates?: number[] }[]; rates?: number[]; env?: string; database?: DatabaseKind };
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
  shop: string; // the try proxy, for "be a visitor"
  // Each version on its own address (A, B, C): straight to it, never counted. A preview through the proxy picks its
  // version per page; an app that builds its pages in the browser fetched its files from either version.
  previews: Record<string, string>;
  goal: string | null;
  // What a version that didn't start asked for: the settings its error names, and a database (one click: database).
  // What a visitor can do on every version, read off the running versions (never counted), best goal first.
  actions?: { goal: string; label: string }[];
  secondary?: { action: string; rates?: number[] }[]; // other actions counted as secondary metrics, each with its pretend rates
  goalSince?: string | null; // the goal changed mid-test: counted from then (a new experiment)
  needs?: { settings: string[]; database: DatabaseKind | null } | null;
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
  const { repo } = parseGitSource(url);
  const u = repo + (url.includes('#') ? url.slice(url.indexOf('#')) : '');
  if (!u.includes('#')) return `${u}#HEAD`;
  return u.replace('#:', '#HEAD:');
}

/** Pages a warm-up asks for: the home page and each GET goal's page ("GET /pricing*" → /pricing). */
export function warmPaths(goals: string[]): string[] {
  const pages = goals.map((g) => g.match(/^GET (\/[^\s*?#]*)/)?.[1]).filter((p): p is string => Boolean(p));
  return ['/', ...new Set(pages.filter((p) => p !== '/'))].slice(0, 5);
}

/** Up to `rounds` passes over the warm-up pages, three at a time; the median page time of the last pass, in ms. */
export async function warmUp(base: string, goals: string[], rounds = 8, fetcher: typeof fetch = fetch): Promise<number> {
  const paths = warmPaths(goals);
  let last: number[] = [];
  for (let r = 0; r < rounds; r++) {
    last = await Promise.all(
      [...paths, ...paths, ...paths].slice(0, Math.max(3, paths.length)).map(async (p) => {
        const t = performance.now();
        await fetcher(new URL(p, base), { signal: AbortSignal.timeout(5000) }).then((res) => res.arrayBuffer()).catch(() => {});
        return performance.now() - t;
      }),
    );
  }
  const sorted = last.sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0);
}

/** The home page's status and <title>, straight from the container (status 0: no answer). */
export async function homeStatus(base: string, fetcher: typeof fetch = fetch): Promise<{ status: number; title: string }> {
  try {
    const res = await fetcher(new URL('/', base), { signal: AbortSignal.timeout(5000) });
    const text = (await res.text()).slice(0, 20_000);
    return { status: res.status, title: (text.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) };
  } catch {
    return { status: 0, title: '' };
  }
}

/** A project with no Dockerfile that Turnout can't recognise: what it looked for, and what to do. */
export const UNKNOWN_PROJECT =
  "couldn't tell how to run it: there's no Dockerfile, and nothing at its top level that it recognises (package.json with a start script or an entry file, requirements.txt, go.mod, pom.xml, build.gradle, Gemfile, PHP files or HTML pages). Add a Dockerfile, or point at the app's own folder: repo.git#branch:folder.";

/** Docker's answer when a repository can't be built, said so a person knows what to add. */
export function gitBuildError(message: string): string {
  if (/locate specified Dockerfile|Dockerfile.*no such file|failed to read dockerfile/i.test(message)) {
    return 'this repository has no Dockerfile at its root (or at the folder after the colon in repo.git#branch:folder). Turnout runs any app that has a working Dockerfile: add one to the repository, or build the image yourself and paste its name instead.';
  }
  if (/returned a non-zero code/i.test(message)) return `${message.trim()}. The app's own build failed; the build log shows why. If it needs keys while it is built (API keys, NEXT_PUBLIC_* values), add them to Settings for your app: Turnout passes them to the build as well.`;
  if (/COPY with more than one source file/i.test(message)) return `the repository's own Dockerfile has a mistake: ${message.trim()} (a COPY of several files must end its destination with /, e.g. COPY a b /app/). Fix that line in the repository; the build log shows which step.`;
  if (/couldn't find remote ref/i.test(message)) return `that branch doesn't exist in the repository (${message.trim()}). Leave the branch out to use the repository's default one.`;
  if (/repository not found|could not read Username|authentication|not found/i.test(message)) {
    return `Docker couldn't fetch the repository (${message}). It must be a public git URL.`;
  }
  return message;
}

/** A public GitHub repository's file paths (at its branch and folder, if the link names them), for goal suggestions. */
export async function repoFiles(link: string): Promise<string[]> {
  const m = link.trim().match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?(?:#([^:]*)(?::(.*))?)?$/i);
  if (!m) return [];
  const [, owner, repo, branch, folder] = m;
  try {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch || 'HEAD')}?recursive=1`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'turnout-tryit' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return [];
    const body = (await r.json()) as { tree?: { path: string; type: string }[] };
    const prefix = folder ? `${folder.replace(/^\/+|\/+$/g, '')}/` : '';
    return (body.tree ?? []).filter((t) => t.type === 'blob' && t.path.startsWith(prefix)).map((t) => t.path.slice(prefix.length)).slice(0, 20000);
  } catch {
    return [];
  }
}

/** A public GitHub repository's home page (index.html at its root or folder), raw, for goals: its forms and links. */
export async function repoPage(link: string): Promise<string> {
  const m = link.trim().match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?(?:#([^:]*)(?::(.*))?)?$/i);
  if (!m) return '';
  const [, owner, repo, branch, folder] = m;
  const dir = folder ? `${folder.replace(/^\/+|\/+$/g, '')}/` : '';
  for (const file of ['index.html', 'public/index.html', 'src/index.html']) {
    try {
      const r = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch || 'HEAD')}/${dir}${file}`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) return (await r.text()).slice(0, 500_000);
    } catch {
      /* next */
    }
  }
  return '';
}

/** The ports most web apps listen on, after the Dockerfile's and the log's. */
export const COMMON_PORTS = [80, 8000, 3000, 8080, 5000, 4000, 8888, 5173, 1337, 9000];

/** Ports an app's log says it listens on: "Listening at: http://0.0.0.0:8000", "on port 3000", "localhost:5173". */
export function portsInLog(log: string): number[] {
  const found: number[] = [];
  for (const m of log.matchAll(/(?:listening|running|started|serving|server|bound|available)[^\n]{0,60}?(?:port\s*:?\s*|:)(\d{2,5})\b|(?:0\.0\.0\.0|localhost|127\.0\.0\.1|\[::\]):(\d{2,5})\b/gi)) {
    const n = Number(m[1] ?? m[2]);
    if (n > 0 && n < 65536 && !found.includes(n)) found.push(n);
  }
  return found;
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
  previewPorts?: number[]; // one preview address per version (A, B, C), e.g. [8086, 8087, 8088]
  previewHost?: string; // where a browser reaches them, default http://127.0.0.1
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
  const state: BuildState = { status: 'idle', kind: null, versions: [], log: [], error: null, shop: o.publicShop, goal: null, previews: {} };
  // The preview servers: each forwards to its version's container, as it is now (rebuilt versions, same address).
  const previewUpstream: Record<string, string> = {};
  const previewServers = (o.previewPorts ?? []).map((port, i) => {
    const label = LABELS[i]!;
    const server = http.createServer((req, res) => {
      const base = previewUpstream[label];
      if (!base) return void res.writeHead(503, { 'content-type': 'text/plain' }).end(`Version ${'ABC'[i]} isn't built.`);
      const target = new URL(req.url ?? '/', base);
      // No "has it changed?" questions either: the browser's copy may be another build's app.
      const ask = { ...req.headers, host: target.host };
      delete ask['if-none-match'];
      delete ask['if-modified-since'];
      const up = http.request(target, { method: req.method, headers: ask }, (answer) => {
        // Never cached: every build puts different apps on these same addresses, and a browser kept the last build's
        // page (an app's server sends Last-Modified and no Cache-Control), so A showed what B shows.
        const headers: http.OutgoingHttpHeaders = { ...answer.headers, 'cache-control': 'no-store, max-age=0' };
        delete headers.etag;
        delete headers['last-modified'];
        delete headers.expires;
        // Shown inside the console: an app's "never in a frame" (Django's X-Frame-Options: DENY by default) would
        // leave its preview blank. Only these preview addresses, on this machine; real visitors' pages are untouched.
        delete headers['x-frame-options'];
        for (const name of ['content-security-policy', 'content-security-policy-report-only']) {
          const csp = headers[name];
          if (typeof csp === 'string') headers[name] = csp.split(';').filter((d) => !/^\s*frame-ancestors\b/i.test(d)).join(';');
        }
        res.writeHead(answer.statusCode ?? 502, headers);
        answer.pipe(res);
      });
      up.on('error', (e) => (res.headersSent ? res.end() : res.writeHead(502, { 'content-type': 'text/plain' }).end(e.message)));
      req.pipe(up);
    });
    server.listen(port, '0.0.0.0');
    return server;
  });
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
    const server = createProxy({ config, flags, receipts: flags.receipts, onTraffic: (e) => (feed.publish(e), seen.record(e)), onClick: (c: ClickEvent) => seen.recordClick(c), viewSwitch: true, previewToken: debugToken, debugToken, log: () => {} } as Parameters<typeof createProxy>[0]);
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
      site: { url: o.publicShop, dashboardUrl: o.dashboardUrl, goal, simulated: true, previews: state.previews },
    });
    await new Promise<void>((r) => server.listen(o.consolePort, '0.0.0.0', () => r()));
    appConsole = server;
  }

  // Waits until a container answers HTTP (any status), or gives up with its last log lines.
  // Waits until a container answers HTTP (any status) and says on which port. Given a port, only that one; otherwise the
  // Dockerfile's EXPOSE (or 80) first, then any port the app's own log names ("Listening at: http://0.0.0.0:8000",
  // "listening on port 3000"), then the usual web ports. A Django app without EXPOSE listens on 8000, not 80.
  async function waitUp(name: string, host: string, first: number, fixed: boolean, stage: Stage): Promise<number> {
    const answers = (port: number) => fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(800) }).then(() => true).catch(() => false);
    let logged: number[] = [];
    for (let i = 0; i < 90; i++) {
      if (!fixed && i % 3 === 0) logged = portsInLog(await o.docker.logs(name, 40));
      const candidates = fixed ? [first] : [...new Set([first, ...logged, ...COMMON_PORTS])];
      for (const port of candidates) if (await answers(port)) return port;
      // It crashes on start (restarted 3 times): no point waiting the full 90 s, its log says why.
      if (i % 3 === 2 && ((await o.docker.restarts?.(name)) ?? 0) >= 3) {
        throw new Error(`${name} keeps stopping right after it starts (restarted ${await o.docker.restarts(name)} times). Its last log lines: ${(await o.docker.logs(name)).slice(-600) || '(none)'}`);
      }
      stage.detail = `waiting for it to answer (${i + 1} s)`;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const tried = fixed ? `port ${first}` : `ports ${[...new Set([first, ...logged, ...COMMON_PORTS])].join(', ')}`;
    throw new Error(`${name} didn't answer on ${tried} within 90 s. Set its port under Advanced if it uses another. Its last log lines: ${(await o.docker.logs(name)).slice(-600) || '(none)'}`);
  }

  // The test on what's running: the flag and its metrics in Flagsmith, the proxy, the judge, the A/B test and your
  // app's console. Run after a build, and again when the goal changes mid-test (a new experiment, counting from then).
  let current: { versions: VersionSource[]; releases: string[]; upstream: Record<string, string> } | null = null;
  let sendSteady: ((visitors: number) => Promise<void>) | null = null;
  const steady = createTrickle((n) => (sendSteady ? sendSteady(n) : Promise.resolve()));
  const seen = new ActionLog();
  async function setUp({ versions, releases, upstream }: { versions: VersionSource[]; releases: string[]; upstream: Record<string, string> }): Promise<void> {
    // The flag and its metrics in Flagsmith (idempotent): every slot label is a variant value, so a later build
    // with a different number of versions reuses the same flag.
    const goal = state.goal ? parseSuccess(state.goal) : null;
    const eventOf = (path: string) => path.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').toLowerCase() || 'goal';
    // Secondary metrics: other actions, counted alongside the goal (never one that is the goal).
    const secondary = (state.secondary ?? []).filter((x) => x.action !== state.goal).map((x) => ({ ...x, when: parseSuccess(x.action) }));
    const raw = {
      flag: TRY_FLAG,
      releases: Object.fromEntries(LABELS.map((l) => [l, upstream[l] ?? `http://try-${l.slice(4)}.localhost:80`])),
      ...(goal ? { goal: { event: goal.path.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').toLowerCase() || 'goal', when: goal } } : {}),
      guardrails: ['doc_latency_ms', 'server_error'],
      ...(goal && secondary.length ? { metrics: secondary.map((x) => ({ event: `${eventOf(x.when.path)}_${x.when.method.toLowerCase()}`, when: x.when })) } : {}),
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
    // Steady simulated visitors (step 5), straight through the proxy, then Flagsmith's results when its 5-minute limit
    // allows (step 6): the judge's lock keeps them out of a running step.
    sendSteady = async (visitors: number) => {
      if (lock.busy || !judge) return;
      await simulateAny({ target: `http://127.0.0.1:${o.proxyPort}`, visitors, concurrency: 5, releases, goal: config.goal.when, actionRates: secondary.map((x) => ({ action: x.when, rates: Object.fromEntries(releases.map((r, i) => [r, x.rates?.[releases.length === 2 && versions.length === 1 ? 0 : i] ?? 0.1])) })), debugToken, rates });
      const s = await judge.state();
      const allowed = s.results?.refreshAllowedAt;
      if (s.experiment && (!allowed || Date.parse(allowed) <= Date.now()) && !lock.busy) await judge.run({ action: 'score', experimentId: s.experiment.id });
    };
    const judgeOptions: JudgeOptions = {
        flag: TRY_FLAG, releases, goal: config.goal.event, apiUrl: o.apiUrl, adminKey: o.adminKey,
        proxyUrl: `http://127.0.0.1:${o.proxyPort}`, shopUrl: o.publicShop, dashboardUrl: o.dashboardUrl,
        previewToken: debugToken, serverKey: o.serverKey, rates, concurrency: 20,
        // This build's goal first, then the safety checks: a new build can bring a new goal, and a test takes the
        // metrics it is started with.
        metrics: [
          { name: config.goal.event, expected_direction: config.goal.speedOnly ? 'decrease' : 'increase' },
          ...(config.metrics ?? []).map((m) => ({ name: m.event, expected_direction: 'increase' })),
          ...config.guardrails.filter((g) => g !== config.goal.event).map((g) => ({ name: g, expected_direction: 'not_increase' })),
        ],
        deps: {
          // Your app isn't the demo shop: the explorer walks its own links and fills its forms (simulate-any.ts).
          simulate: async (opts) => {
            const report = await simulateAny({ target: opts.target, visitors: opts.visitors, concurrency: 20, releases, goal: config.goal.when, actionRates: secondary.map((x) => ({ action: x.when, rates: Object.fromEntries(releases.map((r, i) => [r, x.rates?.[releases.length === 2 && versions.length === 1 ? 0 : i] ?? 0.1])) })), debugToken, rates, log: opts.log });
            if (report.noAnswer?.length) note(`${report.byRelease['no answer']?.visitors ?? 0} simulated visitors got no answer (Flagsmith may still count them): ${report.noAnswer.join(', ')}`, 'Turnout', 'error');
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
  }

  async function build(req: BuildRequest): Promise<void> {
    const versions = req.versions.slice(0, 3);
    names = namesFor(versions);
    const releases = versions.length === 1 ? LABELS.slice(0, 2) : LABELS.slice(0, versions.length);
    rates = Object.fromEntries(releases.map((r, i) => [r, Math.min(1, Math.max(0, req.rates?.[versions.length === 1 ? 0 : i] ?? 0.1))]));
    Object.assign(state, {
      needs: null,
      secondary: (req.secondary ?? []).slice(0, 5),
      actions: [],
      status: 'building', kind: kindFor(versions.length), error: null, log: [], goal: req.goal?.trim() || null,
      versions: versions.map((v, i) => ({
        slot: SLOTS[i]!, label: LABELS[i]!, name: names[LABELS[i]!]!, source: v.kind, port: null,
        stages: [{ title: { image: 'Pull the image', git: 'Build it from the repository', folder: `Build your folder with ${v.dockerfile || 'Dockerfile'}`, imagefile: 'Load your image file', dockerfile: 'Build the Dockerfile' }[v.kind], status: 'todo' }, { title: 'Start it', status: 'todo' }],
      })),
    } satisfies Partial<BuildState>);
    judge = null;
    steady.stop();
    sendSteady = null;
    seen.clear();
    state.goalSince = null;
    try {
      await o.docker.ensureNetwork(NETWORK);
      await o.docker.connect(NETWORK, hostname());
      const upstream: Record<string, string> = {};
      // Your settings go to the build too (a Dockerfile's ARG lines), not only to the running app.
      const buildArgs = Object.fromEntries(parseEnv(req.env).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
      const dbEnv: string[] = [];
      await o.docker.remove('turnout-try-db');
      if (req.database) {
        const db = databaseFor(req.database);
        note(`Starting a throwaway ${req.database} for the test (its address is in DATABASE_URL)`, 'Turnout', 'step');
        await o.docker.pull(db.image).catch(() => {});
        await o.docker.run({ name: 'turnout-try-db', image: db.image, network: NETWORK, aliases: ['try-db'], env: db.env });
        await new Promise((r) => setTimeout(r, req.database === 'mysql' ? 15_000 : 5_000));
        dbEnv.push(...db.appEnv);
      }
      // Every version's image at once (A and B build side by side); the same source twice is built once.
      const builds = new Map<string, Promise<string>>();
      const getImage = async (i: number): Promise<string> => {
        const v = versions[i]!;
        const slot = state.versions[i]!;
        const [get] = slot.stages;
        const key = JSON.stringify([v.kind, v.value, v.dockerfile ?? '']);
        const twin = builds.get(key);
        if (twin) {
          get!.status = 'running';
          get!.detail = `the same as version ${'ABC'[[...builds.keys()].indexOf(key)]}: built once`;
          const image = await twin;
          get!.status = 'done';
          return image;
        }
        const job = buildImage(i);
        builds.set(key, job);
        return job;
      };
      const buildImage = async (i: number): Promise<string> => {
        const v = versions[i]!;
        const slot = state.versions[i]!;
        const [get] = slot.stages;
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
        // A folder, or a git repository cloned into one: when it has no Dockerfile, Turnout writes one from what the
        // project is (the repository's own always wins).
        const fromFolder = async (tar: string) => {
          let dockerfile = v.dockerfile || 'Dockerfile';
          const { files, read } = tarIndex(readFileSync(tar));
          if (!files.includes(dockerfile) && !v.dockerfile) {
            const made = files.includes('Dockerfile.turnout') ? read('Dockerfile.turnout') : generatedDockerfile(files, read);
            if (made) {
              if (!files.includes('Dockerfile.turnout')) tarAppend(tar, 'Dockerfile.turnout', made);
              dockerfile = 'Dockerfile.turnout';
              note(`${slot.name} has no Dockerfile: Turnout wrote one (${made.split('\n')[0]})`, slot.slot.toUpperCase());
            } else {
              // Nothing Turnout recognises: say what it looked for, not Docker's "no Dockerfile".
              throw new Error(UNKNOWN_PROJECT);
            }
          }
          return o.docker.buildFolder(image, tar, dockerfile, onLog, buildArgs);
        };
        const where = v.kind === 'git' ? 'the repository' : 'your folder';
        const folderError = (error: Error) => {
          throw new Error(`${slot.name} (version ${slot.slot.toUpperCase()}): ${error.message === UNKNOWN_PROJECT ? `Turnout ${UNKNOWN_PROJECT}` : /locate specified Dockerfile|no such file/i.test(error.message) ? `${where} has no ${v.dockerfile || 'Dockerfile'} at its top level` : gitBuildError(error.message)}`);
        };
        if (v.kind === 'folder') await fromFolder(uploadPath(v.value)).catch(folderError);
        else if (v.kind === 'imagefile') image = await o.docker.load(uploadPath(v.value), onLog);
        else if (v.kind === 'git' && (await hasGit())) {
          // Cloned here and built like a folder, so a repository with no Dockerfile runs too. The same URL twice
          // (an A/A test, or A and B from one repo) is cloned once per version: each gets its own tar.
          const tar = join(uploads, `${randomBytes(12).toString('hex')}.tar`);
          try {
            await gitToTar(v.value, tar, (l) => note(l, slot.slot.toUpperCase()));
            await fromFolder(tar).catch(folderError);
          } finally {
            rmSync(tar, { force: true });
          }
        } else if (v.kind === 'git') await o.docker.build(image, { remote: defaultBranch(v.value) }, onLog, buildArgs).catch((error: Error) => {
          throw new Error(`${slot.name} (version ${slot.slot.toUpperCase()}): ${gitBuildError(error.message)}`);
        });
        else await o.docker.build(image, { dockerfile: v.value }, onLog, buildArgs);
        get!.status = 'done';
        get!.detail = undefined;
        return image;
      };
      const started = Date.now();
      const images = await Promise.all(versions.map((_, i) => getImage(i)));
      note(`Built in ${Math.round((Date.now() - started) / 1000)} s`, 'Turnout', 'ok');
      for (const [i, v] of versions.entries()) {
        const slot = state.versions[i]!;
        const run = slot.stages[1];
        const image = images[i]!;
        run!.status = 'running';
        const guess = v.port || (await o.docker.exposedPort(image)) || 80;
        const name = `turnout-try-${slot.slot}`;
        await o.docker.remove(name);
        // One version (A/A): the same container answers as try-a and try-b.
        // Each version answers as try-x.localhost as well: Django's and Rails' development defaults accept any *.localhost
        // host, and refuse a bare try-x (Django's DisallowedHost, Rails' Blocked hosts), so the app runs unchanged.
        const aliases = (versions.length === 1 ? ['try-a', 'try-b'] : [`try-${slot.slot}`]).flatMap((a) => [a, `${a}.localhost`]);
        await o.docker.run({ name, image, network: NETWORK, aliases, env: [`PORT=${guess}`, "DJANGO_ALLOWED_HOSTS=*", ...dbEnv, ...parseEnv(req.env)] /* Django templates read DJANGO_ALLOWED_HOSTS; your settings still win */ });
        const port = await waitUp(name, `try-${slot.slot}.localhost`, guess, Boolean(v.port), run!).catch(async (error: Error) => {
          // What it asked for: the settings its error names, and a database when those point at one.
          const tail = await o.docker.logs(name, 80).catch(() => '');
          const given = new Set([...dbEnv, ...parseEnv(req.env)].map((l) => l.slice(0, l.indexOf('='))));
          const settings = missingSettings(tail).filter((n) => !given.has(n));
          const database = req.database ? null : wantsDatabase(settings, tail);
          if (settings.length || database) state.needs = { settings, database };
          throw error;
        });
        slot.port = port;
        run!.status = 'done';
        run!.detail = `answering on port ${port}`;
        upstream[slot.label] = `http://try-${slot.slot}.localhost:${port}`;
        previewUpstream[slot.label] = upstream[slot.label]!;
        note(`${slot.name} is running, answering on port ${port}`, slot.slot.toUpperCase(), 'ok');
      }
      for (const slot of SLOTS.slice(versions.length)) await o.docker.remove(`turnout-try-${slot}`);
      if (versions.length === 1) previewUpstream[LABELS[1]!] = previewUpstream[LABELS[0]!]!;
      for (const label of LABELS.slice(versions.length === 1 ? 2 : versions.length)) delete previewUpstream[label];
      const host = (o.previewHost ?? 'http://127.0.0.1').replace(/\/$/, '');
      state.previews = Object.fromEntries((o.previewPorts ?? []).map((p, i) => [LABELS[i]!, `${host}:${p}`]).filter(([l]) => previewUpstream[l as string]));
      if (versions.length === 1) upstream[LABELS[1]!] = upstream[LABELS[0]!]!.replace('try-a', 'try-b');

      // Before any visitor: each version walked once, uncounted. No goal given → the best action every version has.
      note('Reading what a visitor can do on each version (not counted)', 'Turnout', 'step');
      const found = common(await Promise.all(versions.map((_, i) => walk(upstream[LABELS[i]!]!).catch(() => []))));
      state.actions = found.slice(0, 12).map((g) => ({ goal: g, label: describeAction(g) }));
      if (!state.goal && found[0]) {
        state.goal = found[0];
        note(`Goal: a visitor who ${describeAction(found[0])} (${found[0]}), the best of ${found.length} actions found`, 'Turnout', 'ok');
      } else if (!state.goal) note('No action a visitor takes reaches the server on every version: comparing page speed and errors', 'Turnout');
      // Warm-up, straight to each container (not through the proxy: nothing counted, nothing sent to Flagsmith). A
      // cold runtime and its first database connections answer slowly, and whichever version got the first visitors
      // looked slower on page speed: on an A/A test of one Node + Mongo app, 82 ms against 182 ms.
      const warm = await Promise.all(versions.map((_, i) => warmUp(upstream[LABELS[i]!]!, found)));
      note(`Warmed up each version before any visitor (not counted): ${warm.map((ms, i) => `${LABELS[i]} ${ms} ms`).join(', ')} per page after warm-up`, 'Turnout');
      // A version that runs but answers its home page with an error (a host it refuses, a missing table) would be
      // compared on error pages: say so plainly, with the page's own title.
      for (const [i, slot] of state.versions.entries()) {
        const home = await homeStatus(upstream[LABELS[i]!]!);
        if (home.status >= 400) note(`${slot.name} answers its home page with HTTP ${home.status}${home.title ? ` (${home.title})` : ''}: visitors would see that error. Check its settings, then build again.`, slot.slot.toUpperCase(), 'error');
      }
      current = { versions, releases, upstream };
      await setUp(current);
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
      if (p === '/api/try/repo-files') {
        const link = url.searchParams.get('url') ?? '';
        return send(res, 200, { files: await repoFiles(link), html: await repoPage(link) });
      }
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
        for (const x of Array.isArray(body.secondary) ? body.secondary : []) {
          try {
            parseSuccess(String(x?.action ?? ''));
          } catch (error) {
            return send(res, 400, { error: `Secondary metric: ${(error as Error).message}` });
          }
        }
        void build({ versions, goal: body.goal, rates: body.rates, env: typeof body.env === 'string' ? body.env.slice(0, 20_000) : undefined, database: DATABASE_KINDS.find((k) => k === body.database), secondary: Array.isArray(body.secondary) ? body.secondary.filter((x) => x && typeof x.action === 'string').map((x) => ({ action: x.action.trim(), rates: Array.isArray(x.rates) ? x.rates.map((r) => Math.min(1, Math.max(0, Number(r) || 0))) : undefined })) : undefined });
        return send(res, 202, { ok: true });
      }
      // What Turnout has seen visitors do (through the proxy), the actions offered as goals, and the visitors needed.
      if (p === '/api/try/actions') {
        const s = judge ? await judge.state().catch(() => null) : null;
        const goalMetric = s?.results?.metrics.find((m) => m.role === 'goal');
        const base = goalMetric?.arms.control?.mean || (Object.values(rates).reduce((a, b) => a + b, 0) / Math.max(1, Object.keys(rates).length)) || 0.1;
        return send(res, 200, {
          seen: seen.list().slice(0, 50), offered: state.actions ?? [], goal: state.goal, goalSince: state.goalSince ?? null,
          needed: { perVersion: visitorsNeeded(base), base, lift: 0.2, minimum: { visitors: 50, conversions: 5 } },
          counted: goalMetric ? Object.fromEntries(Object.entries(goalMetric.arms).map(([k, a]) => [k, a.n])) : {},
          steady: steady.status(),
        });
      }
      // Settings check: the proxy's copy of the flag vs what Flagsmith serves now.
      if (p === '/api/try/settings-check') {
        const local = flags.snapshot();
        const remote = await fetchRemoteSnapshot(o.apiUrl, o.serverKey, TRY_FLAG);
        const differences = compareSnapshots(local, remote);
        return send(res, 200, { ok: differences.length === 0, differences, ageSeconds: flags.status?.().environmentAgeSeconds ?? null, local, remote });
      }
      // The goal changes mid-test: a new experiment on the same versions, counting from now.
      if (p === '/api/try/goal' && req.method === 'POST') {
        if (state.status !== 'ready' || !current) return send(res, 409, { error: 'Build your versions first; the goal can change once the test is running.' });
        if (lock.busy) return send(res, 409, { error: 'A test step is running. Wait for it to finish.' });
        const body = (await readBody(req)) as { goal?: string };
        const goal = String(body.goal ?? '').trim();
        if (goal) {
          try {
            parseSuccess(goal);
          } catch (error) {
            return send(res, 400, { error: (error as Error).message });
          }
        }
        state.goal = goal || null;
        state.goalSince = new Date().toISOString();
        state.status = 'building';
        note(`New goal: ${goal || 'page speed'}, counting from ${state.goalSince.slice(11, 16)} UTC (a new experiment)`, 'Turnout', 'step');
        void setUp(current).catch((error: Error) => {
          state.status = 'failed';
          state.error = error.message;
          note(error.message, 'Turnout', 'error');
        });
        return send(res, 202, { ok: true, goalSince: state.goalSince });
      }
      // Simulated visitors that keep running at a low rate (0: stop).
      if (p === '/api/try/steady' && req.method === 'POST') {
        const body = (await readBody(req)) as { perMinute?: number };
        const rate = Number(body.perMinute ?? 0);
        if (!(rate > 0)) steady.stop();
        else if (!judge) return send(res, 409, { error: 'Build your versions first.' });
        else steady.start(rate);
        return send(res, 200, steady.status());
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
  return { state, apiServer, close: async () => { apiServer.close(); proxyServer?.close(); appConsole?.close(); for (const s of previewServers) s.close(); await flags.close(); } };
}
