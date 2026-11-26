// turnout release <label>: start the next experiment on the same flag. Whatever the flag serves today becomes
// control, the new release becomes v2. Flagsmith clears the previous experiment's leftover override when this one
// starts (merged in Flagsmith #8770).
import { AdminClient, type Experiment, type Feature } from '../flagsmith/admin.ts';
import { CONTROL, type ExperimentDetail, type FlagState, type Results } from '../flagsmith/experiments.ts';

type Options = {
  apiUrl: string;
  adminKey: string;
  envKey: string;
  flag: string;
  releases: ReadonlySet<string>; // the config allowlist
  newRelease: string;
  hypothesis: string;
  split?: number; // % of the rollout that gets the new release
  aa?: boolean; // A/A: v2 serves the live release too (newRelease is then ignored unless it names the live one)
  also?: string[]; // more new releases in the same experiment (an A/B/C test): variants v3, v4…, split evenly
  mde?: number; // relative lift the launch estimate sizes for, % (default 10)
  dailyVisitors?: number; // visitors a day through the experiment, for the estimate in days
  log?: (line: string) => void;
};

// What every visitor outside an experiment gets today: a variant at 100% on the environment default, else its value.
export function currentRelease(flag: FlagState, options: Feature['multivariate_options']): string {
  for (const v of flag.environment_default.variants) {
    if (v.weight >= 100) {
      const option = options.find((o) => o.id === v.id);
      if (option?.string_value) return option.string_value;
    }
  }
  return flag.environment_default.value.value;
}

export const AA_HYPOTHESIS = 'A/A: same release on both arms; any winner is noise';

// Rough visitors per arm to detect a relative lift `mde` at baseline rate p (80% power, 5% two-sided):
// n ≈ 16·p(1−p)/(p·mde)². Flagsmith's own statistics decide the result; this only sizes the launch.
export function visitorsPerArm(p: number, mde: number): number {
  return Math.ceil((16 * p * (1 - p)) / (p * mde) ** 2);
}

export function launchEstimate(baseline: number | null, opts: { mde?: number; split?: number; dailyVisitors?: number } = {}): string {
  const mde = (opts.mde ?? 10) / 100;
  const tail = "rough estimate; Flagsmith does the real statistics; don't ship on an early reading";
  if (baseline == null || !(baseline > 0 && baseline < 1)) {
    return `Launch estimate: visitors needed per arm for a ${Math.round(mde * 100)}% lift: unknown (no baseline goal rate from a previous experiment) (${tail}).`;
  }
  const n = visitorsPerArm(baseline, mde);
  let days = '';
  if (opts.dailyVisitors && opts.dailyVisitors > 0) {
    const smaller = Math.min(opts.split ?? 50, 100 - (opts.split ?? 50)) / 100; // the smaller arm sets the pace
    days = `, about ${Math.ceil(n / (opts.dailyVisitors * smaller))} days at ${opts.dailyVisitors} visitors a day`;
  }
  return `Launch estimate: ~${n.toLocaleString('en-US')} visitors per arm to detect a ${Math.round(mde * 100)}% relative lift on a ${(baseline * 100).toFixed(1)}% baseline${days} (${tail}).`;
}

// Control's goal rate in an experiment's results: the primary (first) metric, as conversions per exposed visitor.
export function baselineRate(experiment: ExperimentDetail, results: Results | null): number | null {
  const primary = experiment.metrics[0];
  if (!primary || primary.aggregation !== 'occurrence') return null;
  const control = results?.payload?.metrics.find((m) => m.metric_id === primary.metric)?.variants[CONTROL];
  return control && control.n > 0 ? control.sum / control.n : null;
}

export async function release(opts: Options): Promise<{ experimentId: number }> {
  const log = opts.log ?? console.log;
  // Checked before anything changes in Flagsmith: at 0 or 100 one side of the experiment would get nobody.
  if (opts.split !== undefined && !(Number.isFinite(opts.split) && opts.split > 0 && opts.split < 100)) {
    throw new Error(`The split must be a percentage above 0 and below 100, got ${opts.split}.`);
  }
  const api = new AdminClient(opts.apiUrl, { apiKey: opts.adminKey });
  const envPath = `/api/v1/environments/${opts.envKey}`;

  const env = await api.get<{ project: number }>(`${envPath}/`);
  const feature = (await api.list<Feature>(`/api/v1/projects/${env.project}/features/?search=${opts.flag}`)).find((f) => f.name === opts.flag);
  if (!feature) throw new Error(`Flag "${opts.flag}" not found. Run turnout init first.`);
  const v2 = feature.multivariate_options.find((o) => o.key === 'v2');
  if (!v2) throw new Error(`Flag "${opts.flag}" has no variant with key v2.`);

  const experiments = (await api.list<Experiment>(`${envPath}/experiments/`)).filter((e) => e.feature.id === feature.id);
  const unfinished = experiments.find((e) => e.status !== 'completed');
  if (unfinished) {
    throw new Error(`Experiment ${unfinished.id} ("${unfinished.name}") is ${unfinished.status}. Ship or revert it and complete it first.`);
  }
  const previous = experiments.sort((a, b) => b.id - a.id)[0];
  if (!previous) throw new Error('No previous experiment on this flag to take metrics from. Run turnout init first.');
  const previousDetail = await api.get<ExperimentDetail>(`${envPath}/experiments/${previous.id}/`);
  const metrics = previousDetail.metrics.map((m) => ({
    metric: m.metric,
    expected_direction: m.expected_direction,
  }));

  const flagPath = `/api/__future__/environments/${opts.envKey}/features/${feature.id}/`;
  const live = currentRelease(await api.get<FlagState>(flagPath), feature.multivariate_options);
  if (opts.aa) {
    if (opts.newRelease && opts.newRelease !== live) throw new Error(`An A/A run serves the live release on both arms; ${live} is live, not ${opts.newRelease}.`);
  } else if (live === opts.newRelease) {
    throw new Error(`${opts.newRelease} is already what everyone gets. To test the setup itself, run an A/A: turnout release --aa.`);
  }
  const next = opts.aa ? live : opts.newRelease;
  const also = opts.aa ? [] : (opts.also ?? []);
  if (opts.split !== undefined && also.length) throw new Error('An A/B/C test splits visitors evenly; leave out the split.');
  if (also.length && new Set([live, next, ...also]).size !== 2 + also.length) {
    throw new Error(`Every release in an A/B/C test must be different, and none can be ${live}, which everyone gets now.`);
  }
  for (const label of new Set([live, next, ...also])) {
    if (!opts.releases.has(label)) throw new Error(`"${label}" isn't in turnout.config.yml's releases, so the proxy couldn't route to it.`);
  }
  log(opts.aa ? `Live today: ${live}. A/A run: ${live} on both arms.` : `Live today: ${live}. New: ${[opts.newRelease, ...also].join(', ')}.`);

  // 1. Everyone keeps getting the live release, now as control (the flag's own value), with v2 at 0%.
  const allAtZero = (ids: number[]) => ({ enabled: true, value: { type: 'string', value: live }, variants: ids.map((id) => ({ id, weight: 0 })) });
  await api.patch(flagPath, { environment_default: allAtZero(feature.multivariate_options.map((o) => o.id)) });
  log(`✓ ${live} is control (served to everyone outside the experiment)`);

  // 2. v2 now serves the new release. Allowed while no experiment is running on the flag.
  // A full PUT: Flagsmith 2.291.0's option validator reads every field, so a partial PATCH answers 500
  // (KeyError in features/multivariate/serializers.py:85-86).
  await api.put(`/api/v1/projects/${env.project}/features/${feature.id}/mv-options/${v2.id}/`, {
    feature: feature.id,
    type: 'unicode',
    string_value: next, // in an A/A, the same value as control: Flagsmith only requires unique keys (features/multivariate/serializers.py:138-147)
    default_percentage_allocation: 0,
    key: 'v2',
  });
  log(`✓ v2 → ${next}`);

  // 2b. An A/B/C test: v3, v4… serve the other new releases. Each is created on the flag the first time.
  const extra: { id: number; key: string; label: string }[] = [];
  for (const [i, label] of also.entries()) {
    const key = `v${i + 3}`;
    const body = { feature: feature.id, type: 'unicode', string_value: label, default_percentage_allocation: 0, key };
    const existing = feature.multivariate_options.find((o) => o.key === key);
    const option = existing
      ? (await api.put<{ id: number }>(`/api/v1/projects/${env.project}/features/${feature.id}/mv-options/${existing.id}/`, body), existing)
      : await api.post<{ id: number }>(`/api/v1/projects/${env.project}/features/${feature.id}/mv-options/`, body);
    extra.push({ id: option.id, key, label });
    log(`✓ ${key} → ${label}${existing ? '' : ' (a new variation on the flag)'}`);
  }
  if (extra.some((x) => !feature.multivariate_options.some((o) => o.id === x.id))) {
    await api.patch(flagPath, { environment_default: allAtZero([...feature.multivariate_options.map((o) => o.id), ...extra.map((x) => x.id)]) });
  }

  // 3. The next experiment, same flag, same metrics.
  // Two arms: the split (default 50%). More: an even share each, control keeps the remainder (34/33/33).
  const split = also.length ? Math.floor(100 / (2 + also.length)) : (opts.split ?? 50);
  const created = await api.post<Experiment>(`${envPath}/experiments/`, {
    feature: feature.id,
    name: opts.aa ? `${opts.flag}: A/A ${live}` : `${opts.flag}: ${[opts.newRelease, ...also].join(' vs ')} vs ${live}`,
    hypothesis: opts.aa ? AA_HYPOTHESIS : opts.hypothesis,
    metrics,
    experiment_rollout: {
      enabled: true,
      rollout_percentage: 100,
      feature_state_value: { type: 'string', value: live },
      multivariate_feature_state_values: [v2.id, ...extra.map((x) => x.id)].map((id) => ({ multivariate_feature_option: id, percentage_allocation: split })),
    },
  });
  const started = await api.post<Experiment>(`${envPath}/experiments/${created.id}/start/`);
  log(
    also.length
      ? `✓ experiment ${started.id} "${started.name}" is ${started.status}: ${split}% of visitors each get ${[next, ...also].join(' and ')}, the rest ${live} (${CONTROL})`
      : `✓ experiment ${started.id} "${started.name}" is ${started.status}: ${split}% of visitors get ${next}${opts.aa ? ' (v2)' : ''}, the rest ${live} (${CONTROL})`,
  );

  // The baseline: control's goal rate in the previous experiment. Any failure just makes it unknown.
  let baseline: number | null = null;
  try {
    baseline = baselineRate(previousDetail, (await api.get<{ results: Results | null }>(`${envPath}/experiments/${previous.id}/results/`)).results);
  } catch {
    baseline = null;
  }
  log(launchEstimate(baseline, { split, ...(opts.mde !== undefined ? { mde: opts.mde } : {}), ...(opts.dailyVisitors !== undefined ? { dailyVisitors: opts.dailyVisitors } : {}) }));
  return { experimentId: started.id };
}
