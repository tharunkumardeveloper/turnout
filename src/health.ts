// The health bridge and the guard.
//
// Health bridge: while an experiment runs, Turnout reports the release flag's health to Flagsmith's own Feature
// Health (a "Webhook" provider, features/feature_health/providers/webhook). A losing guardrail makes Flagsmith tag
// the flag "Unhealthy" in its dashboard, with Flagsmith's numbers and links as the reason; the next healthy report
// removes the tag. Reports go only on a change.
//
// Guard (opt-in): Turnout also asks Flagsmith for fresh results every 5 minutes (Flagsmith's own limit), and when
// a guardrail is clearly losing (chance to win at or under 1% by default) it reverts the experiment through the same
// steps as Revert, writing "reverted automatically by Turnout's guard" to the release ledger. It never ships.
import {
  CONTROL,
  losingGuardrails,
  releaseOf,
  type ExperimentDetail,
  type Experiments,
  type GuardrailWarning,
  type Results,
} from './flagsmith/experiments.ts';

export const REFRESH_EVERY_MS = 5 * 60 * 1000 + 5_000; // Flagsmith allows one results refresh per 5 minutes
export const DEFAULT_GUARD_THRESHOLD = 0.01;
export const DEFAULT_MIN_IDENTITIES = 100; // below this, results are too thin to act on automatically

export type Losing = GuardrailWarning & { variant: string; release: string | null; control: number | null; treatment: number | null };

export type HealthReport = {
  at: string;
  experimentId: number;
  status: 'healthy' | 'unhealthy';
  summary: string;
  delivered: boolean;
  error?: string;
};

export type GuardAction = { at: string; experimentId: number; text: string; ok: boolean };

export type WatchState = {
  running: boolean;
  lastCheckAt: string | null;
  lastError: string | null;
  health: { enabled: boolean; last: HealthReport | null };
  guard: { enabled: boolean; threshold: number; lastAction: GuardAction | null; lastRefreshAt: string | null };
};

export type WatchOptions = {
  experiments: () => Promise<Experiments>;
  flag: string;
  environmentName: string; // Feature Health events name the environment, not its key
  healthWebhookUrl?: string; // the Webhook provider's URL (its path is the secret)
  guard: { enabled: boolean; threshold?: number; minIdentities?: number };
  lock: { busy: boolean }; // shared with the console's Ship/Revert and judge jobs
  revert: (exps: Experiments, reason: string) => Promise<void>; // decide({ action: 'revert', by: 'guard' })
  links?: (experiment: ExperimentDetail) => { title: string; url: string }[];
  intervalMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
};

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

const meanOf = (results: Results | null, metricId: number, variant: string): number | null => {
  const v = results?.payload?.metrics.find((m) => m.metric_id === metricId)?.variants[variant];
  return v && v.n > 0 ? v.sum / v.n : null;
};

// Every guardrail a treatment is losing, with Flagsmith's means for both arms. A Mean metric's mean is over every
// exposed identity, an identity with no event counting as 0 (experimentation/results_query.py:123-124,184-196;
// warehouses/dialect.py:39-41), so it is diluted when some visitors send no events for it.
export function losingFor(experiment: ExperimentDetail, results: Results | null): Losing[] {
  const treatments = experiment.feature.multivariate_options.flatMap((o) => (o.key ? [o.key] : []));
  return treatments.flatMap((variant) =>
    losingGuardrails(experiment, results, variant).map((w) => {
      const metricId = experiment.metrics.find((m) => m.metric_name === w.metric)?.metric ?? -1;
      return { ...w, variant, release: releaseOf(experiment, variant), control: meanOf(results, metricId, CONTROL), treatment: meanOf(results, metricId, variant) };
    }),
  );
}

export function identitiesIn(results: Results | null): number {
  const first = results?.payload?.metrics[0];
  return first ? Object.values(first.variants).reduce((sum, v) => sum + v.n, 0) : 0;
}

const fmt = (x: number | null) => (x === null ? 'n/a' : Math.abs(x) >= 10 ? x.toFixed(0) : x.toFixed(3));

// The Webhook provider's payload (features/feature_health/providers/webhook/types.py).
export function healthPayload(o: {
  flag: string;
  environmentName: string;
  status: 'healthy' | 'unhealthy';
  experiment: ExperimentDetail;
  results: Results | null;
  losing: Losing[];
  note?: string;
  links?: { title: string; url: string }[];
}) {
  const asOf = o.results?.as_of ? ` as of ${o.results.as_of}` : '';
  const text_blocks =
    o.status === 'unhealthy'
      ? o.losing.map((l) => ({
          title: `${l.release ?? l.variant} is losing the ${l.metric} guardrail`,
          text:
            `Flagsmith's results${asOf} for experiment ${o.experiment.id} (${o.experiment.name}): ` +
            `${l.metric} ${fmt(l.treatment)} on ${l.release ?? l.variant} vs ${fmt(l.control)} on control; ` +
            `chance to win ${pct(l.chanceToWin)}, lift ${pct(l.lift)}. ` +
            'Means are per exposed identity; one with no event counts as 0. Reported by Turnout.',
        }))
      : [{ title: 'No guardrail is losing', text: o.note ?? `Flagsmith's results${asOf} for experiment ${o.experiment.id} show no losing guardrail. Reported by Turnout.` }];
  if (o.status === 'unhealthy' && o.note) text_blocks.push({ title: 'What happens next', text: o.note });
  return {
    feature: o.flag,
    environment: o.environmentName,
    status: o.status,
    reason: { text_blocks, url_blocks: o.links ?? [] },
  };
}

export class Watcher {
  private readonly opts: WatchOptions;
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private lastKey: string | null = null;
  private lastRefreshAt = 0;
  private state: WatchState;
  private readonly afterRevert = new Set<() => void>();

  constructor(opts: WatchOptions) {
    this.opts = opts;
    this.state = {
      running: false,
      lastCheckAt: null,
      lastError: null,
      health: { enabled: !!opts.healthWebhookUrl, last: null },
      guard: { enabled: opts.guard.enabled, threshold: opts.guard.threshold ?? DEFAULT_GUARD_THRESHOLD, lastAction: null, lastRefreshAt: null },
    };
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  // Called after each automatic revert, so the console drops the reads it keeps.
  onRevert(listener: () => void): void {
    this.afterRevert.add(listener);
  }

  snapshot(): WatchState {
    return structuredClone(this.state);
  }

  setGuard(enabled: boolean): WatchState {
    this.state.guard.enabled = enabled;
    this.opts.log?.(`turnout guard ${enabled ? 'on' : 'off'}`);
    return this.snapshot();
  }

  start(): void {
    if (this.timer) return;
    this.state.running = true;
    const every = this.opts.intervalMs ?? 20_000;
    this.timer = setInterval(() => void this.tick(), every);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.state.running = false;
  }

  // One check. Never throws: errors land in state.lastError.
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const exps = await this.opts.experiments();
      const experiment = await exps.detail();
      let results = await exps.results();
      const live = experiment.status === 'running';

      // A fresh experiment has nothing to score yet, and a refresh then would block anyone else's for 5 minutes.
      const startedAt = experiment.started_at ? Date.parse(experiment.started_at) : this.now();
      if (live && this.state.guard.enabled && this.now() - startedAt >= REFRESH_EVERY_MS && this.now() - this.lastRefreshAt >= REFRESH_EVERY_MS) {
        const asOf = results?.as_of ? Date.parse(results.as_of) : 0;
        if (this.now() - asOf >= REFRESH_EVERY_MS - 5_000) {
          this.lastRefreshAt = this.now();
          this.state.guard.lastRefreshAt = new Date(this.now()).toISOString();
          const r = await exps.refreshResults();
          if (!r.ok) this.lastRefreshAt = this.now(); // refused: try again after the next window
        }
      }

      const losing = live || experiment.status === 'paused' ? losingFor(experiment, results) : [];
      const threshold = this.state.guard.threshold;
      const minIdentities = this.opts.guard.minIdentities ?? DEFAULT_MIN_IDENTITIES;
      const clearlyLosing = losing.filter((l) => l.chanceToWin <= threshold);
      // In an A/B/C test one new version failing a guardrail doesn't condemn another that is fine: the guard reverts
      // only when every new version in the results is clearly losing one.
      const tested = Object.keys(results?.payload?.metrics[0]?.inference ?? {});
      const everyArmLosing = clearlyLosing.length > 0 && (tested.length === 0 || tested.every((k) => clearlyLosing.some((l) => l.variant === k)));

      if (live && this.state.guard.enabled && everyArmLosing && identitiesIn(results) >= minIdentities && !this.opts.lock.busy) {
        const reason = clearlyLosing.map((l) => `${l.release ?? l.variant} losing ${l.metric}, ${pct(l.chanceToWin)} chance to win`).join('; ');
        this.opts.lock.busy = true;
        try {
          await this.opts.revert(exps, reason);
          this.state.guard.lastAction = { at: new Date(this.now()).toISOString(), experimentId: experiment.id, text: `Reverted experiment ${experiment.id}: ${reason}`, ok: true };
          this.opts.log?.(`turnout guard: reverted experiment ${experiment.id} (${reason})`);
          await this.report(experiment, results, 'healthy', [], `Turnout's guard reverted experiment ${experiment.id} (${reason}). Everyone is back on control.`);
        } catch (error) {
          this.state.guard.lastAction = { at: new Date(this.now()).toISOString(), experimentId: experiment.id, text: `Revert failed: ${(error as Error).message}`, ok: false };
        } finally {
          this.opts.lock.busy = false;
          for (const listener of this.afterRevert) listener(); // even a failed revert may have changed Flagsmith
        }
      } else if (live || experiment.status === 'paused') {
        const note = losing.length
          ? this.state.guard.enabled
            ? `Turnout's guard reverts automatically when a guardrail's chance to win is at or under ${pct(threshold)}.`
            : 'Revert it from the Turnout console, or ship anyway after accepting the guardrail.'
          : undefined;
        await this.report(experiment, results, losing.length ? 'unhealthy' : 'healthy', losing, note);
      } else if (this.state.health.last?.status === 'unhealthy') {
        // Completed after an unhealthy report: the decision has been made, the flag is a plain flag again.
        await this.report(experiment, results, 'healthy', [], `Experiment ${experiment.id} is ${experiment.status}; the flag's environment default decides again.`);
      }
      this.state.lastCheckAt = new Date(this.now()).toISOString();
      this.state.lastError = null;
    } catch (error) {
      this.state.lastError = (error as Error).message;
    } finally {
      this.ticking = false;
    }
  }

  private async report(experiment: ExperimentDetail, results: Results | null, status: 'healthy' | 'unhealthy', losing: Losing[], note?: string) {
    const key = `${experiment.id}:${status}:${losing.map((l) => `${l.variant}/${l.metric}`).join(',')}`;
    if (key === this.lastKey || !this.opts.healthWebhookUrl) return;
    const payload = healthPayload({
      flag: this.opts.flag,
      environmentName: this.opts.environmentName,
      status,
      experiment,
      results,
      losing,
      ...(note ? { note } : {}),
      ...(this.opts.links ? { links: this.opts.links(experiment) } : {}),
    });
    const report: HealthReport = {
      at: new Date(this.now()).toISOString(),
      experimentId: experiment.id,
      status,
      summary: payload.reason.text_blocks.filter((b) => b.title !== 'What happens next').map((b) => b.title).join('; '),
      delivered: false,
    };
    try {
      const res = await (this.opts.fetch ?? fetch)(this.opts.healthWebhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      report.delivered = res.ok;
      if (!res.ok) report.error = `Flagsmith answered ${res.status}`;
      else this.lastKey = key;
    } catch (error) {
      report.error = (error as Error).message;
    }
    this.state.health.last = report;
    this.opts.log?.(`turnout health: ${status} for ${this.opts.flag} (experiment ${experiment.id})${report.delivered ? '' : ` not delivered: ${report.error}`}`);
  }
}
