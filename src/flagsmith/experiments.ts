import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdminClient } from './admin.ts';

export const CONTROL = 'control';

export type ExperimentDetail = {
  id: number;
  name: string;
  hypothesis: string;
  status: 'created' | 'running' | 'paused' | 'completed';
  feature: {
    id: number;
    name: string;
    initial_value: string | null;
    multivariate_options: { id: number; key: string | null; string_value: string | null }[];
  };
  metrics: { metric: number; metric_name: string; aggregation: string; direction: string; expected_direction: string }[];
  experiment_rollout: {
    enabled: boolean;
    rollout_percentage: number;
    feature_state_value: { type: string; value: string };
    multivariate_feature_state_values: { multivariate_feature_option: number; percentage_allocation: number }[];
  } | null;
  started_at: string | null;
  ended_at: string | null;
};

export type Inference = { lift: number; ci_low: number; ci_high: number; chance_to_win: number };
export type MetricResult = {
  metric_id: number;
  variants: Record<string, { n: number; sum: number; sum_squares: number }>;
  inference: Record<string, Inference | null>;
};
export type Results = {
  as_of: string | null;
  last_error_at: string | null;
  refresh_requested_at: string | null;
  is_final: boolean;
  payload: { srm_p_value: number | null; metrics: MetricResult[] } | null;
};

export type FlagState = {
  environment_default: { enabled: boolean; value: { type: string; value: string }; variants: { id: number; weight: number }[] };
  segment_overrides: { segment: { id: number }; priority: number; enabled: boolean; variants: { id: number; weight: number }[] }[];
};

export type Winner = { key: string; chanceToWin: number; isControl: boolean };

// A treatment's key as Flagsmith's results page names it: the option's key, or "Variant_<n>" (1-based) for an
// option created without one (frontend/web/components/experiments/results/derive.ts:47,58).
export const variantKey = (option: { key: string | null }, index: number): string => option.key ?? `Variant_${index + 1}`;
const treatmentKeys = (experiment: ExperimentDetail) => experiment.feature.multivariate_options.map(variantKey);

// Mirrors Flagsmith's results page (frontend/web/components/experiments/results/derive.ts:188-243), on the
// primary (first) metric (frontend/web/components/experiments/constants.ts:71-73):
// - the best treatment is the one with the highest chance to win, skipping any without inference yet (getBestTreatment);
// - control's chance is 1 - the treatments' total, and only once every treatment has inference (getControlChanceToWin);
// - control wins only when that chance is known and higher than the best treatment's (getWinningVariant).
export function pickWinner(experiment: ExperimentDetail, results: Results | null): Winner | null {
  const primary = experiment.metrics[0];
  const metric = results?.payload?.metrics.find((m) => m.metric_id === primary?.metric);
  if (!metric) return null;

  const treatments = treatmentKeys(experiment);
  let best: Winner | null = null;
  for (const key of treatments) {
    const inference = metric.inference[key];
    if (!inference) continue;
    if (!best || inference.chance_to_win > best.chanceToWin) {
      best = { key, chanceToWin: inference.chance_to_win, isControl: false };
    }
  }
  if (!best) return null;

  let total = 0;
  for (const key of treatments) {
    const inference = metric.inference[key];
    if (!inference) return best; // the control bound needs every treatment; until then control can't win
    total += inference.chance_to_win;
  }
  const control = Math.max(0, 1 - total);
  return control > best.chanceToWin ? { key: CONTROL, chanceToWin: control, isControl: true } : best;
}

// Guardrails (every metric after the primary) on which the variant about to ship is losing in Flagsmith's own
// results: chance to win below 5% AND a harm bigger than a practical minimum (the relative lift is more than 5% in
// the bad direction), so a sure but tiny difference (0.7 ms of latency) neither blocks a release nor trips the guard.
// Shipping control is the status quo, so it never warns.
export const GUARDRAIL_LOSING_BELOW = 0.05;
export const GUARDRAIL_MIN_HARM = 0.05; // relative lift, in the metric's bad direction
// A practical floor in the metric's own unit, on top of the relative one: a page-speed difference under 20 ms is
// never a loss, however sure Flagsmith is of it. Compared on Flagsmith's means per exposed identity.
export const GUARDRAIL_MIN_ABSOLUTE: Record<string, number> = { doc_latency_ms: 20 };
function absoluteHarmClears(metric: string, direction: string, variants: Record<string, { n: number; sum: number }>, key: string): boolean {
  const floor = GUARDRAIL_MIN_ABSOLUTE[metric];
  if (floor === undefined) return true;
  const mean = (v?: { n: number; sum: number }) => (v && v.n > 0 ? v.sum / v.n : null);
  const treated = mean(variants[key]);
  const control = mean(variants[CONTROL]);
  if (treated === null || control === null) return true; // can't tell: leave it to the relative rule
  return harmOf(direction, treated - control) >= floor;
}
export type GuardrailWarning = { metric: string; chanceToWin: number; lift: number };

// How much worse a lift is for a metric: positive is harm. "down is better" metrics (latency, errors) are harmed by
// a rise; every other direction by a fall.
export const harmOf = (direction: string, lift: number): number => (/^(down|lower|decrease)/i.test(direction) ? lift : -lift);

// A guardrail is any metric after the primary that isn't expected to increase. Secondary metrics (add_to_cart: "up",
// expected to increase) are shown, never guard a release.
export const isGuardrail = (m: { expected_direction?: string }): boolean => m.expected_direction !== 'increase';

export function losingGuardrails(
  experiment: ExperimentDetail,
  results: Results | null,
  winnerKey: string,
  minHarm: number = GUARDRAIL_MIN_HARM,
): GuardrailWarning[] {
  if (winnerKey === CONTROL || !results?.payload) return [];
  return experiment.metrics.slice(1).filter(isGuardrail).flatMap((m) => {
    const row = results.payload!.metrics.find((r) => r.metric_id === m.metric);
    const inference = row?.inference[winnerKey];
    return inference && inference.chance_to_win < GUARDRAIL_LOSING_BELOW && harmOf(m.direction, inference.lift) > minHarm &&
      absoluteHarmClears(m.metric_name, m.direction, row!.variants, winnerKey)
      ? [{ metric: m.metric_name, chanceToWin: inference.chance_to_win, lift: inference.lift }]
      : [];
  });
}

// What Turnout recommends, read off Flagsmith's own inference (it computes everything; this only reads it), for each
// treatment against control:
// - a treatment losing a guardrail → revert;
// - the goal's credible interval for the best treatment crossing zero, or its chance to win under 95% → keep running;
// - the interval wholly on the losing side (chance to win at or under 5%) → revert: control is better;
// - otherwise → ship.
// "An interval crossing zero isn't a win": a high chance to win alone isn't enough.
export const SHIP_CHANCE_AT_LEAST = 0.95;
export type Call = 'ship' | 'keep-running' | 'revert';
export type Recommendation = { call: Call; variant: string | null; reason: string; interval: { low: number; high: number } | null; chanceToWin: number | null };

const signedPct = (x: number) => `${x < 0 ? '−' : '+'}${Math.abs(x * 100).toFixed(0)}%`;
export const formatInterval = (i: { low: number; high: number }) => `${signedPct(i.low)} to ${signedPct(i.high)}`;

export function recommend(experiment: ExperimentDetail, results: Results | null): Recommendation {
  const goal = results?.payload?.metrics.find((m) => m.metric_id === experiment.metrics[0]?.metric);
  // Each treatment on its own, against control (Flagsmith compares each one with control: experimentation/stats.py
  // compare_to_control), best chance to win first.
  const calls = treatmentKeys(experiment)
    .flatMap((key) => (goal?.inference[key] ? [callFor(experiment, results, key, goal.inference[key]!)] : []))
    .sort((a, b) => (b.chanceToWin ?? 0) - (a.chanceToWin ?? 0));
  if (!calls.length) {
    return { call: 'keep-running', variant: null, reason: 'Flagsmith has no result on the goal yet', interval: null, chanceToWin: null };
  }
  // With several treatments (an A/B/C test): ship the best one that is safe and clearly better; else keep running
  // while any is still undecided; else revert. One that loses a guardrail never stops a safe one from shipping.
  const ship = calls.find((c) => c.call === 'ship');
  if (ship) return ship;
  const undecided = calls.find((c) => c.call === 'keep-running');
  if (undecided) return undecided;
  return { ...calls[0]!, reason: calls.map((c) => c.reason).join('; ') };
}

function callFor(experiment: ExperimentDetail, results: Results | null, key: string, inference: Inference): Recommendation {
  const interval = { low: inference.ci_low, high: inference.ci_high };
  const base = { variant: key, interval, chanceToWin: inference.chance_to_win };
  const losing = losingGuardrails(experiment, results, key);
  if (losing.length) {
    return {
      call: 'revert',
      ...base,
      reason: `${key} is losing ${losing.map((g) => `${g.metric} (lift ${signedPct(g.lift)}, ${(g.chanceToWin * 100).toFixed(1)}% chance to win)`).join(', ')}`,
    };
  }
  if (interval.low <= 0 && interval.high >= 0) {
    return { call: 'keep-running', ...base, reason: `interval ${formatInterval(interval)} crosses zero` };
  }
  if (inference.chance_to_win <= 1 - SHIP_CHANCE_AT_LEAST) {
    return { call: 'revert', ...base, reason: `control is better: ${key}'s interval ${formatInterval(interval)}, ${(inference.chance_to_win * 100).toFixed(1)}% chance to win` };
  }
  if (inference.chance_to_win < SHIP_CHANCE_AT_LEAST) {
    return { call: 'keep-running', ...base, reason: `chance to win ${(inference.chance_to_win * 100).toFixed(1)}% is under 95%` };
  }
  return { call: 'ship', ...base, reason: `interval ${formatInterval(interval)} clears zero, ${(inference.chance_to_win * 100).toFixed(1)}% chance to win` };
}

// The release label each variant serves: control is the rollout's value, each treatment its option's value.
export function releaseOf(experiment: ExperimentDetail, variant: string): string | null {
  if (variant === CONTROL) return experiment.experiment_rollout?.feature_state_value.value ?? experiment.feature.initial_value;
  return experiment.feature.multivariate_options.find((o, i) => variantKey(o, i) === variant)?.string_value ?? null;
}

export type ExperimentRef = { envKey: string; experimentId: number };

// "…/environment/<key>/experiments/<id>" (the link Flagsmith's coding-agent prompt ends on) or "<key>/<id>".
export function parseExperimentRef(input: string): ExperimentRef {
  const link = input.match(/environment\/([^/]+)\/experiments\/(\d+)/);
  const short = input.match(/^([A-Za-z0-9]+)\/(\d+)$/);
  const m = link ?? short;
  if (!m) throw new Error(`Not an experiment link: "${input}". Expected …/environment/<key>/experiments/<id>`);
  return { envKey: m[1]!, experimentId: Number(m[2]) };
}

// The flag's most recent experiment in an environment: what the console and the commands act on by default.
export async function latestExperiment(api: AdminClient, envKey: string, flag: string): Promise<Experiments> {
  const list = await api.list<{ id: number; feature: { name: string } }>(`/api/v1/environments/${envKey}/experiments/`);
  const latest = list.filter((e) => e.feature.name === flag).sort((a, b) => b.id - a.id)[0];
  if (!latest) throw new Error(`No experiment on "${flag}" yet. Run turnout init.`);
  return new Experiments(api, { envKey, experimentId: latest.id });
}

export class Experiments {
  readonly api: AdminClient;
  readonly ref: ExperimentRef;

  constructor(api: AdminClient, ref: ExperimentRef) {
    this.api = api;
    this.ref = ref;
  }

  private get base(): string {
    return `/api/v1/environments/${this.ref.envKey}/experiments/${this.ref.experimentId}`;
  }

  detail(): Promise<ExperimentDetail> {
    return this.api.get(`${this.base}/`);
  }

  async results(): Promise<Results | null> {
    return (await this.api.get<{ results: Results | null }>(`${this.base}/results/`)).results;
  }

  // Flagsmith allows one refresh every 5 minutes per experiment; a 429 is reported, not thrown.
  async refreshResults(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await this.api.post(`${this.base}/results/refresh/`);
      return { ok: true };
    } catch (error) {
      const err = error as { status?: number; body?: unknown };
      if (err.status === 429 || err.status === 400) return { ok: false, reason: JSON.stringify(err.body) };
      throw error;
    }
  }

  flagState(featureId: number): Promise<FlagState> {
    return this.api.get(`/api/__future__/environments/${this.ref.envKey}/features/${featureId}/`);
  }

  // Every experiment on this experiment's flag, newest first: the release history.
  async history(): Promise<ExperimentSummary[]> {
    const experiment = await this.detail();
    const list = await this.api.list<ExperimentSummary & { feature: { id: number } }>(`/api/v1/environments/${this.ref.envKey}/experiments/`);
    return list
      .filter((e) => e.feature.id === experiment.feature.id)
      .sort((a, b) => b.id - a.id)
      .map(({ id, name, hypothesis, status, started_at, ended_at }) => ({ id, name, hypothesis, status, started_at, ended_at }));
  }
}

export type ExperimentSummary = Pick<ExperimentDetail, 'id' | 'name' | 'hypothesis' | 'status' | 'started_at' | 'ended_at'>;

export type StepResult = { title: string; status: 'done' | 'skipped'; detail?: string };
export type StepLog = (step: StepResult) => void;

export type Step = {
  title: string;
  call: string;
  done: (s: { experiment: ExperimentDetail; flag: FlagState }) => boolean;
  // What the read-back must show after run(); defaults to done. The snapshot step only writes a file.
  verify: (s: { experiment: ExperimentDetail; flag: FlagState }) => boolean;
  run: () => Promise<unknown>;
  file?: string; // set by run() on the snapshot step: the file it wrote
};

const weightsFor = (experiment: ExperimentDetail, winnerKey: string) =>
  experiment.feature.multivariate_options.map((o, i) => ({ id: o.id, weight: variantKey(o, i) === winnerKey ? 100 : 0 }));

// The decision snapshot a plan wrote, once runSteps has run it; null if the step was skipped.
export const snapshotFileOf = (steps: Step[]): string | null => steps.find((s) => s.file)?.file ?? null;

// Ship winner, in the order that leaves the flag editable and reaching everyone:
// pause, snapshot, environment default = winner (enabled), drain the rollout onto it, complete.
// The default's value is set to the value control served in the experiment (the rollout's), so what control means
// after the decision is what it meant during it, even if someone edited the default's value meanwhile.
export async function planShip(exp: Experiments, winnerKey: string, snapshotDir: string): Promise<Step[]> {
  const experiment = await exp.detail();
  const known = [CONTROL, ...treatmentKeys(experiment)];
  if (!known.includes(winnerKey)) throw new Error(`"${winnerKey}" is not a variant of ${experiment.feature.name} (${known.join(', ')})`);
  const rollout = experiment.experiment_rollout;
  if (!rollout) throw new Error('This experiment has no rollout to drain.');
  const weights = weightsFor(experiment, winnerKey);
  const controlValue = rollout.feature_state_value;
  const base = `/api/v1/environments/${exp.ref.envKey}/experiments/${exp.ref.experimentId}`;
  const flagPath = `/api/__future__/environments/${exp.ref.envKey}/features/${experiment.feature.id}/`;
  let snapshotSaved = false; // one snapshot per decision, even when a step is retried
  const defaultIsWinner = (flag: FlagState) =>
    flag.environment_default.enabled &&
    flag.environment_default.value?.type === controlValue.type &&
    flag.environment_default.value?.value === controlValue.value &&
    weights.every((w) => flag.environment_default.variants.find((v) => v.id === w.id)?.weight === w.weight);

  const snapshot: Step = {
    title: "Save a decision snapshot of Flagsmith's results",
    call: `GET ${base}/results/ → ${snapshotDir}`,
    done: ({ experiment: e }) => e.status === 'completed' || snapshotSaved,
    verify: () => true,
    run: async () => {
      snapshot.file = saveSnapshot(snapshotDir, experiment, await exp.results(), winnerKey);
      snapshotSaved = true;
    },
  };

  return [
    {
      title: 'Pause the experiment',
      call: `POST ${base}/pause/`,
      done: ({ experiment: e }) => e.status !== 'running',
      verify: ({ experiment: e }) => e.status !== 'running',
      run: () => exp.api.post(`${base}/pause/`),
    },
    snapshot,
    {
      title: `Set the flag's environment default to ${winnerKey}, enabled`,
      call: `PATCH ${flagPath}`,
      done: ({ flag }) => defaultIsWinner(flag),
      verify: ({ flag }) => defaultIsWinner(flag),
      // features/future/serializers.py:50-58 takes enabled, value and variants; services.py:171-188 writes each given.
      run: () => exp.api.patch(flagPath, { environment_default: { enabled: true, value: controlValue, variants: weights } }),
    },
    {
      title: `Drain the rollout to 0%, with ${winnerKey}'s weights`,
      call: `PATCH ${base}/rollout/`,
      done: ({ experiment: e }) => e.status === 'completed' || e.experiment_rollout?.rollout_percentage === 0,
      verify: ({ experiment: e }) => e.experiment_rollout?.rollout_percentage === 0,
      run: () =>
        exp.api.patch(`${base}/rollout/`, {
          enabled: true,
          rollout_percentage: 0,
          feature_state_value: rollout.feature_state_value,
          multivariate_feature_state_values: weights.map((w) => ({ multivariate_feature_option: w.id, percentage_allocation: w.weight })),
        }),
    },
    {
      title: 'Complete the experiment',
      call: `POST ${base}/complete/`,
      done: ({ experiment: e }) => e.status === 'completed',
      verify: ({ experiment: e }) => e.status === 'completed',
      run: () => exp.api.post(`${base}/complete/`),
    },
  ];
}

// Revert to control is Ship winner with control as the winner: pause, snapshot, environment default = control with
// every variant at 0%, drain the rollout onto it, complete. It leaves no split behind, so `check` stays clean and
// `release` can start the next experiment.
export async function planRevert(exp: Experiments, snapshotDir: string): Promise<Step[]> {
  const experiment = await exp.detail();
  if (experiment.status === 'completed') throw new Error('This experiment is completed; edit the flag in Flagsmith instead.');
  return planShip(exp, CONTROL, snapshotDir);
}

// Runs each step unless Flagsmith already shows it done, then reads state back. Safe to re-run after a failure.
export async function runSteps(exp: Experiments, steps: Step[], log: StepLog): Promise<void> {
  const read = async () => {
    const experiment = await exp.detail();
    return { experiment, flag: await exp.flagState(experiment.feature.id) };
  };
  for (const step of steps) {
    if (step.done(await read())) {
      log({ title: step.title, status: 'skipped', detail: 'already done' });
      continue;
    }
    await step.run();
    const after = await read();
    if (!after.flag.environment_default.enabled) {
      throw new Error(`Stopped after "${step.title}": the flag is now disabled for everyone. Check it in Flagsmith.`);
    }
    // Read back: Flagsmith must now show the step as done, or nothing after it is safe to run.
    if (!step.verify(after)) {
      throw new Error(`Stopped after "${step.title}": Flagsmith accepted the call but doesn't show the change. Re-run to resume.`);
    }
    log({ title: step.title, status: 'done', detail: step.call });
  }
}

export function saveSnapshot(dir: string, experiment: ExperimentDetail, results: Results | null, decision: string): string {
  mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  const file = join(dir, `experiment-${experiment.id}-${at.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ saved_at: at, decision, experiment, results }, null, 2));
  return file;
}
