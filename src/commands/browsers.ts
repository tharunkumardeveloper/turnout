// turnout browsers: real-browser visits, so page speed has a Flagsmith verdict before any real traffic. Each visit is a
// fresh, empty browser profile in a headless Chrome (Chrome DevTools Protocol, over Node's built-in WebSocket): it
// loads the site through the simulation proxy, so Flagsmith assigns it a version, waits for the page to settle, then
// leaves, which is when Turnout's page-speed script reports largest paint and layout shift. Every visit's user agent
// ends with TurnoutBrowserVisit/1.0, so they are labelled as automated; they go to the separate Demo (simulated)
// environment, like turnout simulate, never to your real experiment.
import { lookup } from 'node:dns/promises';

export const BROWSER_VISIT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 TurnoutBrowserVisit/1.0';

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };
export type Cdp = {
  send: (method: string, params?: object, sessionId?: string) => Promise<any>;
  once: (method: string, sessionId: string, ms: number) => Promise<any>;
  close: () => void;
};

/**
 * The browser's DevTools WebSocket. Chrome refuses DevTools requests whose Host header is a name other than localhost,
 * so a Chrome in another container is reached by its IP address.
 */
export async function connectChrome(chromeUrl: string): Promise<Cdp> {
  const u = new URL(chromeUrl);
  const host = /^[\d.]+$|^\[|^localhost$/.test(u.hostname) ? u.hostname : (await lookup(u.hostname, { family: 4 })).address;
  const base = `${u.protocol}//${host}:${u.port || 9222}`;
  const version = (await (await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(10_000) })).json()) as { webSocketDebuggerUrl: string };
  const wsUrl = version.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://${host}:${u.port || 9222}`);
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error(`couldn't open Chrome's DevTools socket at ${wsUrl}`)), { once: true });
  });
  let id = 0;
  const pending = new Map<number, Pending>();
  const waiters: { method: string; sessionId: string; resolve: (v: any) => void }[] = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(`${msg.error.message}`));
      else p?.resolve(msg.result);
      return;
    }
    const i = waiters.findIndex((w) => w.method === msg.method && w.sessionId === msg.sessionId);
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(msg.params);
  });
  return {
    send: (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const n = ++id;
        pending.set(n, { resolve, reject });
        ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
      }),
    once: (method, sessionId, ms) =>
      new Promise((resolve, reject) => {
        const w = { method, sessionId, resolve };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) {
            waiters.splice(i, 1);
            reject(new Error(`no ${method} within ${ms / 1000} s`));
          }
        }, ms);
      }),
    close: () => ws.close(),
  };
}

/** One visit: a fresh profile, the page, a pause for it to settle, then leaving it (the page-speed script reports). */
export async function browserVisit(cdp: Cdp, target: string, opts: { settleMs?: number; timeoutMs?: number; latencyMs?: number } = {}): Promise<void> {
  const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Network.enable', {}, sessionId);
    await cdp.send('Network.setUserAgentOverride', { userAgent: BROWSER_VISIT_UA }, sessionId);
    // Added latency per request (Chrome's own network emulation), to measure as if over a real network.
    if (opts.latencyMs) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: opts.latencyMs, downloadThroughput: -1, uploadThroughput: -1 }, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    const loaded = cdp.once('Page.loadEventFired', sessionId, opts.timeoutMs ?? 30_000);
    await cdp.send('Page.navigate', { url: target }, sessionId);
    await loaded;
    await new Promise((r) => setTimeout(r, opts.settleMs ?? 1000));
    const left = cdp.once('Page.loadEventFired', sessionId, 10_000).catch(() => null);
    await cdp.send('Page.navigate', { url: 'about:blank' }, sessionId); // pagehide: the report goes out
    await left;
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  }
}

/** Visits in a few parallel lanes; returns how many finished and the first errors. */
export async function browserVisits(o: {
  chromeUrl: string;
  target: string;
  visits: number;
  lanes?: number;
  latencyMs?: number;
  log?: (line: string) => void;
  connect?: (url: string) => Promise<Cdp>;
}): Promise<{ done: number; failed: number; errors: string[] }> {
  const log = o.log ?? console.log;
  const cdp = await (o.connect ?? connectChrome)(o.chromeUrl);
  let next = 0;
  let done = 0;
  let failed = 0;
  const errors: string[] = [];
  const lane = async () => {
    while (next < o.visits) {
      next++;
      try {
        await browserVisit(cdp, o.target, { ...(o.latencyMs ? { latencyMs: o.latencyMs } : {}) });
        done++;
        if (done % 25 === 0) log(`  ${done} of ${o.visits} visits`);
      } catch (error) {
        failed++;
        if (errors.length < 3) errors.push((error as Error).message);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(o.lanes ?? 4, o.visits)) }, lane));
  } finally {
    cdp.close();
  }
  return { done, failed, errors };
}
