// Per-visitor receipts: what Flagsmith's events endpoint said about this visitor's events.
// The SDK posts batches of { events: [...] }; Flagsmith answers 202 { accepted, rejected: [{ index, error }] },
// 400 when every event is invalid, or 404 when the environment has no event store.

export type Receipt = {
  at: number;
  event: string;
  status: 'accepted' | 'rejected' | 'batch_rejected' | 'store_not_connected' | 'not_delivered';
  httpStatus: number;
  error?: string;
};

const MAX_VISITORS = 10_000;

export class Receipts {
  private byIdentity = new Map<string, Receipt>();
  private readonly onUndelivered: ((receipt: Receipt) => void) | undefined;
  undelivered = 0; // events Flagsmith didn't accept or the SDK dropped, since start (a retried attempt counts too)
  droppedBySdk = 0; // of those, dropped by the SDK before sending
  // Every events POST: how many, how big, how slow. A slow batch is what fills the SDK's buffer.
  batches = { count: 0, events: 0, maxEvents: 0, maxMs: 0, over5s: 0, failed: 0 };

  batch(events: number, ms: number, ok: boolean): void {
    const b = this.batches;
    b.count++;
    b.events += events;
    b.maxEvents = Math.max(b.maxEvents, events);
    b.maxMs = Math.max(b.maxMs, Math.round(ms));
    if (ms > 5000) b.over5s++;
    if (!ok) b.failed++;
  }

  constructor(onUndelivered?: (receipt: Receipt) => void) {
    this.onUndelivered = onUndelivered;
  }

  record(identity: string, receipt: Receipt): void {
    if (receipt.status !== 'accepted') {
      this.undelivered++;
      this.onUndelivered?.(receipt);
    }
    this.byIdentity.delete(identity); // re-insert keeps the newest at the end
    this.byIdentity.set(identity, receipt);
    if (this.byIdentity.size > MAX_VISITORS) {
      const oldest = this.byIdentity.keys().next().value;
      if (oldest !== undefined) this.byIdentity.delete(oldest);
    }
  }

  /** Events the SDK dropped before sending them (its buffer was full while a batch was in flight). */
  dropped(count: number): void {
    this.undelivered += count;
    this.droppedBySdk += count;
  }

  get(identity: string): Receipt | undefined {
    return this.byIdentity.get(identity);
  }
}

type SentEvent = { event: string; identifier: string | null };

// Wraps fetch for the SDK: event batches are matched to visitors, everything else (the environment document
// polls use the same fetch) passes straight through.
export function receiptFetch(receipts: Receipts, base: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!/\/v1\/events\/?$/.test(url) || init?.method !== 'POST' || typeof init.body !== 'string') {
      return base(input, init);
    }
    let sent: SentEvent[] = [];
    try {
      sent = (JSON.parse(init.body) as { events?: SentEvent[] }).events ?? [];
    } catch {
      // not ours to judge; send as is
    }

    let res: Response;
    const started = performance.now();
    try {
      res = await base(input, init);
      receipts.batch(sent.length, performance.now() - started, res.status === 202 || res.status === 200);
    } catch (error) {
      receipts.batch(sent.length, performance.now() - started, false);
      stamp(receipts, sent, () => ({ status: 'not_delivered', httpStatus: 0, error: (error as Error).message }));
      throw error;
    }

    const status = res.status;
    if (status === 202 || status === 200) {
      let rejected = new Map<number, string>();
      try {
        const body = (await res.clone().json()) as { rejected?: { index: number; error: string }[] };
        rejected = new Map((body.rejected ?? []).map((r) => [r.index, r.error]));
      } catch {
        // an unparseable body still means accepted
      }
      stamp(receipts, sent, (i) =>
        rejected.has(i) ? { status: 'rejected', httpStatus: status, error: rejected.get(i)! } : { status: 'accepted', httpStatus: status },
      );
    } else if (status === 400) {
      stamp(receipts, sent, () => ({ status: 'batch_rejected', httpStatus: status }));
    } else if (status === 404) {
      stamp(receipts, sent, () => ({ status: 'store_not_connected', httpStatus: status }));
    } else if (status >= 500) {
      stamp(receipts, sent, () => ({ status: 'not_delivered', httpStatus: status }));
    }
    return res;
  };
}

function stamp(receipts: Receipts, sent: SentEvent[], outcome: (index: number) => Omit<Receipt, 'at' | 'event'>): void {
  const at = Date.now();
  sent.forEach((e, i) => {
    if (e.identifier) receipts.record(e.identifier, { at, event: e.event, ...outcome(i) });
  });
}
