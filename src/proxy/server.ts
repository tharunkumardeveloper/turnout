import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import type { LookupFunction } from 'node:net';
import { EVENT_NAME, GUARDRAILS, matchesRule, measuresSpeed, measuresVitals, VITALS_REPORTED, type Config } from '../config.ts';
import type { Receipt } from '../flagsmith/receipts.ts';

export const ID_COOKIE = 'tn_id';
export const PREVIEW_COOKIE = 'tn_preview';
// "View this version" (server mode's public demo, TURNOUT_VIEW_SWITCH=1): a judge picks a release to look at. That
// browser is then served that release and never counted (no exposure, no events), so looking never skews the data.
export const VIEW_COOKIE = 'tn_view';
export const VIEW_PARAM = '__turnout_view'; // the same for one page: guided demo's side-by-side previews
// Paths under this prefix are answered by Turnout itself and never reach the app.
export const OWN_PREFIX = '/__turnout/';
// The app may name conversion events itself: "X-Turnout-Event: signup, plan_chosen;value=49". Turnout always
// removes the header; with goal.header: true it turns each entry into a Flagsmith event for that visitor.
export const EVENT_HEADER = 'x-turnout-event';
export const MAX_HEADER_EVENTS = 5;
// Request header to the app, for previewing browsers and debug-token requests only: the release label it serves.
export const RELEASE_HEADER = 'x-turnout-release';

const CONTROL = 'control';
const ONE_YEAR_S = 365 * 24 * 60 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BROWSER_RE = /^Mozilla\/\d/;
const BOT_RE = /bot|crawl|spider|slurp|headless|lighthouse|preview|curl|wget|python-requests/i;
// RFC 9110 §7.6.1: meaningful for one connection only, never forwarded.
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

// variant: the experiment key (control, v2…) used for events; release: the flag's value, which picks the container.
export type Assignment = { variant: string; release: string | undefined; enrolled: boolean };
export type FlagSourceStatus = { ready: boolean; environmentAgeSeconds: number | null; lastError: string | null };

// The proxy's only view of Flagsmith; src/flagsmith/flag-source.ts implements it with the SDK.
export interface FlagSource {
  assign(identity: string, opts: { recordExposure: boolean; traits?: Record<string, string> }): Promise<Assignment>;
  track(event: string, identity: string, value?: number): void;
  ready?(): boolean; // false until the first environment document has arrived
  status?(): FlagSourceStatus;
}

export type TrafficEvent = {
  at: number;
  variant: string;
  release: string;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
  document: boolean;
  enrolled: boolean;
  converted: boolean;
  fallback?: string;
};

// Where the live release is remembered between restarts, so a cold start without Flagsmith serves it.
export type ReleaseMemory = { load(): string | undefined; save(release: string): void };

type Options = {
  config: Config;
  flags: FlagSource;
  onTraffic?: (event: TrafficEvent) => void;
  receipts?: { get(identity: string): Receipt | undefined; undelivered?: number; droppedBySdk?: number; heldMax?: number; batches?: object };
  previewToken?: string; // opening /__turnout/preview?token=<it> puts this browser in the preview segment
  debugToken?: string; // x-turnout-debug: <it> adds the variant headers to a response; unset = never
  assignTimeoutMs?: number; // a visitor never waits longer than this for a flag; default 150
  upstreamTimeoutMs?: number; // default 30 s, then 504
  secureCookies?: boolean; // also set automatically for https or X-Forwarded-Proto: https
  cookieDomain?: string; // the visitor cookie for a parent domain too (server mode: shop.example and the console on example)
  viewSwitch?: boolean; // /__turnout/view?release=…: look at one release, uncounted (TURNOUT_VIEW_SWITCH=1)
  // Set: every page gets a small script that reports clicks on links and buttons and form sends, by visible label.
  onClick?: (click: ClickEvent) => void;
  memory?: ReleaseMemory;
  log?: (line: Record<string, unknown>) => void; // one access-log entry per request
  warn?: (message: string) => void;
};

class Deadline extends Error {}

export type ClickEvent = { kind: 'link' | 'button' | 'submit'; label: string; target: string; identity: string | undefined; release: string | null };

// Runs in the visitor's browser: a click on a link or button, or a form send, is reported by what it says on it
// ("Sign up", "Download CV") and where it goes. Never a field's value. sendBeacon, so leaving the page doesn't lose it.
export const CLICK_SCRIPT = `(() => {
  const send = (kind, el, target) => {
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.title || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const body = JSON.stringify({ kind, label, target: String(target || '').slice(0, 200) });
    if (!navigator.sendBeacon || !navigator.sendBeacon('${OWN_PREFIX}click', new Blob([body], { type: 'application/json' }))) fetch('${OWN_PREFIX}click', { method: 'POST', body, keepalive: true }).catch(() => {});
  };
  addEventListener('click', (e) => {
    const el = e.target instanceof Element ? e.target.closest('a[href], button, [role=button], input[type=submit], input[type=button]') : null;
    if (!el || el.closest('form') && (el.type === 'submit' || el.tagName === 'BUTTON' && !el.type)) return;
    send(el.tagName === 'A' ? 'link' : 'button', el, el.getAttribute('href'));
  }, true);
  addEventListener('submit', (e) => {
    const f = e.target;
    const b = e.submitter || f.querySelector('[type=submit], button');
    send('submit', b || f, (f.getAttribute('method') || 'GET').toUpperCase() + ' ' + (f.getAttribute('action') || location.pathname));
  }, true);
})();
`;

// Runs in the visitor's browser when the config has the lcp_ms or cls guardrail: page speed as the visitor saw it.
// Largest contentful paint (when the main content appeared) and cumulative layout shift (how much the page jumped,
// shifts right after a click or key press excluded), sent once as the page is left or hidden. Numbers only.
export const VITALS_SCRIPT = `(() => {
  if (!('PerformanceObserver' in window)) return;
  let lcp = 0, cls = 0, sent = false;
  try { new PerformanceObserver((list) => { for (const e of list.getEntries()) lcp = Math.max(lcp, e.startTime); }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch {}
  try { new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); } catch {}
  const send = () => {
    if (sent) return;
    sent = true;
    const body = JSON.stringify({ lcp: lcp > 0 ? Math.round(lcp) : null, cls: Math.round(cls * 10000) / 10000 });
    if (!navigator.sendBeacon || !navigator.sendBeacon('${OWN_PREFIX}vitals', new Blob([body], { type: 'application/json' }))) fetch('${OWN_PREFIX}vitals', { method: 'POST', body, keepalive: true }).catch(() => {});
  };
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') send(); }, true);
  addEventListener('pagehide', send, true);
})();
`;
/** A browser report's numbers, or null: LCP in ms (0 to 2 minutes), CLS (0 to 10). Anything else is dropped. */
export function parseVitals(body: unknown): { lcp: number | null; cls: number | null } | null {
  const b = (body ?? {}) as { lcp?: unknown; cls?: unknown };
  const lcp = typeof b.lcp === 'number' && Number.isFinite(b.lcp) && b.lcp > 0 && b.lcp <= 120_000 ? Math.round(b.lcp) : null;
  const cls = typeof b.cls === 'number' && Number.isFinite(b.cls) && b.cls >= 0 && b.cls <= 10 ? b.cls : null;
  return lcp === null && cls === null ? null : { lcp, cls };
}

export function createProxy(opts: Options): http.Server {
  const { config, flags, onTraffic, receipts, previewToken, debugToken } = opts;
  const assignTimeoutMs = opts.assignTimeoutMs ?? 150;
  const vitals = measuresVitals(config); // the browser script that measures lcp_ms and cls
  const upstreamTimeoutMs = opts.upstreamTimeoutMs ?? 30_000;
  const log = opts.log ?? ((line) => console.log(JSON.stringify(line)));
  const warn = opts.warn ?? ((message) => console.warn(message));
  // The preview cookie holds a MAC of the token, never the token itself.
  const previewMark = previewToken ? createHmac('sha256', previewToken).update('turnout-preview').digest('base64url') : undefined;

  // The live release: what a visitor outside the experiment, or in its control, is served. Bots, cold starts and
  // Flagsmith outages get it. Starts from memory, else the first release in the config.
  let live = opts.memory?.load();
  if (live && !config.releases.has(live)) live = undefined;
  // The release each recent visitor was served, so a click is recorded against its version (bounded).
  const servedTo = new Map<string, string>();
  const noteServed = (identity: string, release: string) => {
    servedTo.delete(identity);
    servedTo.set(identity, release);
    if (servedTo.size > 20_000) servedTo.delete(servedTo.keys().next().value!);
  };
  const remember = (release: string) => {
    if (release === live) return;
    live = release;
    try {
      opts.memory?.save(release);
    } catch (error) {
      warn(`turnout: couldn't save the live release: ${(error as Error).message}`);
    }
  };

  // At most one warning per reason every 10 s, with how many requests it covered.
  const fallbacks = new Map<string, { count: number; warnedAt: number }>();
  const noteFallback = (reason: string) => {
    const f = fallbacks.get(reason) ?? { count: 0, warnedAt: 0 };
    f.count++;
    fallbacks.set(reason, f);
    if (Date.now() - f.warnedAt > 10_000) {
      warn(`turnout: serving the live release (${live ?? config.fallback}) because ${FALLBACK_TEXT[reason] ?? reason} (${f.count} requests so far)`);
      f.warnedAt = Date.now();
    }
  };

  const assign = async (identity: string, recordExposure: boolean, traits?: Record<string, string>): Promise<Assignment> => {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Deadline()), assignTimeoutMs);
    });
    try {
      return await Promise.race([flags.assign(identity, { recordExposure, ...(traits ? { traits } : {}) }), deadline]);
    } finally {
      clearTimeout(timer);
    }
  };

  // Events handed to Flagsmith's SDK since start, by name: with the debug token, /__turnout/health reports them, so a
  // load test can compare what the proxy sent with the rows Flagsmith stored.
  const trackedEvents = new Map<string, number>();
  const track = (event: string, identity: string, value?: number) => {
    trackedEvents.set(event, (trackedEvents.get(event) ?? 0) + 1);
    if (value === undefined) flags.track(event, identity);
    else flags.track(event, identity, value);
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const started = performance.now();
    const method = req.method ?? 'GET';
    const target = originForm(req.url ?? '');
    if (!target) return plain(res, 400, 'Turnout: only origin-form request targets ("/path") are accepted.\n');
    const path = target.pathname + target.search;

    const cookieId = readCookie(req.headers.cookie, ID_COOKIE);
    const known = !!cookieId && UUID_RE.test(cookieId);

    const previewing = !!previewMark && safeEqual(readCookie(req.headers.cookie, PREVIEW_COOKIE), previewMark);
    const query = new URLSearchParams(target.search);
    const viewParam = opts.viewSwitch ? (query.get(VIEW_PARAM) ?? undefined) : undefined;
    if (viewParam !== undefined) {
      query.delete(VIEW_PARAM); // the app never sees it
      target.search = query.size ? `?${query}` : '';
    }
    // A view link names its release for one page only. That page's assets, its API calls and the links clicked on it
    // carry its address as the Referer, so they show the same release, uncounted: without this, a preview's styles
    // and scripts came from whatever release the browser was assigned (an app with per-release asset names broke),
    // and the first link clicked in a preview made a counted visitor.
    const viewedVia = (): string | undefined => {
      if (!opts.viewSwitch) return undefined;
      const fromRef = refererView(header(req, 'referer'), req.headers.host);
      return fromRef ? viewedRelease(fromRef) : undefined;
    };
    const ownView = opts.viewSwitch ? (viewedRelease(viewParam) ?? viewedRelease(readCookie(req.headers.cookie, VIEW_COOKIE))) : undefined;
    const inherited = ownView ? undefined : viewedVia();
    const viewing = ownView ?? inherited;
    if (target.pathname.startsWith(OWN_PREFIX)) {
      // A viewed page's own script asking for its receipt (the shop's badge) gets that view too.
      return ownEndpoint({ req, res, url: target, identity: known ? cookieId : undefined, previewing, viewing });
    }
    // A page opened from a viewed page: put the view in its own address, so its assets and links follow it too.
    if (inherited && method === 'GET' && isDocumentRequest(req)) {
      const q = new URLSearchParams(target.search);
      q.set(VIEW_PARAM, inherited);
      res.writeHead(302, { location: `${target.pathname}?${q}`, 'cache-control': 'no-store' });
      return void res.end();
    }

    const bot = BOT_RE.test(req.headers['user-agent'] ?? '');
    const document = isDocumentRequest(req);
    const id = known ? cookieId! : randomUUID();
    // A visitor counts from their first page load in a browser, so one-page visits (bounces) are in the data.
    // Without our cookie, only a browser's page load (GET of a document, browser user agent) counts: API calls,
    // assets and cookie-less scripts never become identities in Flagsmith. Exposures come from page loads.
    // Debug-token probes without the cookie (Turnout's own checks) stay out of the data too.
    // A simulated visitor (x-turnout-visitor: 1) carries the token only to read which release it got: it counts like a
    // browser from its first page, so a one-page visit is in the data (without this, a version whose pages give a
    // visitor no link to follow was never counted: 514 visitors on A, 1 on B).
    const tokenOk = !!debugToken && safeEqual(header(req, 'x-turnout-debug'), debugToken);
    const probe = tokenOk && header(req, 'x-turnout-visitor') !== '1';
    const counted = !viewing && !bot && (known || (!probe && document && method === 'GET' && BROWSER_RE.test(req.headers['user-agent'] ?? '')));

    let assignment: Assignment | undefined;
    let fallback: string | undefined;
    if (viewing) {
      // A chosen version, looked at: no flag evaluation, no exposure, no events.
    } else if (bot) {
      fallback = 'bot';
    } else if (flags.ready && !flags.ready()) {
      fallback = 'not-ready';
    } else {
      try {
        assignment = await assign(id, counted && document && method === 'GET', previewing ? { preview: 'true' } : undefined);
      } catch (error) {
        fallback = error instanceof Deadline ? 'deadline' : 'error';
      }
    }

    // Only allowlisted releases are reachable; anything else gets the live release.
    let release: string;
    if (viewing) {
      release = viewing;
    } else if (assignment?.release && config.releases.has(assignment.release)) {
      release = assignment.release;
      if (!previewing && (!assignment.enrolled || assignment.variant === CONTROL)) remember(release);
    } else {
      fallback ??= assignment?.release ? 'unknown-release' : 'flag-off';
      release = live ?? config.fallback;
    }
    if (fallback && fallback !== 'bot') noteFallback(fallback);
    const variant = assignment && !fallback ? assignment.variant : CONTROL;
    const enrolled = !!assignment?.enrolled && !fallback;
    const tracked = counted && !fallback;
    const upstream = config.releases.get(release)!;
    if (tracked && (opts.onClick || vitals)) noteServed(id, release);

    let appEvents: AppEvent[] = [];
    let done = false;
    const finish = (status: number, latencyMs: number) => {
      if (done) return;
      done = true;
      let converted = false;
      if (tracked) {
        if (config.goal.when && matchesRule(config.goal.when, method, target.pathname, status)) {
          track(config.goal.event, id);
          converted = true;
        }
        for (const m of config.metrics ?? []) {
          if (matchesRule(m.when, method, target.pathname, status)) track(m.event, id);
        }
        for (const e of appEvents) {
          if (e.event === config.goal.event && converted) continue; // the rule already counted this request
          track(e.event, id, e.value);
          if (e.event === config.goal.event) converted = true;
        }
        if (document && method === 'GET' && measuresSpeed(config)) track('doc_latency_ms', id, latencyMs);
        if (config.guardrails.includes('server_error') && (document || status >= 500)) {
          track('server_error', id, status >= 500 ? 1 : 0);
        }
      }
      const event: TrafficEvent = { at: Date.now(), variant, release, method, path: target.pathname, status, latencyMs, document, enrolled, converted };
      if (fallback) event.fallback = fallback;
      onTraffic?.(event);
      log({ t: new Date().toISOString(), method, path: target.pathname, status, ms: latencyMs, variant, release, enrolled, ...(fallback ? { fallback } : {}) });
    };
    const elapsed = () => Math.round(performance.now() - started);

    const url = new URL(upstream.href);
    url.pathname = upstream.pathname.replace(/\/$/, '') + target.pathname;
    url.search = target.search;
    const secure = opts.secureCookies || isHttps(req);
    const client = url.protocol === 'https:' ? https : http;
    let timedOut = false;

    const debugging = tokenOk; // the release headers: for Turnout's checks and its simulated visitors alike
    const upstreamHeaders = forwardHeaders(req, upstream, secure);
    // Only a previewing browser or a debug-token request tells the app which release it is (the app may show a
    // "Release 1.5" badge); forwardHeaders already dropped any copy a client sent, so nobody else can ask for it.
    if (previewing || debugging) upstreamHeaders[RELEASE_HEADER] = release;
    const onResponse = (upstreamRes: http.IncomingMessage) => {
      const status = upstreamRes.statusCode ?? 502;
      const latencyMs = elapsed(); // time to the app's response headers
      const headers = responseHeaders(upstreamRes.headers, upstream, secure);
      if (config.goal.header) appEvents = parseEventHeader(upstreamRes.headers[EVENT_HEADER]);
      if (debugging) {
        headers['x-turnout-variant'] = variant;
        headers['x-turnout-release'] = release;
        headers['x-turnout-enrolled'] = String(enrolled);
      }
      if (!known && !bot && !viewing) { // looking at a chosen version never makes a visitor
        const cookie = `${ID_COOKIE}=${id}; Path=/; Max-Age=${ONE_YEAR_S}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}${opts.cookieDomain ? `; Domain=${opts.cookieDomain}` : ''}`;
        headers['set-cookie'] = [...asArray(headers['set-cookie']), cookie];
      }
      // The click script (opt-in) and the page-speed script (lcp_ms or cls guardrails), added to the end of every
      // uncompressed page. A compressed page is passed through untouched, so it isn't measured in the browser.
      const tags = [opts.onClick ? `<script src="${OWN_PREFIX}clicks.js" defer></script>` : '', vitals && tracked ? `<script src="${OWN_PREFIX}vitals.js" defer></script>` : ''].join('');
      const addScript = tags !== '' && /text\/html/i.test(String(headers['content-type'] ?? '')) && !headers['content-encoding'] && method !== 'HEAD';
      if (addScript) delete headers['content-length'];
      res.writeHead(status, headers);
      upstreamRes.pipe(res, { end: !addScript });
      if (addScript) upstreamRes.on('end', () => res.end(tags));
      upstreamRes.on('end', () => finish(status, latencyMs));
      upstreamRes.on('error', () => res.destroy()); // a body cut mid-way must not look complete
    };
    const open = () => client.request(url, { method, headers: upstreamHeaders, timeout: upstreamTimeoutMs, lookup: upstreamLookup }, onResponse);
    let upstreamReq = open();
    let retried = false;
    const wire = (r: http.ClientRequest) => {
      r.on('timeout', () => {
        timedOut = true;
        r.destroy(new Error('upstream timeout'));
      });
      r.on('error', (error: NodeJS.ErrnoException) => {
        // An app closes an idle kept-alive connection just as the proxy reuses it: the request fails before any
        // answer (ECONNRESET). A GET or HEAD has no body to lose, so it is sent once more on a fresh connection; the
        // visitor (already counted by Flagsmith) would otherwise get a 502 for nothing.
        if (!retried && !timedOut && !res.headersSent && (method === 'GET' || method === 'HEAD') && (error.code === 'ECONNRESET' || error.code === 'EPIPE')) {
          retried = true;
          upstreamReq = open();
          wire(upstreamReq);
          upstreamReq.end();
          return;
        }
        const status = timedOut ? 504 : 502;
        if (!res.headersSent) {
          if (debugging) res.setHeader('x-turnout-release', release); // which version failed, for Turnout's checks
          plain(res, status, timedOut ? 'Turnout: this version of the app took too long to answer.\n' : 'Turnout: this version of the app is unreachable.\n');
        } else {
          res.destroy();
        }
        finish(status, elapsed());
      });
    };
    wire(upstreamReq);
    // The visitor went away: stop the app's work too.
    res.on('close', () => {
      if (!res.writableFinished) upstreamReq.destroy();
    });
    req.on('aborted', () => upstreamReq.destroy());
    req.pipe(upstreamReq);
  };

  // GET /__turnout/receipt, /preview, /preview/off and /health. Never records an exposure.
  // A release name from the view cookie or the view link, if it's one this proxy may route to.
  const viewedRelease = (raw: string | undefined): string | undefined => {
    if (!raw) return undefined;
    let name: string;
    try {
      name = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    return config.releases.has(name) ? name : undefined;
  };

  const ownEndpoint = async (o: { req: http.IncomingMessage; res: http.ServerResponse; url: { pathname: string; search: string }; identity: string | undefined; previewing: boolean; viewing?: string | undefined }) => {
    const { res, identity } = o;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const pathname = o.url.pathname;
    const params = new URLSearchParams(o.url.search);

    // Page speed in real browsers (lcp_ms, cls guardrails): the script, and its one report per page. Recorded only for a
    // counted visitor (their own cookie, a release they were served), as their Flagsmith events; never for a bot or a
    // view of one chosen version.
    if (vitals && pathname === `${OWN_PREFIX}vitals.js`) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return void res.end(VITALS_SCRIPT);
    }
    if (vitals && pathname === `${OWN_PREFIX}vitals` && o.req.method === 'POST') {
      let text = '';
      o.req.setEncoding('utf8');
      for await (const chunk of o.req) {
        text += chunk;
        if (text.length > 512) return void res.writeHead(413).end();
      }
      const served = identity && !o.viewing ? servedTo.get(identity) : undefined;
      let report: ReturnType<typeof parseVitals> = null;
      try {
        report = parseVitals(JSON.parse(text));
      } catch {}
      if (served && report && identity) {
        track(VITALS_REPORTED, identity); // who reported: the means count everyone else as 0 (config.ts)
        if (report.lcp !== null && config.guardrails.includes('lcp_ms')) track('lcp_ms', identity, report.lcp);
        if (report.cls !== null && config.guardrails.includes('cls')) track('cls', identity, report.cls);
      }
      return void res.writeHead(204, { 'cache-control': 'no-store' }).end();
    }
    // The click script (opt-in, Try it only): what a visitor clicks or sends, by its visible label. Never what they type.
    if (opts.onClick && pathname === `${OWN_PREFIX}clicks.js`) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return void res.end(CLICK_SCRIPT);
    }
    if (opts.onClick && pathname === `${OWN_PREFIX}click` && o.req.method === 'POST') {
      let text = '';
      o.req.setEncoding('utf8');
      for await (const chunk of o.req) {
        text += chunk;
        if (text.length > 2048) return void res.writeHead(413).end();
      }
      try {
        const b = JSON.parse(text) as { kind?: unknown; label?: unknown; target?: unknown };
        const kind = b.kind === 'submit' || b.kind === 'link' || b.kind === 'button' ? b.kind : null;
        if (kind) opts.onClick({ kind, label: String(b.label ?? '').slice(0, 80), target: String(b.target ?? '').slice(0, 200), identity, release: o.viewing ?? (identity ? servedTo.get(identity) : undefined) ?? null });
      } catch {}
      return void res.writeHead(204, { 'cache-control': 'no-store' }).end();
    }

    if (pathname === `${OWN_PREFIX}health`) {
      const status = flags.status?.() ?? null;
      // With the debug token, also ask each release's container (`turnout doctor` uses this: the shops sit on a
      // network only the proxy can reach). Never without it, so a public request can't fan out to the apps.
      const debug = !!debugToken && safeEqual(header(o.req, 'x-turnout-debug'), debugToken);
      const upstreams = debug ? await probeUpstreams(config) : undefined;
      return send(200, {
        ok: true,
        flagsmith: status,
        liveRelease: live ?? config.fallback,
        fallbacks: Object.fromEntries([...fallbacks].map(([k, v]) => [k, v.count])),
        undeliveredEvents: receipts?.undelivered ?? 0,
        ...(upstreams ? { upstreams } : {}),
        ...(debug ? { trackedEvents: Object.fromEntries(trackedEvents), droppedBySdk: receipts?.droppedBySdk ?? 0, heldMax: receipts?.heldMax ?? 0, eventBatches: receipts?.batches } : {}),
      });
    }
    if (pathname === `${OWN_PREFIX}preview` || pathname === `${OWN_PREFIX}preview/off`) {
      const off = pathname.endsWith('/off');
      if (!previewToken || !previewMark || (!off && !safeEqual(params.get('token') ?? undefined, previewToken))) {
        return send(403, { error: 'Not a valid preview link.' });
      }
      const secure = opts.secureCookies || isHttps(o.req) ? '; Secure' : '';
      const cookie = off
        ? `${PREVIEW_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`
        : `${PREVIEW_COOKIE}=${previewMark}; Path=/; Max-Age=${7 * 24 * 60 * 60}; HttpOnly; SameSite=Lax${secure}`;
      res.writeHead(303, { location: '/', 'set-cookie': cookie, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      return void res.end();
    }
    if (opts.viewSwitch && (pathname === `${OWN_PREFIX}view` || pathname === `${OWN_PREFIX}view/off`)) {
      const off = pathname.endsWith('/off');
      const wanted = off ? undefined : viewedRelease(params.get('release') ?? undefined);
      if (!off && !wanted) return send(400, { error: `Not a release here: ${[...config.releases.keys()].join(', ')}` });
      const secure = opts.secureCookies || isHttps(o.req) ? '; Secure' : '';
      const cookie = off
        ? `${VIEW_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`
        : `${VIEW_COOKIE}=${encodeURIComponent(wanted!)}; Path=/; Max-Age=${24 * 60 * 60}; HttpOnly; SameSite=Lax${secure}`;
      res.writeHead(303, { location: '/', 'set-cookie': cookie, 'cache-control': 'no-store' });
      return void res.end();
    }
    if (pathname !== `${OWN_PREFIX}receipt`) return send(404, { error: 'not found' });
    if (o.viewing) return send(200, { variant: null, release: o.viewing, enrolled: false, viewing: true, receipt: null });
    // No cookie yet (a first load): a normal answer, not an error, so a browser's console stays clean.
    if (!identity) return send(200, { visitor: null, variant: null, release: null, enrolled: false, receipt: null });
    let assignment: Assignment | undefined;
    if (!flags.ready || flags.ready()) {
      try {
        assignment = await assign(identity, false, o.previewing ? { preview: 'true' } : undefined); // as the pages route it
      } catch {
        // reported as not assigned
      }
    }
    send(200, {
      variant: assignment?.variant ?? null,
      release: assignment?.release ?? null,
      enrolled: assignment?.enrolled ?? false,
      receipt: receipts?.get(identity) ?? null,
    });
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error: Error) => {
      warn(`turnout: request failed: ${error.message}`);
      if (!res.headersSent) plain(res, 502, 'Turnout: internal error.\n');
      else res.destroy();
    });
  });
  // WebSockets and other upgrades aren't routed: say so instead of hanging.
  server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 501 Not Implemented\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
  });
  return server;
}

const FALLBACK_TEXT: Record<string, string> = {
  'not-ready': "Flagsmith's environment document hasn't arrived yet",
  deadline: 'the flag took too long to evaluate',
  error: 'the flag evaluation failed',
  'unknown-release': "the flag's value isn't a release in turnout.config.yml",
  'flag-off': 'the flag is off or missing',
};

// Accepts only "/path?query" request targets. Absolute-form ("http://x/"), authority-form and scheme-relative
// paths ("//host/…", "/\host") are refused, so a request can never pick the host Turnout connects to.
export function originForm(raw: string): { pathname: string; search: string } | null {
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  try {
    const base = 'http://turnout.invalid';
    const url = new URL(raw, base);
    if (url.origin !== base) return null;
    return { pathname: url.pathname, search: url.search };
  } catch {
    return null;
  }
}

/** The release a same-host Referer was viewing (its __turnout_view parameter), if any. */
export function refererView(referer: string | undefined, host: string | undefined): string | undefined {
  if (!referer || !host) return undefined;
  try {
    const from = new URL(referer);
    if (from.host !== host) return undefined;
    return from.searchParams.get(VIEW_PARAM) ?? undefined;
  } catch {
    return undefined;
  }
}

export function isDocumentRequest(req: http.IncomingMessage): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const dest = req.headers['sec-fetch-dest'];
  if (dest) return dest === 'document';
  return (req.headers.accept ?? '').includes('text/html');
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

// GET / on each allowlisted release's container, as Compose's own healthcheck does. Any answer below 500 counts.
export type UpstreamProbe = { ok: boolean; status?: number; ms: number; error?: string };
async function probeUpstreams(config: Config, timeoutMs = 3000): Promise<Record<string, UpstreamProbe>> {
  const entries = await Promise.all(
    [...config.releases].map(async ([label, url]): Promise<[string, UpstreamProbe]> => {
      const started = performance.now();
      const ms = () => Math.round(performance.now() - started);
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
        await res.body?.cancel();
        return [label, { ok: res.status < 500, status: res.status, ms: ms() }];
      } catch (error) {
        const cause = (error as { cause?: { code?: string } }).cause?.code;
        return [label, { ok: false, ms: ms(), error: (error as Error).name === 'TimeoutError' ? `no answer in ${timeoutMs} ms` : (cause ?? 'unreachable') }];
      }
    }),
  );
  return Object.fromEntries(entries);
}

function safeEqual(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function asArray(value: string | string[] | number | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [String(value)];
}

function isHttps(req: http.IncomingMessage): boolean {
  return !!(req.socket as { encrypted?: boolean }).encrypted || header(req, 'x-forwarded-proto') === 'https';
}

function stripHopByHop(headers: http.IncomingHttpHeaders): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = { ...headers };
  const listed = String(headers.connection ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  for (const name of [...HOP_BY_HOP, ...listed]) delete out[name];
  return out;
}

function forwardHeaders(req: http.IncomingMessage, upstream: URL, secure: boolean): http.OutgoingHttpHeaders {
  const headers = stripHopByHop(req.headers);
  headers.host = upstream.host; // the app's own name, and the TLS server name for an https release
  const origin = rewriteOrigin(header(req, 'origin'), req.headers.host, upstream, false);
  if (origin) headers.origin = origin;
  const referer = rewriteOrigin(header(req, 'referer'), req.headers.host, upstream, true);
  if (referer) headers.referer = referer;
  delete headers['x-turnout-debug'];
  delete headers[RELEASE_HEADER]; // set by Turnout only, never by a client
  // Turnout's own cookies stay between the visitor and Turnout.
  const cookie = (req.headers.cookie ?? '')
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith(`${ID_COOKIE}=`) && !c.startsWith(`${PREVIEW_COOKIE}=`) && !c.startsWith(`${VIEW_COOKIE}=`))
    .join('; ');
  if (cookie) headers.cookie = cookie;
  else delete headers.cookie;
  const forwardedFor = header(req, 'x-forwarded-for');
  const clientIp = req.socket.remoteAddress ?? '';
  headers['x-forwarded-for'] = forwardedFor ? `${forwardedFor}, ${clientIp}` : clientIp;
  headers['x-forwarded-host'] = req.headers.host ?? '';
  headers['x-forwarded-proto'] = header(req, 'x-forwarded-proto') ?? (secure ? 'https' : 'http');
  return headers;
}

function responseHeaders(incoming: http.IncomingHttpHeaders, upstream: URL, secure: boolean): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = stripHopByHop(incoming);
  delete headers[EVENT_HEADER]; // meant for Turnout only, on every path
  // Responses differ per visitor, so shared caches must never store them.
  headers['cache-control'] = privateCacheControl(incoming['cache-control']);
  headers.vary = appendVary(incoming.vary);
  // The app sees its own host; a redirect to it must stay on the visitor's. A release mounted under a path
  // (https://docs.example/guide/) has that prefix taken off again, since the proxy adds it to every request.
  const location = incoming.location;
  if (location) {
    try {
      const to = new URL(location, upstream);
      if (to.origin === upstream.origin) headers.location = stripPrefix(to.pathname, upstream) + to.search + to.hash;
    } catch {
      // leave an unparseable Location alone
    }
  }
  // A cookie scoped to the app's own domain (Domain=example.com) would be refused by the browser on Turnout's
  // host: make it a host-only cookie for the visitor's host instead. An https release's Secure cookies would be
  // refused too when visitors reach Turnout over plain http (anywhere but localhost), so they lose Secure there.
  const cookies = incoming['set-cookie'];
  if (cookies) headers['set-cookie'] = cookies.map((c) => hostOnlyCookie(c, !secure));
  return headers;
}

function stripPrefix(pathname: string, upstream: URL): string {
  const prefix = upstream.pathname.replace(/\/$/, '');
  if (!prefix) return pathname;
  if (pathname === prefix) return '/';
  return pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length) : pathname;
}

export function hostOnlyCookie(cookie: string, dropSecure = false): string {
  // __Secure- and __Host- cookies are only ever accepted with Secure: leave those as they are.
  const keepSecure = !dropSecure || /^\s*__(secure|host)-/i.test(cookie);
  return cookie
    .split(';')
    .filter((part, i) => i === 0 || !(/^\s*domain\s*=/i.test(part) || (!keepSecure && /^\s*secure\s*$/i.test(part))))
    .join(';');
}

// Origin and Referer name the visitor's host (Turnout's); an app that checks them against its own host (CSRF
// protection in Django, Rails, many form handlers) would refuse every POST. Same-host values are rewritten to the
// release's origin; anything else passes unchanged.
function rewriteOrigin(value: string | undefined, visitorHost: string | undefined, upstream: URL, pathToo: boolean): string | undefined {
  if (!value || !visitorHost) return value;
  try {
    const u = new URL(value);
    if (u.host !== visitorHost) return value;
    if (!pathToo) return upstream.origin;
    const base = upstream.pathname.replace(/\/$/, '');
    return upstream.origin + base + u.pathname + u.search;
  } catch {
    return value;
  }
}

export type AppEvent = { event: string; value?: number };

// "signup, plan_chosen;value=49" → valid entries only, at most MAX_HEADER_EVENTS. Guardrail names are refused: those
// are Turnout's own measurements.
export function parseEventHeader(raw: string | string[] | undefined): AppEvent[] {
  if (raw === undefined) return [];
  const out: AppEvent[] = [];
  for (const entry of (Array.isArray(raw) ? raw.join(',') : raw).split(',')) {
    if (out.length >= MAX_HEADER_EVENTS) break;
    const [name = '', ...params] = entry.split(';').map((p) => p.trim());
    if (!EVENT_NAME.test(name) || (GUARDRAILS as readonly string[]).includes(name)) continue;
    let value: number | undefined;
    let ok = true;
    for (const p of params) {
      const m = p.match(/^value=(-?\d+(?:\.\d+)?)$/i);
      if (m) value = Number(m[1]);
      else ok = false;
    }
    if (ok) out.push(value === undefined ? { event: name } : { event: name, value });
  }
  return out;
}

function privateCacheControl(value: string | undefined): string {
  if (!value) return 'private';
  if (/\b(private|no-store)\b/i.test(value)) return value;
  return `private, ${value.replace(/\bpublic\b,?\s*/i, '')}`.replace(/,\s*$/, '');
}

function appendVary(value: string | string[] | undefined): string {
  const current = Array.isArray(value) ? value.join(', ') : (value ?? '');
  if (/\bcookie\b/i.test(current)) return current;
  return current ? `${current}, Cookie` : 'Cookie';
}

function plain(res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

// Release hostnames, resolved once and kept. Node resolves names on a small shared thread pool (4 threads); when
// Flagsmith is unreachable, the SDK's lookups of its hostname hang (about 5 s each in Docker) and fill that pool, so
// a visitor's request waited seconds just to resolve "shop-1-4" (measured: 4.4 s mean with Flagsmith stopped). A
// cached answer is re-resolved in the background after 30 s; on a failed lookup the last good address is kept.
const LOOKUP_TTL_MS = 30_000;
type Cached = { addresses: dns.LookupAddress[]; at: number; refreshing?: boolean };
const lookupCache = new Map<string, Cached>();
export const upstreamLookup: LookupFunction = (hostname, options, callback) => {
  const opts = (typeof options === 'number' ? { family: options } : options ?? {}) as dns.LookupOptions;
  const family = opts.family ?? 0;
  const key = `${hostname}/${family}`;
  const answer = (c: Cached, done: typeof callback) => {
    if (opts.all) (done as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, c.addresses);
    else done(null, c.addresses[0]!.address, c.addresses[0]!.family);
  };
  const hit = lookupCache.get(key);
  const resolve = (done?: typeof callback) =>
    dns.lookup(hostname, { family, all: true } as dns.LookupAllOptions, (err, addresses) => {
      if (!err && addresses.length) {
        const c = { addresses, at: Date.now() };
        lookupCache.set(key, c);
        if (done) answer(c, done);
        return;
      }
      if (hit) hit.refreshing = false;
      done?.(err ?? Object.assign(new Error(`no address for ${hostname}`), { code: 'ENOTFOUND' }), '', 0);
    });
  if (hit) {
    if (Date.now() - hit.at > LOOKUP_TTL_MS && !hit.refreshing) {
      hit.refreshing = true;
      resolve();
    }
    process.nextTick(() => answer(hit, callback));
    return;
  }
  resolve(callback);
};
