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
    // The SDK's defaults (flush every 10 s, a 1,000-event buffer, a 3 s timeout) dropped events under demo load:
    // a full buffer drops its oldest events while a batch is in flight, and slow batches time out. Smaller, more
    // frequent batches with room to queue and time to land; 6,000 events stay well under Flagsmith's 2 MB body
    // limit (experimentation/constants.py:39).
    eventProcessorConfig: { eventsApiUrl: eventsApiUrlFor(opts.apiUrl), flushInterval: 2000, maxBuffer: 6000, requestTimeoutMs: 15_000 },
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
