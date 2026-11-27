import { localSnapshot, type FlagSnapshot } from './settings-check.ts';
import { Flag, Flagsmith, type FlagsmithConfig } from '@flagsmith/nodejs';
import type { Assignment, FlagSource, FlagSourceStatus } from '../proxy/server.ts';
import { receiptFetch, Receipts, type Receipt } from './receipts.ts';

type Options = {
  apiUrl: string;
  serverKey: string;
  flag: string;
  refreshSeconds?: number;
  fetch?: FlagsmithConfig['fetch'];
  onUndelivered?: (receipt: Receipt) => void; // events Flagsmith didn't accept
};

// "http://flagsmith:8000/api/v1/" -> "http://flagsmith:8000/api/"; the SDK appends "v1/events" itself.
export function eventsApiUrlFor(apiUrl: string): string {
  return apiUrl.replace(/v1\/?$/, '');
}

export const MAX_EVENT_BUFFER = 7000;
// Turnout's own events wait above this many in the SDK's buffer. The SDK sends its whole buffer as one batch, so this
// also caps a batch near 2,000 events: one that posts in a few seconds even when Flagsmith is busy. Measured on a
// 2-vCPU VM: 7,000-event batches took over 15 s under load, timed out, and the SDK's retries kept Flagsmith overloaded.
// The other 5,000 places are room for the exposures the SDK records itself.
export const HOLD_AT = 2000;
export const QUEUE_CAP = 100_000;

// The SDK reports events it drops (a full buffer while a batch is in flight) only as log warnings. This logger counts
// them as undelivered, so /__turnout/health and doctor show the loss instead of it passing silently.
export function dropLogger(receipts: Receipts, write: (line: string) => void = (l) => process.stderr.write(`${l}
`)) {
  const out = (level: string, args: unknown[]) => {
    const msg = args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    write(JSON.stringify({ level, msg }));
    return msg;
  };
  return {
    debug: () => {},
    info: () => {},
    error: (...args: unknown[]) => void out('error', args),
    warn: (...args: unknown[]) => {
      const msg = out('warn', args);
      const many = msg.match(/Dropping its (\d+) oldest events/);
      if (many) receipts.dropped(Number(many[1]));
      else if (/Dropping its oldest event/.test(msg)) receipts.dropped(1);
    },
  };
}

export function createFlagSource(opts: Options): FlagSource & { close(): Promise<void>; receipts: Receipts; held(): number; snapshot(): FlagSnapshot } {
  const receipts = new Receipts(opts.onUndelivered);
  let environmentAt: number | null = null;
  let lastError: string | null = null;

  const flagsmith = new Flagsmith({
    environmentKey: opts.serverKey,
    apiUrl: opts.apiUrl,
    enableLocalEvaluation: true,
    environmentRefreshIntervalSeconds: opts.refreshSeconds ?? 5,
    // A visitor never waits on Flagsmith: flags are evaluated locally, and this timeout is for the background refresh
    // of the environment document. Until the first document arrives the proxy routes to the last known live release
    // (see ready()). 2 s was too short on a busy machine (a Docker build, a visitor run): refreshes kept timing out,
    // the proxy kept routing on a document from before the test started, and every visitor went to A.
    requestTimeoutSeconds: 10,
    retries: 0,
    enableAnalytics: true,
    enableEvents: true,
    // The SDK posts its whole buffer as one batch, one batch at a time, and while a batch is in flight a full buffer
    // drops its oldest events. Flush every second so batches stay small; the buffer is capped by Flagsmith's 2 MiB body
    // limit (experimentation/constants.py:39), since the SDK never splits a batch: 7,000 events of the largest kind
    // Turnout sends (a 100-character event name, 281 bytes) are 1.97 MB. Drops are counted (dropLogger below).
    eventProcessorConfig: { eventsApiUrl: eventsApiUrlFor(opts.apiUrl), flushInterval: 1000, maxBuffer: MAX_EVENT_BUFFER, requestTimeoutMs: 30_000 },
    logger: dropLogger(receipts) as unknown as FlagsmithConfig['logger'],
    fetch: receiptFetch(receipts, opts.fetch ?? fetch),
    onEnvironmentChange: (error) => {
      if (error) lastError = error.message;
      else {
        environmentAt = Date.now();
        lastError = null;
      }
    },
  });

  // Back-pressure: the SDK sends one batch at a time and, while it's in flight, a full buffer drops its oldest events.
  // So Turnout holds its own events back once the SDK's buffer passes HOLD_AT (the rest is room for the exposures the
  // SDK records itself) and feeds them in as it empties. Only beyond QUEUE_CAP (about 20 MB) are events dropped, and
  // counted. The SDK's buffer length is read from its event processor (@flagsmith/nodejs 9.4.0); if a later version
  // hides it, events go straight to the SDK as before.
  const sdkBuffered = (): number | null => {
    const b = (flagsmith as unknown as { eventProcessor?: { buffer?: unknown[] } }).eventProcessor?.buffer;
    return Array.isArray(b) ? b.length : null;
  };
  type Held = { event: string; opts: { identifier: string; value?: number } };
  const held: Held[] = [];
  const room = () => {
    const n = sdkBuffered();
    return n === null || n < HOLD_AT;
  };
  const drain = () => {
    while (held.length && room()) {
      const h = held.shift()!;
      flagsmith.trackEvent(h.event, h.opts);
    }
  };
  const drainTimer = setInterval(drain, 100);
  drainTimer.unref?.();

  return {
    ready: () => environmentAt !== null,
    // The flag as this copy holds it, for the settings check (settings-check.ts).
    snapshot: () => localSnapshot(flagsmith, opts.flag),
    status: (): FlagSourceStatus => ({
      ready: environmentAt !== null,
      environmentAgeSeconds: environmentAt === null ? null : Math.round((Date.now() - environmentAt) / 1000),
      lastError,
    }),
    async assign(identity, { recordExposure, traits }): Promise<Assignment> {
      const flag = recordExposure
        ? await flagsmith.getExperimentFlag(opts.flag, identity, traits)
        : (await flagsmith.getIdentityFlags(identity, traits)).getFlag(opts.flag);
      if (!(flag instanceof Flag) || !flag.enabled) return { variant: 'control', release: undefined, enrolled: false };
      return {
        variant: flag.variant ?? 'control',
        release: flag.value == null ? undefined : String(flag.value),
        enrolled: !!flag.experiment?.inExperiment,
      };
    },
    track(event, identity, value) {
      const opts = value === undefined ? { identifier: identity } : { identifier: identity, value };
      if (!held.length && room()) return void flagsmith.trackEvent(event, opts);
      held.push({ event, opts });
      receipts.heldMax = Math.max(receipts.heldMax, held.length);
      if (held.length > QUEUE_CAP) {
        held.shift();
        receipts.dropped(1);
      }
    },
    close: async () => {
      clearInterval(drainTimer);
      // Hand over what's held as room appears, for up to 10 s; whatever is left then is counted as dropped.
      for (const until = Date.now() + 10_000; held.length && Date.now() < until; ) {
        drain();
        if (held.length) await new Promise((r) => setTimeout(r, 100));
      }
      if (held.length) receipts.dropped(held.splice(0).length);
      await flagsmith.close();
    },
    held: () => held.length,
    receipts,
  };
}
