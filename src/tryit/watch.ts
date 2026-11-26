// What Turnout learns by watching traffic (docs/PLAN.md steps 3, 5 and 6): every request through the proxy as a
// pattern with its status and the version that served it, the visitors a test needs, and simulated visitors that keep
// running at a low rate.

/** A request path as a pattern: ids, numbers and hashes become *. "/product/42" → "/product/*". */
export function patternOf(path: string): string {
  const clean = (path.split('?')[0] ?? '/').replace(/\/+$/, '') || '/';
  return clean
    .split('/')
    .map((seg) => (/^\d+$|^[0-9a-f]{8,}$|^[0-9a-f-]{36}$|^[A-Za-z0-9_-]{20,}$/i.test(seg) ? '*' : seg))
    .join('/') || '/';
}

const ASSET = /\.(css|js|mjs|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf)$/i;

export type SeenAction = { action: string; count: number; byRelease: Record<string, number>; statuses: Record<string, number> };

/** Server actions seen through the proxy, most frequent first. Assets and Turnout's own paths are left out. */
export class ActionLog {
  private seen = new Map<string, SeenAction>();
  record(e: { method: string; path: string; status: number; release: string }): void {
    if (ASSET.test(e.path.split('?')[0] ?? '') || e.path.startsWith('/__turnout') || e.path.startsWith('/_next/')) return;
    const action = `${e.method} ${patternOf(e.path)}`;
    const a = this.seen.get(action) ?? { action, count: 0, byRelease: {}, statuses: {} };
    a.count++;
    a.byRelease[e.release] = (a.byRelease[e.release] ?? 0) + 1;
    const s = `${Math.floor(e.status / 100)}xx`;
    a.statuses[s] = (a.statuses[s] ?? 0) + 1;
    if (!this.seen.has(action) && this.seen.size >= 500) return;
    this.seen.set(action, a);
  }
  list(): SeenAction[] {
    return [...this.seen.values()].sort((x, y) => y.count - x.count);
  }
  clear(): void {
    this.seen.clear();
  }
}

/**
 * Visitors each version needs to see a relative lift `mde` on a goal converting at `base` (80% power, 5% two-sided:
 * n = 16·p(1−p)/δ²), never below Flagsmith's 50 visitors, and enough for its 5 conversions.
 */
export function visitorsNeeded(base: number, mde = 0.2): number {
  const p = Math.min(0.99, Math.max(0.005, base));
  const delta = p * mde;
  return Math.max(50, Math.ceil(5 / p), Math.ceil((16 * p * (1 - p)) / (delta * delta)));
}

/** Simulated visitors at a low, steady rate until stopped: `send(n)` every `everyMs`, never two batches at once. */
export function createTrickle(send: (visitors: number) => Promise<void>, everyMs = 60_000) {
  let timer: NodeJS.Timeout | null = null;
  let perMinute = 0;
  let busy = false;
  let lastError: string | null = null;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await send(Math.max(1, Math.round((perMinute * everyMs) / 60_000)));
      lastError = null;
    } catch (error) {
      lastError = (error as Error).message;
    } finally {
      busy = false;
    }
  };
  return {
    start(rate: number) {
      perMinute = Math.min(600, Math.max(1, Math.round(rate)));
      if (timer) clearInterval(timer);
      timer = setInterval(() => void tick(), everyMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    status: () => ({ on: Boolean(timer), perMinute: timer ? perMinute : 0, lastError }),
  };
}
