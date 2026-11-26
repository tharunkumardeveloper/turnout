// switchyard release <label>: start the next experiment on the same flag. Whatever the flag serves today becomes
// control, the new release becomes v2. Flagsmith clears the previous experiment's leftover override when this one
// starts (merged in Flagsmith #8770).
import { AdminClient, type Experiment, type Feature } from '../flagsmith/admin.ts';
import { CONTROL, type ExperimentDetail, type FlagState } from '../flagsmith/experiments.ts';

type Options = {
  apiUrl: string;
  adminKey: string;
  envKey: string;
  flag: string;
  releases: ReadonlySet<string>; // the config allowlist
  newRelease: string;
  hypothesis: string;
  split?: number; // % of the rollout that gets the new release
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
  if (!feature) throw new Error(`Flag "${opts.flag}" not found. Run switchyard init first.`);
  const v2 = feature.multivariate_options.find((o) => o.key === 'v2');
  if (!v2) throw new Error(`Flag "${opts.flag}" has no variant with key v2.`);

  const experiments = (await api.list<Experiment>(`${envPath}/experiments/`)).filter((e) => e.feature.id === feature.id);
  const unfinished = experiments.find((e) => e.status !== 'completed');
  if (unfinished) {
    throw new Error(`Experiment ${unfinished.id} ("${unfinished.name}") is ${unfinished.status}. Ship or revert it and complete it first.`);
  }
  const previous = experiments.sort((a, b) => b.id - a.id)[0];
  if (!previous) throw new Error('No previous experiment on this flag to take metrics from. Run switchyard init first.');
  const metrics = (await api.get<ExperimentDetail>(`${envPath}/experiments/${previous.id}/`)).metrics.map((m) => ({
    metric: m.metric,
    expected_direction: m.expected_direction,
  }));

  const flagPath = `/api/__future__/environments/${opts.envKey}/features/${feature.id}/`;
  const live = currentRelease(await api.get<FlagState>(flagPath), feature.multivariate_options);
  if (live === opts.newRelease) throw new Error(`${opts.newRelease} is already what everyone gets.`);
  for (const label of [live, opts.newRelease]) {
    if (!opts.releases.has(label)) throw new Error(`"${label}" isn't in switchyard.config.yml's releases, so the proxy couldn't route to it.`);
  }
  log(`Live today: ${live}. New: ${opts.newRelease}.`);

  // 1. Everyone keeps getting the live release, now as control (the flag's own value), with v2 at 0%.
  await api.patch(flagPath, {
    environment_default: { enabled: true, value: { type: 'string', value: live }, variants: [{ id: v2.id, weight: 0 }] },
  });
  log(`✓ ${live} is control (served to everyone outside the experiment)`);

  // 2. v2 now serves the new release. Allowed while no experiment is running on the flag.
  // A full PUT: Flagsmith 2.291.0's option validator reads every field, so a partial PATCH answers 500
  // (KeyError in features/multivariate/serializers.py:85-86).
  await api.put(`/api/v1/projects/${env.project}/features/${feature.id}/mv-options/${v2.id}/`, {
    feature: feature.id,
    type: 'unicode',
    string_value: opts.newRelease,
    default_percentage_allocation: 0,
    key: 'v2',
  });
  log(`✓ v2 → ${opts.newRelease}`);

  // 3. The next experiment, same flag, same metrics.
  const split = opts.split ?? 50;
  const created = await api.post<Experiment>(`${envPath}/experiments/`, {
    feature: feature.id,
    name: `${opts.flag}: ${opts.newRelease} vs ${live}`,
    hypothesis: opts.hypothesis,
    metrics,
    experiment_rollout: {
      enabled: true,
      rollout_percentage: 100,
      feature_state_value: { type: 'string', value: live },
      multivariate_feature_state_values: [{ multivariate_feature_option: v2.id, percentage_allocation: split }],
    },
  });
  const started = await api.post<Experiment>(`${envPath}/experiments/${created.id}/start/`);
  log(`✓ experiment ${started.id} "${started.name}" is ${started.status}: ${split}% of visitors get ${opts.newRelease}, the rest ${live} (${CONTROL})`);
  return { experimentId: started.id };
}
