// Spikes 7–9 against a real Flagsmith: what do enrolled visitors get after
//   A) the documented Round 04 (Complete, then update the flag), versus
//   B) Turnover's Ship winner (pause, default = winner, drain, complete), then a swing-back edit?
// Run: node spikes/07-round04.ts   (after `turnover init`, Flagsmith on localhost:8000)
import { randomUUID } from 'node:crypto';
import { Flag, Flagsmith } from '@flagsmith/nodejs';
import { AdminClient, type Environment, type Feature, type MvOption, type Project } from '../src/flagsmith/admin.ts';
import { Experiments, planShip, runSteps } from '../src/flagsmith/experiments.ts';

process.loadEnvFile('.env');
const API = 'http://localhost:8000/api/v1/';
const api = new AdminClient(API, { apiKey: process.env.TURNOVER_ADMIN_KEY! });
const serverKey = process.env.TURNOVER_SERVER_KEY!;
const project = (await api.list<Project>('/api/v1/projects/')).find((p) => p.name === 'Turnover demo')!;
const env = (await api.list<Environment>(`/api/v1/environments/?project=${project.id}`))[0]!;
const metric = (await api.list<{ id: number }>(`/api/v1/environments/${env.api_key}/experiment-metrics/`))[0]!;
const visitors = Array.from({ length: 300 }, () => randomUUID());

async function newExperiment(label: string) {
  const name = `spike_${label}_${Date.now()}`;
  const feature = await api.post<Feature>(`/api/v1/projects/${project.id}/features/`, { name, initial_value: 'old', default_enabled: true });
  const v2 = await api.post<MvOption>(`/api/v1/projects/${project.id}/features/${feature.id}/mv-options/`, {
    feature: feature.id, type: 'unicode', string_value: 'new', default_percentage_allocation: 0, key: 'v2',
  });
  const exp = await api.post<{ id: number }>(`/api/v1/environments/${env.api_key}/experiments/`, {
    feature: feature.id, name, hypothesis: 'spike',
    metrics: [{ metric: metric.id, expected_direction: 'increase' }],
    experiment_rollout: {
      enabled: true, rollout_percentage: 100, feature_state_value: { type: 'string', value: 'old' },
      multivariate_feature_state_values: [{ multivariate_feature_option: v2.id, percentage_allocation: 50 }],
    },
  });
  await api.post(`/api/v1/environments/${env.api_key}/experiments/${exp.id}/start/`);
  return { name, feature, v2, experiments: new Experiments(api, { envKey: env.api_key, experimentId: exp.id }) };
}

// What every visitor gets right now, through a fresh local-evaluation SDK (fresh environment document).
async function census(flagName: string): Promise<Record<string, number>> {
  const sdk = new Flagsmith({ environmentKey: serverKey, apiUrl: API, enableLocalEvaluation: true });
  const tally: Record<string, number> = {};
  for (const id of visitors) {
    const flag = (await sdk.getIdentityFlags(id)).getFlag(flagName);
    const key = flag instanceof Flag && flag.enabled ? `${flag.variant ?? 'control'}${flag.experiment?.inExperiment ? '·enrolled' : ''}` : 'disabled';
    tally[key] = (tally[key] ?? 0) + 1;
  }
  await sdk.close();
  return tally;
}

const futurePatch = (featureId: number, body: unknown) =>
  api.patch(`/api/__future__/environments/${env.api_key}/features/${featureId}/`, body);

console.log('A) Documented Round 04: Complete, then set the flag to serve v2 to everyone');
const a = await newExperiment('documented');
console.log('   while running:      ', await census(a.name));
await api.post(`/api/v1/environments/${env.api_key}/experiments/${a.experiments.ref.experimentId}/complete/`);
await futurePatch(a.feature.id, { environment_default: { enabled: true, variants: [{ id: a.v2.id, weight: 100 }] } });
console.log('   after Complete+edit:', await census(a.name));

console.log('B) Turnover Ship winner (v2), then swing back to control with one flag edit');
const b = await newExperiment('turnover');
console.log('   while running:      ', await census(b.name));
await runSteps(b.experiments, await planShip(b.experiments, 'v2', '.turnover/spike-snapshots'), (s) => console.log(`   ${s.status === 'done' ? '✓' : '·'} ${s.title}`));
console.log('   after Ship:         ', await census(b.name));
try {
  await futurePatch(b.feature.id, { environment_default: { enabled: true, variants: [{ id: b.v2.id, weight: 0 }] } });
  console.log('   after swing-back:   ', await census(b.name));
} catch (error) {
  console.log('   swing-back refused: ', (error as Error).message);
}
