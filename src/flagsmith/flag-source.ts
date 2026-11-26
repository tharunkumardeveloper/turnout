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

export function createFlagSource(opts: Options): FlagSource & { close(): Promise<void>; receipts: Receipts } {
  const receipts = new Receipts(opts.onUndelivered);
  let environmentAt: number | null = null;
  let lastError: string | null = null;

  const flagsmith = new Flagsmith({
    environmentKey: opts.serverKey,
    apiUrl: opts.apiUrl,
    enableLocalEvaluation: true,
    environmentRefreshIntervalSeconds: opts.refreshSeconds ?? 5,
    // A visitor must never wait on Flagsmith: short requests, no retries. Until the first environment document
    // arrives the proxy routes to the last known live release without asking the SDK (see ready()).
    requestTimeoutSeconds: 2,
    retries: 0,
    enableAnalytics: true,
    enableEvents: true,
    // The SDK posts its whole buffer as one batch, one batch at a time, and while a batch is in flight a full buffer
    // drops its oldest events. Flush every second so batches stay small; the buffer is capped by Flagsmith's 2 MiB body
    // limit (experimentation/constants.py:39), since the SDK never splits a batch: 7,000 events of the largest kind
    // Turnout sends (a 100-character event name, 281 bytes) are 1.97 MB. Drops are counted (dropLogger below).
    eventProcessorConfig: { eventsApiUrl: eventsApiUrlFor(opts.apiUrl), flushInterval: 1000, maxBuffer: MAX_EVENT_BUFFER, requestTimeoutMs: 15_000 },
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

  return {
    ready: () => environmentAt !== null,
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
      flagsmith.trackEvent(event, value === undefined ? { identifier: identity } : { identifier: identity, value });
    },
    close: () => flagsmith.close(),
    receipts,
  };
}
