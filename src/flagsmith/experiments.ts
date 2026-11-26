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
// results: chance to win below 5%. Shipping control is the status quo, so it never warns.
export const GUARDRAIL_LOSING_BELOW = 0.05;
export type GuardrailWarning = { metric: string; chanceToWin: number; lift: number };
export function losingGuardrails(experiment: ExperimentDetail, results: Results | null, winnerKey: string): GuardrailWarning[] {
  if (winnerKey === CONTROL || !results?.payload) return [];
  return experiment.metrics.slice(1).flatMap((m) => {
    const inference = results.payload!.metrics.find((r) => r.metric_id === m.metric)?.inference[winnerKey];
    return inference && inference.chance_to_win < GUARDRAIL_LOSING_BELOW
      ? [{ metric: m.metric_name, chanceToWin: inference.chance_to_win, lift: inference.lift }]
      : [];
  });
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
  if (!latest) throw new Error(`No experiment on "${flag}" yet. Run switchyard init.`);
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
