// Experiment Doctor: sanity checks on how traffic and events reach a Flagsmith experiment, for any Flagsmith
// Experimentation user (with or without the Switchyard proxy). Read-only, Organisation API key. None of these checks
// say which arm is better; Flagsmith's results do that. They say whether the data feeding the results looks broken.
import type { AdminClient } from '../flagsmith/admin.ts';
import { CONTROL, variantKey, type ExperimentDetail, type Results } from '../flagsmith/experiments.ts';

export type Verdict = 'pass' | 'warn' | 'fail' | 'skip';
export type Diagnosis = {
  check: 'exposures' | 'tracking' | 'sample ratio' | 'late multivariate';
  verdict: Verdict;
  summary: string;
  meaning?: string; // for warn and fail
  fix?: string;
};

// Flagsmith computes its SRM p-value only from 100 exposed identities on (api/experimentation/constants.py:24,
// services.py:347); the fallback below uses the same floor.
export const SRM_MIN_TOTAL = 100;
export const SRM_ALPHA = 0.001;
// "Zero events on one arm" is only suspicious when the other arm's rate predicts enough events there.
const EXPECTED_FOR_FAIL = 10; // P(0 | Poisson 10) ≈ 0.00005
const EXPECTED_FOR_WARN = 3; // P(0 | Poisson 3) ≈ 0.05

// The configured split, by results key: each option's allocation, control the remainder. Flagsmith keys results by
// the option's key, or Variant_<n> for an unkeyed option (frontend/web/components/experiments/constants.ts:71-73).
export function configuredShares(experiment: ExperimentDetail): Record<string, number> | null {
  const rollout = experiment.experiment_rollout;
  if (!rollout) return null;
  const shares: Record<string, number> = {};
  let allocated = 0;
  for (const v of rollout.multivariate_feature_state_values) {
    const index = experiment.feature.multivariate_options.findIndex((o) => o.id === v.multivariate_feature_option);
    const option = experiment.feature.multivariate_options[index];
    if (!option) return null;
    shares[variantKey(option, index)] = v.percentage_allocation / 100;
    allocated += v.percentage_allocation;
  }
  if (allocated > 100) return null;
  shares[CONTROL] = (100 - allocated) / 100;
  return shares;
}

// Chi-square goodness-of-fit p-value, computed the way Flagsmith's srm_p_value does (api/experimentation/stats.py:87-129).
export function chiSquareP(observed: number[], shares: number[]): number | null {
  const total = observed.reduce((a, b) => a + b, 0);
  if (observed.length < 2 || total === 0 || shares.some((s) => s <= 0)) return null;
  const statistic = observed.reduce((sum, count, i) => sum + (count - total * shares[i]!) ** 2 / (total * shares[i]!), 0);
  if (statistic <= 0) return 1;
  const df = observed.length - 1;
  const y = statistic / 2;
  let a: number;
  let survival: number;
  if (df % 2) {
    a = 0.5;
    survival = erfc(Math.sqrt(y));
  } else {
    a = 1;
    survival = Math.exp(-y);
  }
  while (a + 1 <= df / 2) {
    survival += Math.exp(a * Math.log(y) - y - lgamma(a + 1));
    a += 1;
  }
  return Math.min(1, Math.max(0, survival));
}

// erfc with relative error < 1.2e-7 (Numerical Recipes' erfcc), enough for a p < 0.001 cut-off.
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}

// ln Γ(x) for x > 0 (Lanczos).
function lgamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const ci of c) ser += ci / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

const fmtP = (p: number) => (p < 0.0001 ? p.toExponential(1) : p.toFixed(4));

export function diagnose(experiment: ExperimentDetail, results: Results | null): Diagnosis[] {
  const out: Diagnosis[] = [];
  const shares = configuredShares(experiment);
  const arms = shares ? Object.keys(shares).filter((k) => shares[k]! > 0) : [];
  const payload = results?.payload;
  if (!payload || !payload.metrics.length) {
    out.push({ check: 'exposures', verdict: 'skip', summary: 'Flagsmith has no results for it yet; refresh them in Flagsmith, then run check again.' });
    out.push(lateMultivariate());
    return out;
  }

  // Exposed identities per arm: every metric's n counts the same exposed identities (api/experimentation/results_query.py:150-156).
  const counts: Record<string, number> = {};
  for (const m of payload.metrics) for (const [k, v] of Object.entries(m.variants)) counts[k] = Math.max(counts[k] ?? 0, v.n);
  const keys = [...new Set([...arms, ...Object.keys(counts)])].sort((a, b) => Number(b === CONTROL) - Number(a === CONTROL)); // control first
  const list = keys.map((k) => `${k} ${counts[k] ?? 0}`).join(', ');
  const empty = keys.filter((k) => !counts[k]);
  const total = keys.reduce((s, k) => s + (counts[k] ?? 0), 0);
  if (total === 0) {
    out.push({ check: 'exposures', verdict: 'skip', summary: 'no exposures recorded yet.' });
  } else if (empty.length) {
    out.push({
      check: 'exposures',
      verdict: 'fail',
      summary: `exposures on one side only (${list}).`,
      meaning: `Nobody was recorded in ${empty.join(', ')}, so there is nothing to compare against.`,
      fix: `Check that ${empty.join(', ')} is reachable (its split is above 0%, its value is served) and that exposure events are sent for every arm, not only from one code path.`,
    });
  } else {
    out.push({ check: 'exposures', verdict: 'pass', summary: `every arm has visitors (${list}).` });
  }

  // Broken tracking: an arm with visitors but no events for a metric another arm records.
  const names = new Map(experiment.metrics.map((m, i) => [m.metric, { name: m.metric_name, primary: i === 0, up: m.direction === 'up' }]));
  const tracking: Diagnosis[] = [];
  for (const m of payload.metrics) {
    const meta = names.get(m.metric_id) ?? { name: `metric ${m.metric_id}`, primary: false, up: true };
    const entries = Object.entries(m.variants).filter(([, v]) => v.n > 0);
    const firing = entries.filter(([, v]) => v.sum > 0);
    if (!firing.length) continue;
    const rate = firing.reduce((s, [, v]) => s + v.sum, 0) / firing.reduce((s, [, v]) => s + v.n, 0);
    for (const [key, v] of entries) {
      if (v.sum > 0) continue;
      const expected = rate * v.n;
      if (expected < EXPECTED_FOR_WARN) continue;
      // A lower-is-better guardrail (errors, latency) can honestly be zero on one arm: warn, never fail.
      const verdict: Verdict = expected >= EXPECTED_FOR_FAIL && (meta.primary || meta.up) ? 'fail' : 'warn';
      tracking.push({
        check: 'tracking',
        verdict,
        summary: `${key} has ${v.n} visitors but no ${meta.name} events, while ${firing.map(([k, f]) => `${k} has ${f.sum}`).join(', ')} (about ${Math.round(expected)} expected).`,
        meaning: meta.up ? `${meta.name} is probably not tracked on ${key}: a broken event, a renamed event, or a code path that never sends it.` : `Either ${key} really never triggers ${meta.name}, or its tracking is missing.`,
        fix: `Trigger ${meta.name} yourself on ${key} and look for the event in Flagsmith; send it with the same identity the flag was evaluated for.`,
      });
    }
  }
  out.push(...(tracking.length ? tracking : [{ check: 'tracking' as const, verdict: 'pass' as const, summary: 'every arm with visitors records each metric another arm records.' }]));

  // Sample ratio mismatch: Flagsmith's p-value when it has one, else the same test against the rollout's split.
  if (payload.srm_p_value != null) {
    out.push(srm(payload.srm_p_value, 'Flagsmith', list));
  } else if (!shares) {
    const why = experiment.experiment_rollout ? 'the configured split could not be read' : 'the experiment no longer reports a rollout split';
    out.push({ check: 'sample ratio', verdict: 'skip', summary: `${why}.` });
  } else if (keys.some((k) => !(shares[k]! > 0))) {
    out.push({ check: 'sample ratio', verdict: 'skip', summary: `the rollout no longer has the split visitors were assigned with (now ${Object.entries(shares).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(', ')}; drained or shipped?).` });
  } else if (total < SRM_MIN_TOTAL) {
    out.push({ check: 'sample ratio', verdict: 'skip', summary: `fewer than ${SRM_MIN_TOTAL} exposed visitors so far.` });
  } else {
    const p = chiSquareP(keys.map((k) => counts[k] ?? 0), keys.map((k) => shares[k]!));
    out.push(p == null ? { check: 'sample ratio', verdict: 'skip', summary: 'not computable for this split.' } : srm(p, 'chi-square vs the rollout split', list, keys.map((k) => `${k} ${Math.round(shares[k]! * 100)}%`).join(', ')));
  }
  out.push(lateMultivariate());
  return out;
}

function srm(p: number, source: string, observed: string, configured?: string): Diagnosis {
  const where = `p = ${fmtP(p)} (${source}; a sanity check, not a result)`;
  if (p >= SRM_ALPHA) return { check: 'sample ratio', verdict: 'pass', summary: `arm sizes match the configured split: ${where}.` };
  return {
    check: 'sample ratio',
    verdict: 'fail',
    summary: `arm sizes (${observed}) don't match the configured split${configured ? ` (${configured})` : ''}: ${where}.`,
    meaning: 'Visitors are being lost or added on one side (a redirect, a crash before the exposure event, bots, caching), so the arms are no longer comparable and the results cannot be trusted.',
    fix: 'Find where one arm drops or duplicates exposures; restart the experiment once fixed.',
  };
}

// Not checkable: Flagsmith's API keeps no date for when a flag's variants were added, so an experiment on a flag
// converted to multivariate after it started can't be told apart from one that was multivariate all along.
const lateMultivariate = (): Diagnosis => ({
  check: 'late multivariate',
  verdict: 'skip',
  summary: "not checked: Flagsmith's API doesn't record when a flag's variants were added.",
});

const MARK: Record<Verdict, string> = { pass: '✓ pass', warn: '! warn', fail: '✗ fail', skip: '- skip' };
export function formatDiagnoses(experiment: Pick<ExperimentDetail, 'id' | 'name' | 'status'>, diagnoses: Diagnosis[]): string[] {
  const lines = [`Experiment ${experiment.id} "${experiment.name}" (${experiment.status}):`];
  for (const d of diagnoses) {
    lines.push(`  ${MARK[d.verdict]}  ${d.check}: ${d.summary}`);
    if (d.meaning) lines.push(`          What it means: ${d.meaning}`);
    if (d.fix) lines.push(`          How to fix: ${d.fix}`);
  }
  return lines;
}

const RECENT_DAYS = 14;
type Summary = { id: number; status: string };

// Running and paused experiments, and those completed in the last two weeks (the newest 10). Returns the number of failed checks.
export async function experimentDoctor(api: AdminClient, envKey: string, log: (line: string) => void, now = Date.now()): Promise<number> {
  const base = `/api/v1/environments/${encodeURIComponent(envKey)}/experiments`;
  let list: Summary[];
  try {
    list = await api.list<Summary>(`${base}/`);
  } catch (error) {
    log(`(Experiment doctor skipped: couldn't list experiments (${(error as { status?: number }).status ?? (error as Error).message}).)`);
    return 0;
  }
  const candidates = list.filter((e) => e.status !== 'created').sort((a, b) => b.id - a.id).slice(0, 10);
  const chosen: ExperimentDetail[] = [];
  for (const e of candidates) {
    const detail = await api.get<ExperimentDetail>(`${base}/${e.id}/`);
    const ended = detail.ended_at ? Date.parse(detail.ended_at) : NaN;
    if (detail.status === 'completed' && !(now - ended <= RECENT_DAYS * 86_400_000)) continue;
    chosen.push(detail);
  }
  log('');
  log('Experiment doctor: is traffic and event data reaching each experiment intact? (sanity checks, not results)');
  if (!chosen.length) {
    log(`No running, paused or recently completed (${RECENT_DAYS} days) experiments in this environment.`);
    return 0;
  }
  let fails = 0;
  for (const detail of chosen) {
    let results: Results | null = null;
    try {
      results = (await api.get<{ results: Results | null }>(`${base}/${detail.id}/results/`)).results;
    } catch {
      results = null;
    }
    const diagnoses = diagnose(detail, results);
    fails += diagnoses.filter((d) => d.verdict === 'fail').length;
    for (const line of formatDiagnoses(detail, diagnoses)) log(line);
  }
  return fails;
}
