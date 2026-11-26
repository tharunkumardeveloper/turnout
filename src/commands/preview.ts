// switchyard preview <label>: serve a new release to your team only, before its experiment starts.
// A segment override (trait preview = "true") gives them the new release. Because it exists before the experiment,
// the experiment's rollout is added below it (features/feature_segments/services.py:69-75), so the team keeps the
// new release and stays out of the experiment's data.
import { AdminClient, type Experiment, type Feature } from '../flagsmith/admin.ts';
import type { FlagState } from '../flagsmith/experiments.ts';
import { currentRelease } from './release.ts';

export const PREVIEW_SEGMENT = 'switchyard-preview';
export const PREVIEW_TRAIT = 'preview';

type Options = {
  apiUrl: string;
  adminKey: string;
  envKey: string;
  flag: string;
  releases: ReadonlySet<string>;
  newRelease: string;
  log?: (line: string) => void;
};

type Segment = { id: number; name: string };

export async function preview(opts: Options): Promise<void> {
  const log = opts.log ?? console.log;
  const api = new AdminClient(opts.apiUrl, { apiKey: opts.adminKey });
  const envPath = `/api/v1/environments/${opts.envKey}`;
  const env = await api.get<{ project: number }>(`${envPath}/`);

  const feature = (await api.list<Feature>(`/api/v1/projects/${env.project}/features/?search=${opts.flag}`)).find((f) => f.name === opts.flag);
  if (!feature) throw new Error(`Flag "${opts.flag}" not found. Run switchyard init first.`);
  const v2 = feature.multivariate_options.find((o) => o.key === 'v2');
  if (!v2) throw new Error(`Flag "${opts.flag}" has no variant with key v2.`);
  const unfinished = (await api.list<Experiment>(`${envPath}/experiments/`)).find((e) => e.feature.id === feature.id && e.status !== 'completed');
  if (unfinished) {
    throw new Error(`Experiment ${unfinished.id} is ${unfinished.status}. A preview must start before the experiment, so it outranks it.`);
  }
  if (!opts.releases.has(opts.newRelease)) throw new Error(`"${opts.newRelease}" isn't in switchyard.config.yml's releases.`);

  const segment =
    (await api.list<Segment>(`/api/v1/projects/${env.project}/segments/`)).find((s) => s.name === PREVIEW_SEGMENT) ??
    (await api.post<Segment>(`/api/v1/projects/${env.project}/segments/`, {
      name: PREVIEW_SEGMENT,
      project: env.project,
      description: 'Visitors who opened a Switchyard preview link. They see the next release before its experiment.',
      rules: [{ type: 'ALL', rules: [{ type: 'ANY', rules: [], conditions: [{ operator: 'EQUAL', property: PREVIEW_TRAIT, value: 'true' }] }], conditions: [] }],
    }));
  log(`✓ segment "${segment.name}" (trait ${PREVIEW_TRAIT} = "true")`);

  const flagPath = `/api/__future__/environments/${opts.envKey}/features/${feature.id}/`;
  const live = currentRelease(await api.get<FlagState>(flagPath), feature.multivariate_options);
  if (live === opts.newRelease) throw new Error(`${opts.newRelease} is already what everyone gets.`);

  // Everyone else keeps the live release (as control); v2 becomes the new release; the preview segment gets v2.
  await api.patch(flagPath, {
    environment_default: { enabled: true, value: { type: 'string', value: live }, variants: [{ id: v2.id, weight: 0 }] },
  });
  // A full PUT: Flagsmith 2.291.0's option validator reads every field, so a partial PATCH answers 500
  // (KeyError in features/multivariate/serializers.py:85-86).
  await api.put(`/api/v1/projects/${env.project}/features/${feature.id}/mv-options/${v2.id}/`, {
    feature: feature.id,
    type: 'unicode',
    string_value: opts.newRelease,
    default_percentage_allocation: 0,
    key: 'v2',
  });
  // Priorities must be unique. A finished experiment's drained override may still hold one; take the next free
  // number. Flagsmith deletes that override when the next experiment starts, and adds the new rollout below ours.
  const state = await api.get<FlagState>(flagPath);
  const existing = state.segment_overrides.find((o) => o.segment.id === segment.id);
  const priority = existing?.priority ?? Math.max(-1, ...state.segment_overrides.map((o) => o.priority)) + 1;
  await api.patch(flagPath, {
    segment_overrides: [
      { segment: { id: segment.id }, priority, enabled: true, value: { type: 'string', value: live }, variants: [{ id: v2.id, weight: 100 }] },
    ],
  });
  log(`✓ your team gets ${opts.newRelease}; everyone else still gets ${live}`);
  log(`Open the preview link once per browser: <proxy>/__switchyard/preview?token=<SWITCHYARD_PREVIEW_TOKEN>`);
  log(`Then start the experiment: switchyard release ${opts.newRelease}`);
}
