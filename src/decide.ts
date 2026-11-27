// Ship winner and Revert, shared by the CLI and the console: guardrail check, the steps, then the ledger.
import {
  CONTROL,
  losingGuardrails,
  planRevert,
  planShip,
  recommend,
  formatInterval,
  releaseOf,
  runSteps,
  snapshotFileOf,
  type ExperimentDetail,
  type Experiments,
  variantKey,
  type GuardrailWarning,
  type Results,
  type StepResult,
} from './flagsmith/experiments.ts';
import { publishToGitHub, recordDecision, tagFor, type LedgerEntry } from './ledger.ts';

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function describeResults(experiment: ExperimentDetail, results: Results | null): string[] {
  const lines = [`${experiment.name} · ${experiment.status}`, `Hypothesis: ${experiment.hypothesis}`];
  if (!results?.payload) {
    lines.push('Flagsmith results: not computed yet ("Collecting data")');
    return lines;
  }
  lines.push(`Flagsmith results as of ${results.as_of}${results.is_final ? ' (final)' : ''}`);
  for (const m of experiment.metrics) {
    const r = results.payload.metrics.find((x) => x.metric_id === m.metric);
    if (!r) {
      lines.push(`  ${m.metric_name}: collecting data`);
      continue;
    }
    const arms = Object.entries(r.variants)
      .map(([key, v]) => `${key} ${(v.sum / Math.max(v.n, 1)).toFixed(m.aggregation === 'occurrence' ? 3 : 1)} (n=${v.n})`)
      .join(', ');
    const allZero = Object.values(r.variants).every((v) => v.sum === 0);
    const inf = Object.entries(r.inference)
      .map(([key, i]) =>
        i ? `${key}: lift ${pct(i.lift)} (interval ${formatInterval({ low: i.ci_low, high: i.ci_high })}), chance to win ${pct(i.chance_to_win)}` : `${key}: ${allZero ? 'no events in either release' : 'collecting data'}`,
      )
      .join('; ');
    // A Mean metric's figure is per exposed identity: one with no event counts as 0 (experimentation/results_query.py:123-124,
    // warehouses/dialect.py:39-41; stats.py:35-36 divides by every exposed identity).
    const aggregation = m.aggregation === 'mean' ? 'mean per exposed identity' : m.aggregation;
    lines.push(`  ${m.metric_name} (${aggregation}, ${m.direction}): ${arms}`);
    if (inf) lines.push(`    ${inf}`);
  }
  lines.push(`  sample-ratio check: ${results.payload.srm_p_value === null ? 'not computed' : results.payload.srm_p_value}`);
  return lines;
}

export class LosingGuardrailsError extends Error {
  readonly warnings: GuardrailWarning[];
  constructor(winner: string, warnings: GuardrailWarning[]) {
    super(
      `${winner} is losing on ${warnings.map((w) => `${w.metric} (${pct(w.chanceToWin)} chance to win)`).join(', ')}. ` +
        'Ship it anyway only if you accept that.',
    );
    this.warnings = warnings;
  }
}

export type DecideOptions = {
  experiments: Experiments;
  action: 'ship' | 'revert';
  winner?: string; // ship only
  acceptLosingGuardrails?: boolean;
  snapshotDir: string;
  ledgerDir: string;
  github?: { token: string; repository: string; apiUrl?: string; fetch?: typeof fetch };
  onStep?: (step: StepResult) => void;
  by?: 'person' | 'guard' | 'autopilot'; // the guard only ever reverts; the autopilot runs the live demo
  guardReason?: string;
};

export type Decision = {
  entry: LedgerEntry;
  github: { url: string } | { error: string } | null;
};

export async function plan(exp: Experiments, action: 'ship' | 'revert', winner: string, snapshotDir: string) {
  return action === 'revert' ? planRevert(exp, snapshotDir) : planShip(exp, winner, snapshotDir);
}

export async function decide(opts: DecideOptions): Promise<Decision> {
  const exp = opts.experiments;
  const experiment = await exp.detail();
  const results = await exp.results();
  const winner = opts.action === 'revert' ? CONTROL : opts.winner;
  if (!winner) throw new Error('winner is required');

  const losing = losingGuardrails(experiment, results, winner);
  if (losing.length && !opts.acceptLosingGuardrails) throw new LosingGuardrailsError(winner, losing);

  const steps = await plan(exp, opts.action, winner, opts.snapshotDir);
  const log: StepResult[] = [];
  await runSteps(exp, steps, (s) => {
    log.push(s);
    opts.onStep?.(s);
  });

  const entry: LedgerEntry = {
    at: new Date().toISOString(),
    experimentId: experiment.id,
    experiment: experiment.name,
    hypothesis: experiment.hypothesis,
    flag: experiment.feature.name,
    decision: opts.action === 'revert' ? 'reverted' : 'shipped',
    variant: winner,
    release: releaseOf(experiment, winner),
    replaced: releaseOf(experiment, CONTROL),
    results: describeResults(experiment, results).slice(2).filter((l) => !l.startsWith('Flagsmith results as of')),
    resultsAsOf: results?.as_of ?? null,
    losingGuardrailsAccepted: losing,
    snapshot: snapshotFileOf(steps)?.replaceAll('\\', '/') ?? null, // null when the step was already done (a re-run)
    ...(opts.by === 'guard' ? { by: 'guard' as const, ...(opts.guardReason ? { guardReason: opts.guardReason } : {}) } : {}),
    ...(opts.by === 'autopilot' ? { by: 'autopilot' as const } : {}),
  };
  recordDecision(opts.ledgerDir, entry);

  let github: Decision['github'] = null;
  if (opts.github) {
    // The release the decision is about: the new one, whether it shipped or was reverted.
    // An option without a key is Variant_1, as everywhere else; only a flag with no option falls back to control.
    const first = experiment.feature.multivariate_options[0];
    const about = releaseOf(experiment, first ? variantKey(first, 0) : CONTROL);
    try {
      github = about ? { url: await publishToGitHub(entry, tagFor(about), opts.github) } : { error: 'no release label to tag' };
    } catch (error) {
      github = { error: (error as Error).message }; // the flag already moved; the ledger file has the record
    }
  }
  return { entry, github };
}

// Keep running: the honest call when Flagsmith's interval still crosses zero. Writes nothing to Flagsmith (the
// experiment stays running, so more visitors can be sent); records the reason and the interval in the ledger.
export async function keepRunning(opts: { experiments: Experiments; ledgerDir: string; by?: 'autopilot' }): Promise<LedgerEntry> {
  const experiment = await opts.experiments.detail();
  if (experiment.status === 'completed') throw new Error('This experiment is already decided.');
  const results = await opts.experiments.results();
  const rec = recommend(experiment, results);
  const variant = rec.variant ?? CONTROL;
  const entry: LedgerEntry = {
    at: new Date().toISOString(),
    experimentId: experiment.id,
    experiment: experiment.name,
    hypothesis: experiment.hypothesis,
    flag: experiment.feature.name,
    decision: 'kept-running',
    variant,
    release: releaseOf(experiment, variant),
    replaced: releaseOf(experiment, CONTROL),
    results: describeResults(experiment, results).slice(2).filter((l) => !l.startsWith('Flagsmith results as of')),
    resultsAsOf: results?.as_of ?? null,
    losingGuardrailsAccepted: [],
    snapshot: null,
    reason: rec.reason,
    interval: rec.interval,
    ...(opts.by ? { by: opts.by } : {}),
  };
  recordDecision(opts.ledgerDir, entry);
  return entry;
}
