// The console: localhost-only page with the traffic map, Flagsmith's results, and the Ship winner / Revert buttons.
// It holds the admin key; the public proxy never does. Every request must name a local Host (no DNS rebinding),
// every /api/* request must carry the per-boot token the page was served with, and writes must be same-origin JSON.
// Judge mode (/judge) can also be opened from another device, on its own port (listenForOtherDevices): its hostname
// must be listed in allowedHosts, and the browser must have opened the judge link (/judge?key=<judge token>) once,
// which leaves an HttpOnly cookie. The Host header is the client's to choose, so it never decides who is local: a
// request on the other-devices port needs the cookie and never gets the admin password, whatever Host it names.
// Server mode adds a third port (listenForPublic) behind Caddy: a read-only judge view under /judge, GET only, with its
// own API token, judge state with the preview link and tokens taken out, and nothing else (publicView below).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { pinnable, readPin, setPin } from '../flagsmith/pins.ts';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { extname, join } from 'node:path';
import type { DoctorReport } from '../commands/doctor.ts';
import { currentRelease } from '../commands/release.ts';
import { decide, keepRunning, LosingGuardrailsError, plan } from '../decide.ts';
import { losingGuardrails, pickWinner, recommend, type Experiments, type StepResult } from '../flagsmith/experiments.ts';
import { createMapReader } from '../flagsmith/feature-map.ts';
import { readLedger } from '../ledger.ts';
import type { Watcher } from '../health.ts';
import { createAutopilot, type AutopilotOptions } from './autopilot.ts';
import { createJudge, shared, type JudgeOptions, type LiveVisitors } from './judge.ts';

export type ConsoleOptions = {
  // A fixed experiment, or a resolver that finds the flag's latest one (so the console follows `release`).
  experiments: Experiments | (() => Promise<Experiments>);
  feedUrl: string; // the proxy's internal feed, e.g. http://turnout:8081
  metricsUrl?: string; // Flagsmith's Prometheus endpoint, e.g. http://flagsmith:9100/metrics
  snapshotDir: string;
  ledgerDir: string; // where decide() appends ledger.jsonl and RELEASES.md
  uiDir: string;
  github?: { token: string; repository: string }; // also publish each decision to the release's GitHub Release
  // Hostnames besides loopback the console answers (any port), each only with the judge cookie. Needs judgeToken.
  allowedHosts?: string[];
  judgeToken?: string; // TURNOUT_JUDGE_TOKEN: /judge?key=<it> gives a browser the judge cookie
  judge?: JudgeOptions; // judge mode's jobs; without it /api/judge/* answers 404
  judgePage?: boolean; // the /judge page (the demo's guided page); default: on whenever judge is given
  tryitUrl?: string; // the tryit service (Try it with your app, local only), e.g. http://tryit:8097; unset: off
  tryitShopUrl?: string; // where a browser reaches its proxy (previews), default http://127.0.0.1:8085
  // Flagsmith's admin login, for the tour's "sign in to Flagsmith" step. The password goes only to loopback pages.
  flagsmithLogin?: { email: string; password?: string };
  watcher?: Watcher; // the Feature Health bridge and the guard: GET/POST /api/guard
  lock?: { busy: boolean }; // pass one to share it with the watcher's guard
  doctor?: () => Promise<DoctorReport>; // turnout doctor's checks: GET /api/doctor, shown on /setup
  cacheMs?: Partial<CacheTimes>; // how long each shared read is kept; defaults in CACHE_MS
  // The console's first card: where visitors open the app through Turnout, the Flagsmith dashboard, and the goal
  // (null: none yet, the experiment is judged on page speed).
  site?: { url: string; dashboardUrl: string; goal: string | null; simulated?: boolean };
  liveVisitors?: () => Promise<LiveVisitors | null>; // server mode's real-visitor experiment, for judge mode
  // Server mode: runs the judge story by itself (autopilot.ts) while the console listens. Needs `judge`.
  autopilot?: AutopilotOptions;
};

// Many pages poll the same few reads. Each read is shared by everyone who asks while it runs, then kept this long.
// Ship winner, Revert, a results refresh, every judge job and the guard's automatic Revert drop the kept reads.
export type CacheTimes = {
  state: number; // GET /api/state
  latest: number; // which experiment is the flag's latest (turnout release in a terminal shows up within this)
  events: number; // Flagsmith's Prometheus event counter
  doctor: number; // GET /api/doctor; ?fresh=1 skips it
};
export const CACHE_MS: CacheTimes = { state: 1500, latest: 10_000, events: 1000, doctor: 15_000 };

export const TOKEN_HEADER = 'x-turnout-console';
const DEFAULT_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
export const JUDGE_COOKIE = 'tn_judge';
const JUDGE_COOKIE_MAX_AGE = 24 * 60 * 60;

// The judge cookie holds a MAC of the judge token, never the token itself.
export const judgeMark = (judgeToken: string): string =>
  createHmac('sha256', judgeToken).update('turnout-judge').digest('base64url');
const MAX_BODY = 16 * 1024;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// Judge mode shows the setup check and the feature map as tabs (same-origin frames) and the shop through
// Turnout (frame-src names the shop's origin). Nothing else may frame the console.
function securityHeaders(shopUrl: string | undefined, extraFrames: string[] = []): Record<string, string> {
  let shop = '';
  for (const url of [shopUrl, ...extraFrames]) {
    try {
      if (url) shop += ` ${new URL(url).origin}`;
    } catch {
      // no frame for it
    }
  }
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'SAMEORIGIN',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    // map.js sets style attributes on SVG elements, hence 'unsafe-inline' for styles only. No inline scripts.
    'content-security-policy':
      `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-src 'self'${shop}; frame-ancestors 'self'`,
  };
}

// Sockets accepted on the other-devices port. Requests on them are never "this machine".
const otherDevices = new WeakSet<net.Socket>();

// Serve the console to other devices on a second port. Compose publishes the console's main port on 127.0.0.1 only
// and this one on TURNOUT_PUBLISH_HOST, so the rule for a request comes from the port it arrived on.
export function listenForOtherDevices(server: http.Server, port: number, host: string, onListening?: () => void): net.Server {
  const devices = net.createServer((socket) => {
    otherDevices.add(socket);
    server.emit('connection', socket);
  });
  server.on('close', () => devices.close());
  return devices.listen(port, host, onListening);
}

// Sockets accepted on the public read-only port (server mode, behind Caddy). Requests on them only ever reach publicView.
const publicViewers = new WeakSet<net.Socket>();

// Server mode: the read-only judge view, on its own port that only Caddy reaches (compose.server.yml, edge network).
// The rule comes from the port, like listenForOtherDevices: whatever Host or path a request names, it gets publicView.
export function listenForPublic(server: http.Server, port: number, host: string, onListening?: () => void): net.Server {
  const viewers = net.createServer((socket) => {
    publicViewers.add(socket);
    server.emit('connection', socket);
  });
  server.on('close', () => viewers.close());
  return viewers.listen(port, host, onListening);
}

// The public view's prefix: Caddy sends /judge and /judge/* here, everything else on the hostname to the proxy.
export const PUBLIC_BASE = '/judge';
// What the public view serves: the judge page, its scripts, styles and icon, and three reads.
const PUBLIC_READS = new Set(['/api/judge/state', '/api/judge/job', '/api/traffic', '/api/state']);
// Writes from the private console: the autopilot steps aside for a while after one.
const HUMAN_WRITES = new Set(['/api/judge/run', '/api/ship', '/api/revert', '/api/keep-running', '/api/refresh', '/api/guard']);
const PUBLIC_ASSET_TYPES = new Set(['.js', '.css', '.svg']);

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createConsole(opts: ConsoleOptions): http.Server {
  const lock = opts.lock ?? { busy: false }; // one write sequence at a time: Ship/Revert, judge jobs, the guard
  const token = randomBytes(24).toString('base64url');
  const publicToken = randomBytes(24).toString('base64url'); // the public view's own: never the console's token
  // Taken out of everything the public view sends (the preview link and job logs carry the preview token).
  const hidden = [opts.judge?.previewToken, opts.judgeToken, opts.flagsmithLogin?.password]
    .filter((x): x is string => !!x)
    .flatMap((x) => [x, encodeURIComponent(x)]);
  const loopback = new Set(DEFAULT_HOSTS);
  const allowedHosts = new Set([...DEFAULT_HOSTS, ...(opts.allowedHosts ?? [])].map((h) => h.trim().toLowerCase()));
  const remoteHosts = [...allowedHosts].filter((h) => !loopback.has(h));
  if (remoteHosts.length && !opts.judgeToken) {
    throw new Error(
      `TURNOUT_CONSOLE_HOSTS lists ${remoteHosts.join(', ')}, but TURNOUT_JUDGE_TOKEN is not set. ` +
        'Other devices need the judge link (/judge?key=<token>): run init to create the token, or remove the hosts.',
    );
  }
  const mark = opts.judgeToken ? judgeMark(opts.judgeToken) : undefined;
  // Try it with your app: its previews frame the tryit proxy (127.0.0.1:8085).
  const SECURITY_HEADERS = securityHeaders(opts.judge?.shopUrl, opts.tryitUrl ? [opts.tryitShopUrl ?? 'http://127.0.0.1:8085'] : []);
  const ttl: CacheTimes = { ...CACHE_MS, ...opts.cacheMs };
  const resolve = opts.experiments;
  const latest = typeof resolve === 'function' ? shared(resolve, ttl.latest) : null;
  const current = async (): Promise<Experiments> => (latest ? latest.get() : (resolve as Experiments));
  const events = shared(() => readEventCounter(opts.metricsUrl), ttl.events);
  const readEvents = () => events.get();
  const apiState = shared(() => readApiState(), ttl.state);
  const doctor = opts.doctor ? shared(opts.doctor, ttl.doctor) : null;
  // After a write: the next read of anything asks Flagsmith again.
  const invalidate = (scope: 'experiment' | 'all') => {
    latest?.clear();
    if (scope === 'experiment') return;
    events.clear();
    apiState.clear();
    flagsmithMap.invalidate();
    doctor?.clear();
  };
  const judgePage = Boolean(opts.judge) && opts.judgePage !== false;
  const judge = opts.judge
    ? createJudge(opts.judge, {
        experiments: current,
        ...(opts.liveVisitors ? { liveVisitors: opts.liveVisitors } : {}),
        readEvents,
        snapshotDir: opts.snapshotDir,
        ledgerDir: opts.ledgerDir,
        ...(opts.github ? { github: opts.github } : {}),
        lock,
        invalidate,
      })
    : null;
  // The Flagsmith feature map (/flagsmith): every dashboard menu and integration, with live values.
  const flagsmithMap = createMapReader({
    experiments: current,
    dashboardUrl: opts.judge?.dashboardUrl ?? 'http://localhost:8000',
    readEvents,
    ledgerDir: opts.ledgerDir,
  });

  // GET /api/state. The flag waits only for the detail (it needs the feature id); everything else runs at once.
  async function readApiState() {
    const exps = await current();
    const detail = exps.detail();
    const [experiment, results, flag, eventCount, traffic, history] = await Promise.all([
      detail,
      exps.results(),
      detail.then((e) => exps.flagState(e.feature.id)),
      readEvents(),
      fetchJson(`${opts.feedUrl}/summary`),
      exps.history().catch(() => null), // the sidings are extra; the console works without them
    ]);
    return {
      experiment,
      results,
      winner: pickWinner(experiment, results),
      recommendation: recommend(experiment, results),
      flag,
      serving: currentRelease(flag, experiment.feature.multivariate_options.map((o) => ({ ...o, default_percentage_allocation: 0 }))),
      events: eventCount,
      traffic,
      snapshots: listSnapshots(opts.snapshotDir),
      history,
      ledger: readLedger(opts.ledgerDir).filter((e) => e.flag === experiment.feature.name),
      site: opts.site ?? null,
    };
  }

  const json = (res: http.ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  };

  const changed = (res: http.ServerResponse, experimentId: number) =>
    json(res, 409, {
      ok: false,
      error: 'The experiment changed since this page loaded (a new release started). Reload the page and check the plan again.',
      experimentId,
    });

  const act = async (res: http.ServerResponse, action: 'ship' | 'revert', body: ActionBody) => {
    if (lock.busy) return json(res, 409, { ok: false, error: 'Another action is still running.' });
    lock.busy = true;
    const steps: StepResult[] = [];
    invalidate('experiment'); // check against the latest experiment now, not a cached answer
    try {
      const exps = await current();
      if (exps.ref.experimentId !== body.experimentId) return changed(res, exps.ref.experimentId);
      const decision = await decide({
        experiments: exps,
        action,
        ...(action === 'ship' ? { winner: body.winner } : {}),
        acceptLosingGuardrails: body.acceptLosingGuardrails === true,
        snapshotDir: opts.snapshotDir,
        ledgerDir: opts.ledgerDir,
        ...(opts.github ? { github: opts.github } : {}),
        onStep: (s) => steps.push(s),
      });
      json(res, 200, { ok: true, steps, entry: decision.entry, github: decision.github });
    } catch (error) {
      if (error instanceof LosingGuardrailsError) json(res, 409, { ok: false, error: error.message, guardrails: error.warnings });
      else json(res, 502, { ok: false, steps, error: (error as Error).message });
    } finally {
      forget();
      lock.busy = false;
    }
  };
  // Flagsmith recomputes an experiment's results at most once every 5 minutes. A recompute asked for before any new
  // visit (right after Start, say) spends that window on nothing, and the real results then wait 5 minutes. So the
  // console holds a refresh back while the proxy's feed has seen no page view from a visitor in the experiment since
  // it started or since the last refresh. Unknown (an older proxy, or one started after the experiment): never held.
  const lastRefreshAt = new Map<number, number>();
  const refreshHeldBack = async (exps: Experiments): Promise<string | null> => {
    const summary = (await fetchJson(`${opts.feedUrl}/summary`).catch(() => null)) as { since?: number; lastEnrolledPageAt?: number | null } | null;
    if (!summary || typeof summary.since !== 'number') return null;
    const detail = await exps.detail().catch(() => null);
    const started = detail?.started_at ? Date.parse(detail.started_at) : NaN;
    if (!detail || detail.status !== 'running' || !Number.isFinite(started)) return null;
    // Results Flagsmith computed after the last visit already include it (judge mode's "Ask Flagsmith" refreshes too).
    const asOf = Date.parse((await exps.results().catch(() => null))?.as_of ?? '') || 0;
    const after = Math.max(started, lastRefreshAt.get(detail.id) ?? 0, asOf);
    if (summary.since > after) return null; // the proxy restarted since: it can't tell
    if ((summary.lastEnrolledPageAt ?? 0) >= after) return null;
    return asOf > started
      ? "Flagsmith's results already include every visit so far, so Turnout held the refresh back: Flagsmith allows one recompute per experiment every 5 minutes. Send more visitors, then Refresh."
      : 'No visitor in the experiment has loaded a page since it started, so Turnout held the refresh back: Flagsmith allows one recompute per experiment every 5 minutes, and it would be spent on no data. Send visitors or open your site, then Refresh.';
  };

  // Everything kept is dropped after a write from this console, judge mode's state included.
  const forget = () => {
    invalidate('all');
    judge?.forget();
  };
  opts.watcher?.onRevert(forget); // the guard's automatic Revert is a write too
  // A viewer is anyone whose page asked for the judge state recently (the autopilot's own reads don't pass here).
  let lastViewer = Date.now();
  const WATCH_WINDOW_MS = 3 * 60_000;
  const autopilot = judge && opts.autopilot
    ? createAutopilot(judge, lock, { log: (line) => console.log(line), watched: () => Date.now() - lastViewer < WATCH_WINDOW_MS, ...opts.autopilot })
    : null;

  // Server mode's public, read-only judge view. GET and HEAD only; no admin password, no preview link, no writes.
  const redact = <T>(data: T): T => {
    let text = JSON.stringify(data);
    for (const secret of hidden) text = text.split(secret).join('<hidden>');
    return JSON.parse(text) as T;
  };
  async function publicView(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'application/json', 'cache-control': 'no-store' });
      return void res.end(JSON.stringify({ error: 'Read-only view: actions run only from the console on the server (SSH tunnel).' }));
    }
    const url = new URL(req.url ?? '/', 'http://console');
    if (url.pathname === PUBLIC_BASE || url.pathname === `${PUBLIC_BASE}/`) return servePublicPage(opts.uiDir, res, publicToken);
    // The console, read-only: the same page as the private one, its data live, no button that changes anything.
    if (url.pathname === `${PUBLIC_BASE}/console` || url.pathname === `${PUBLIC_BASE}/console/`) return servePublicPage(opts.uiDir, res, publicToken, 'index.html');
    if (!url.pathname.startsWith(`${PUBLIC_BASE}/`)) return json(res, 404, { error: 'not found' });
    const rest = url.pathname.slice(PUBLIC_BASE.length);
    if (rest.startsWith('/api/')) {
      if (!PUBLIC_READS.has(rest)) return json(res, 404, { error: 'not found' });
      const given = req.headers[TOKEN_HEADER] ?? (rest === '/api/traffic' ? url.searchParams.get('token') : null);
      if (!sameSecret(typeof given === 'string' ? given : '', publicToken)) return json(res, 403, { error: 'Open the judge page to use its API.' });
      if (rest === '/api/traffic') return relayFeed(`${opts.feedUrl}/traffic`, res);
      if (rest === '/api/state') {
        lastViewer = Date.now();
        const st = redact(await apiState.get());
        // The shop is the public site itself (same origin); Flagsmith's dashboard stays private.
        const shop = judge ? (await judge.state()).links.shop : (st.site?.url ?? null);
        return json(res, 200, { ...st, readOnly: true, site: shop ? { url: shop, dashboardUrl: null, goal: st.site?.goal ?? null } : null });
      }
      if (!judge) return json(res, 404, { error: 'Judge mode is not configured for this console.' });
      if (rest === '/api/judge/job') return json(res, 200, redact({ job: judge.job() }));
      // The public page is who the autopilot runs for: its state polls are what keep the story moving.
      lastViewer = Date.now();
      const state = redact(await judge.state());
      // Flagsmith's dashboard is private (SSH tunnel): no links to it, and no dashboard URL.
      return json(res, 200, {
        ...state,
        dashboardUrl: null,
        links: { experiment: null, flag: null, shop: state.links.shop, preview: null },
        readOnly: true,
        autopilot: autopilot?.status() ?? null,
      });
    }
    const name = rest.slice(1);
    if (!PUBLIC_ASSET_TYPES.has(extname(name))) return void res.writeHead(404).end();
    return serveStatic(opts.uiDir, rest, res, publicToken);
  }

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (publicViewers.has(req.socket)) {
      try {
        return await publicView(req, res);
      } catch (error) {
        return json(res, 500, { error: (error as Error).message.split(token).join('') });
      }
    }
    // DNS rebinding: a page on evil.example resolving to 127.0.0.1 still sends Host: evil.example.
    const hostname = hostnameOf(req.headers.host);
    // This machine: a loopback name on the port Compose publishes on 127.0.0.1 only. Never the other-devices port.
    const thisMachine = loopback.has(hostname) && !otherDevices.has(req.socket);
    if (!allowedHosts.has(hostname)) {
      res.writeHead(421).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://console');
    try {
      // The judge link: trade the key for a cookie, then drop the key from the address bar.
      if (req.method === 'GET' && url.pathname === '/judge' && url.searchParams.has('key')) {
        if (!opts.judgeToken || !mark || !sameSecret(url.searchParams.get('key') ?? '', opts.judgeToken)) {
          return page(res, 403, 'Not a valid judge link', 'Ask whoever runs this demo for the current judge link.');
        }
        const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
        res.writeHead(303, {
          location: '/judge',
          'set-cookie': `${JUDGE_COOKIE}=${mark}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${JUDGE_COOKIE_MAX_AGE}${secure}`,
          'cache-control': 'no-store',
        });
        return void res.end();
      }
      // Anything but this machine needs the judge cookie, for every page and API call.
      if (!thisMachine &&!(mark && sameSecret(readCookie(req.headers.cookie, JUDGE_COOKIE) ?? '', mark))) {
        if (url.pathname.startsWith('/api/')) return json(res, 403, { error: 'Open the judge link on this device first.' });
        return page(res, 403, 'Open the judge link first', 'This console only answers other devices that opened the judge link (/judge?key=…).');
      }
      const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/try/api/');
      if (isApi) {
        const given = req.headers[TOKEN_HEADER] ?? (url.pathname === '/api/traffic' || url.pathname === '/try/api/traffic' ? url.searchParams.get('token') : null);
        if (!sameSecret(typeof given === 'string' ? given : '', token)) {
          return json(res, 403, { error: 'Open the console page to use its API.' });
        }
      }
      if (req.method === 'POST' && !isSameOriginJson(req)) {
        return json(res, 403, { error: 'Console actions must come from the console page.' });
      }

      // Try it with your app: the console relays to the tryit service (it builds and runs code, so this machine only).
      const tryPath = url.pathname === '/try' || url.pathname.startsWith('/try/') || url.pathname.startsWith('/api/try/');
      if (tryPath) {
        if (!opts.tryitUrl) return isApi || url.pathname.startsWith('/api/') ? json(res, 404, { error: 'Try it is off on this console (it needs local mode).' }) : page(res, 404, 'Try it is off here', 'Try it with your app runs only on a local Turnout (it builds and runs code).');
        if (!thisMachine) return json(res, 403, { error: 'Try it is only available on the machine running Turnout.' });
        if (req.method === 'GET' && (url.pathname === '/try' || url.pathname === '/try/')) return serveTryPage(opts.uiDir, res, token);
        if (url.pathname === '/try/api/flagsmith-login') {
          const login = opts.flagsmithLogin;
          return json(res, 200, { dashboardUrl: opts.judge?.dashboardUrl ?? null, email: login?.email ?? null, password: login?.password ?? null });
        }
        const rest = url.pathname.startsWith('/try/api/') ? url.pathname.slice(4) : url.pathname;
        const allowed = ['/api/try/status', '/api/try/build', '/api/judge/state', '/api/judge/job', '/api/judge/run', '/api/traffic', '/api/you', '/api/pin'];
        if (!allowed.includes(rest)) return json(res, 404, { error: 'not found' });
        return relayTry(`${opts.tryitUrl.replace(/\/$/, '')}${rest}`, req, res);
      }
      if (req.method === 'POST' && HUMAN_WRITES.has(url.pathname)) autopilot?.noteHuman();

      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, await apiState.get());

      if (req.method === 'GET' && url.pathname === '/api/plan') {
        const action = url.searchParams.get('action') === 'revert' ? 'revert' : 'ship';
        const winner = url.searchParams.get('winner') ?? '';
        const experimentId = Number(url.searchParams.get('experimentId'));
        if (!Number.isInteger(experimentId) || !url.searchParams.get('experimentId')) {
          return json(res, 400, { error: 'experimentId is required' });
        }
        const exps = await current();
        if (exps.ref.experimentId !== experimentId) return changed(res, exps.ref.experimentId);
        const [experiment, results] = await Promise.all([exps.detail(), exps.results()]);
        const steps = await plan(exps, action, winner, opts.snapshotDir);
        return json(res, 200, {
          experimentId,
          steps: steps.map((s) => ({ title: s.title, call: s.call })),
          guardrails: action === 'ship' ? losingGuardrails(experiment, results, winner) : [],
          recommendation: recommend(experiment, results),
        });
      }

      if (url.pathname === '/api/guard') {
        if (!opts.watcher) return json(res, 404, { error: 'The health bridge and guard are not configured.' });
        if (req.method === 'GET') return json(res, 200, opts.watcher.snapshot());
        if (req.method === 'POST') {
          const body = (await readJson(req)) as { enabled?: unknown };
          if (typeof body.enabled !== 'boolean') return json(res, 400, { error: 'enabled must be true or false' });
          const state = opts.watcher.setGuard(body.enabled);
          void opts.watcher.tick(); // act on the current results straight away
          return json(res, 200, state);
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/refresh') {
        await readJson(req);
        const exps = await current();
        const held = await refreshHeldBack(exps);
        if (held) return json(res, 200, { ok: false, heldBack: true, reason: held });
        const refreshed = await exps.refreshResults();
        if (refreshed.ok) lastRefreshAt.set(exps.ref.experimentId, Date.now());
        forget();
        return json(res, 200, refreshed);
      }

      if (req.method === 'POST' && (url.pathname === '/api/ship' || url.pathname === '/api/revert')) {
        const body = parseActionBody(await readJson(req));
        const action = url.pathname === '/api/ship' ? 'ship' : 'revert';
        if (action === 'ship' && !body.winner) return json(res, 400, { ok: false, error: 'winner is required' });
        return act(res, action, body);
      }

      // Keep running: no Flagsmith write, a ledger entry with Flagsmith's interval and the reason.
      if (req.method === 'POST' && url.pathname === '/api/keep-running') {
        const body = parseActionBody(await readJson(req));
        if (lock.busy) return json(res, 409, { ok: false, error: 'Another action is still running.' });
        lock.busy = true;
        invalidate('experiment');
        try {
          const exps = await current();
          if (exps.ref.experimentId !== body.experimentId) return changed(res, exps.ref.experimentId);
          return json(res, 200, { ok: true, entry: await keepRunning({ experiments: exps, ledgerDir: opts.ledgerDir }) });
        } catch (error) {
          return json(res, 409, { ok: false, error: (error as Error).message });
        } finally {
          forget();
          lock.busy = false;
        }
      }

      // Flagsmith's dashboard and its login, for the menu's Flagsmith link and the sign-in box. Every console has it,
      // judge mode or not. The password goes only to this machine's pages, never to another device.
      if (req.method === 'GET' && (url.pathname === '/api/flagsmith-login' || url.pathname === '/api/judge/signin')) {
        const login = opts.flagsmithLogin;
        return json(res, 200, {
          dashboardUrl: opts.judge?.dashboardUrl ?? null,
          email: login?.email ?? null,
          password: login?.password && thisMachine ? login.password : null,
        });
      }

      if (url.pathname.startsWith('/api/judge/')) {
        if (!judge) return json(res, 404, { error: 'Judge mode is not configured for this console.' });
        if (req.method === 'GET' && url.pathname === '/api/judge/state') {
          lastViewer = Date.now();
          return json(res, 200, { ...(await judge.state()), ...(autopilot ? { autopilot: autopilot.status() } : {}) });
        }
        if (req.method === 'GET' && url.pathname === '/api/judge/job') return json(res, 200, { job: judge.job() });
        if (req.method === 'POST' && url.pathname === '/api/judge/run') {
          const ran = await judge.run(await readJson(req));
          return json(res, ran.status, ran.body);
        }
        return json(res, 404, { error: 'not found' });
      }

      // Pin this browser to one version (a Flagsmith identity override for its visitor id), or unpin it. For looking
      // at a version as a visitor would, from the start of a visit; a pinned browser is outside the experiment.
      if (url.pathname === '/api/pin' && (req.method === 'GET' || req.method === 'POST')) {
        const identifier = readCookie(req.headers.cookie, 'tn_id');
        if (!pinnable(identifier)) return json(res, 409, { error: 'Open your site in this browser first: Turnout gives it a visitor id, and that is what gets pinned.' });
        const exps = await current();
        const featureId = (await exps.detail()).feature.id;
        if (req.method === 'GET') return json(res, 200, { pinned: await readPin(exps.api, exps.ref.envKey, featureId, identifier) });
        const body = (await readJson(req)) as { release?: unknown };
        const release = body.release === null ? null : typeof body.release === 'string' ? body.release : undefined;
        const allowed = opts.judge?.releases ?? [];
        if (release === undefined || (release !== null && !allowed.includes(release))) return json(res, 400, { error: `release must be null or one of: ${allowed.join(', ')}` });
        return json(res, 200, { pinned: await setPin(exps.api, exps.ref.envKey, featureId, identifier, release) });
      }

      // Where this browser lands: its visitor cookie (cookies are per host, not per port, so the shop's cookie comes
      // here too), handed to the proxy's own receipt. Never records an exposure. Not on the public view.
      if (req.method === 'GET' && url.pathname === '/api/you') {
        const safe = (v: string | undefined) => (v && /^[\w%.~:-]{1,200}$/.test(v) ? v : undefined); // passed on as-is
        const id = safe(readCookie(req.headers.cookie, 'tn_id'));
        const view = safe(readCookie(req.headers.cookie, 'tn_view'));
        if (!id && !view) return json(res, 200, { visited: false });
        const proxy = (opts.judge?.proxyUrl ?? 'http://turnout:8080').replace(/\/$/, '');
        try {
          const cookie = [id && `tn_id=${id}`, view && `tn_view=${view}`].filter(Boolean).join('; ');
          const r = await fetch(`${proxy}/__turnout/receipt`, { headers: { cookie }, signal: AbortSignal.timeout(2500) });
          const body = r.ok ? ((await r.json()) as Record<string, unknown>) : null;
          return json(res, 200, body ? { visited: true, ...body } : { visited: Boolean(id), error: `The proxy answered ${r.status}.` });
        } catch (error) {
          return json(res, 200, { visited: Boolean(id), error: `The proxy didn't answer: ${(error as Error).message}` });
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/doctor') {
        if (!doctor) return json(res, 404, { error: 'The setup check is not configured for this console.' });
        return json(res, 200, await doctor.get(url.searchParams.get('fresh') === '1')); // ?fresh=1: "Check again"
      }

      if (req.method === 'GET' && url.pathname === '/api/flagsmith-map') return json(res, 200, await flagsmithMap.read());

      if (req.method === 'GET' && url.pathname === '/api/traffic') {
        return relayFeed(`${opts.feedUrl}/traffic`, res);
      }

      // Without judge mode (turnout compare: your own app, not the demo shop), /judge is the console.
      if (req.method === 'GET' && url.pathname === '/judge' && !judgePage) {
        res.writeHead(302, { location: '/', 'cache-control': 'no-store' });
        return void res.end();
      }
      if (req.method === 'GET') return serveStatic(opts.uiDir, url.pathname, res, token, !judgePage);
      json(res, 404, { error: 'not found' });
    } catch (error) {
      if (error instanceof HttpError) return json(res, error.status, { error: error.message });
      json(res, 500, { error: (error as Error).message });
    }
  });
  if (autopilot) {
    server.on('listening', () => autopilot.start());
    server.on('close', () => void autopilot.stop());
  }
  return server;
}

type ActionBody = { experimentId: number; winner?: string; acceptLosingGuardrails?: boolean };

function parseActionBody(body: unknown): ActionBody {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.experimentId !== 'number' || !Number.isInteger(b.experimentId)) throw new HttpError(400, 'experimentId is required');
  if (b.winner !== undefined && typeof b.winner !== 'string') throw new HttpError(400, 'winner must be a string');
  return {
    experimentId: b.experimentId,
    ...(typeof b.winner === 'string' && b.winner ? { winner: b.winner } : {}),
    acceptLosingGuardrails: b.acceptLosingGuardrails === true,
  };
}

// "localhost:8090" → "localhost", "[::1]:8090" → "[::1]"; the port is whatever the request came in on.
export function hostnameOf(host: string | undefined): string {
  if (!host) return '';
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0]!;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

function page(res: http.ServerResponse, status: number, title: string, text: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><h1>${title}</h1><p>${text}</p>`);
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// A cross-site form can't send application/json without a preflight we never answer, and a browser always sends
// Origin on a cross-origin POST. Origin "null" (sandboxed frames, file://) or anything unparseable is refused.
function isSameOriginJson(req: http.IncomingMessage): boolean {
  if (!/^application\/json\s*(;\s*charset=utf-8\s*)?$/i.test(req.headers['content-type'] ?? '')) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) throw new HttpError(413, 'request body too large');
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) {
      req.destroy();
      throw new HttpError(413, 'request body too large');
    }
  }
  if (!raw) return {};
  try {
    const body: unknown = JSON.parse(raw);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body;
  } catch {
    throw new HttpError(400, 'request body must be a JSON object');
  }
}

async function fetchJson(url: string): Promise<unknown> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// Flagsmith's own counter of accepted and rejected experiment events.
export async function readEventCounter(metricsUrl: string | undefined): Promise<{ accepted: number; rejected: number } | null> {
  if (!metricsUrl) return null;
  try {
    const res = await fetch(metricsUrl, { signal: AbortSignal.timeout(2000) });
    const text = await res.text();
    const read = (result: string) =>
      Number(text.match(new RegExp(`^flagsmith_experimentation_sdk_events_total\\{result="${result}"\\} ([0-9.e+]+)$`, 'm'))?.[1] ?? 0);
    return { accepted: read('accepted'), rejected: read('rejected') };
  } catch {
    return null;
  }
}

// Relays one request to the tryit service: the method, the JSON body, the browser's cookies (where you land, pins),
// and the answer as it streams (the traffic feed is an event stream).
async function relayTry(url: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  try {
    let body: string | undefined;
    if (req.method === 'POST') {
      body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 512 * 1024) throw new Error('too large');
      }
    }
    const upstream = await fetch(url, {
      method: req.method,
      headers: { 'content-type': 'application/json', ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}) },
      ...(body !== undefined ? { body } : {}),
      signal: abort.signal,
    });
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });
    if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `The Try it service didn't answer: ${(error as Error).message}. On your machine, run turnout.bat (Windows) or sh turnout.sh (macOS, Linux) again to start it. A public server never runs it.` }));
    } else res.end();
  }
}

// Judge mode's page for your own versions: the same demo.html, its API under /try/api/ (the tryit service).
function serveTryPage(dir: string, res: http.ServerResponse, token: string): void {
  const html = readFileSync(join(dir, 'demo.html'), 'utf8')
    .replace(TOKEN_META, `<meta name="turnout-console" content="${token}"><meta name="turnout-base" content="/try"><meta name="turnout-try" content="1">`)
    .replace('<title>Turnout demo</title>', '<title>Turnout: try it with your app</title>');
  res.writeHead(200, { 'content-type': TYPES['.html']!, 'cache-control': 'no-store' });
  res.end(html);
}

async function relayFeed(url: string, res: http.ServerResponse): Promise<void> {
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  try {
    const upstream = await fetch(url, { signal: abort.signal });
    if (!upstream.ok || !upstream.body) throw new Error('feed unavailable');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch {
    if (!res.headersSent) res.writeHead(503, { 'content-type': 'text/plain' });
    res.end();
  }
}

function listSnapshots(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return sortSnapshots(readdirSync(dir).filter((f) => f.endsWith('.json')));
}

// Newest first by the time in the name (experiment-<id>-<ISO time with dashes>.json), not by the name itself:
// "experiment-9-…" sorts after "experiment-21-…" as text. Names without a time go last, by name.
export function sortSnapshots(files: string[]): string[] {
  const at = (f: string) => /(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/.exec(f)?.[1] ?? '';
  return [...files].sort((a, b) => at(b).localeCompare(at(a)) || b.localeCompare(a));
}

const TOKEN_META = '<meta name="turnout-console" content="">';
// Pages by path; each gets the API token injected.
const PAGES: Record<string, string> = { '/': 'index.html', '/judge': 'demo.html', '/setup': 'setup.html', '/flagsmith': 'flagsmith.html' };

// The public judge page: the same demo.html as /judge, read-only, its assets under /judge/ (Caddy sends only /judge* here, so
// /style.css and friends stay the app's), and its API calls under /judge/api/ (the page reads turnout-base).
function servePublicPage(dir: string, res: http.ServerResponse, token: string, page = 'demo.html'): void {
  const html = readFileSync(join(dir, page), 'utf8')
    .replace(
      TOKEN_META,
      `<meta name="turnout-console" content="${token}"><meta name="turnout-base" content="${PUBLIC_BASE}"><meta name="turnout-readonly" content="1">`,
    )
    .replace(/(href|src)="\/([a-z0-9-]+\.(?:css|js|svg))"/g, `$1="${PUBLIC_BASE}/$2"`);
  res.writeHead(200, { 'content-type': TYPES['.html']!, 'cache-control': 'no-store' });
  res.end(html);
}

function serveStatic(dir: string, pathname: string, res: http.ServerResponse, token: string, noJudge = false): void {
  const name = PAGES[pathname] ?? pathname.slice(1);
  if (name.includes('..') || name.includes('/') || name.includes('\\') || !TYPES[extname(name)]) {
    res.writeHead(404).end();
    return;
  }
  const file = join(dir, name);
  if (!existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(name)]!, 'cache-control': 'no-store' });
  // The page learns the API token here; only a same-origin page (Host checked above) can read it.
  // No judge mode here: the pages' menus drop their links to it (menu.js reads turnout-no-judge).
  const metas = `<meta name="turnout-console" content="${token}">${noJudge ? '<meta name="turnout-no-judge" content="1">' : ''}`;
  if (Object.values(PAGES).includes(name)) res.end(readFileSync(file, 'utf8').replace(TOKEN_META, metas));
  else res.end(readFileSync(file));
}
