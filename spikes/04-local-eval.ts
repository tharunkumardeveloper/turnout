// Spike 4: under local evaluation, does the environment document carry the experiment's rollout,
// does getExperimentFlag record exposures, and does Flagsmith accept them?
// Run: node spikes/04-local-eval.ts   (after `turnout init`, with Flagsmith on localhost:8000)
import { randomUUID } from 'node:crypto';
import { Flag, Flagsmith } from '@flagsmith/nodejs';

process.loadEnvFile('.env');
const API = 'http://localhost:8000/api/v1/';
const serverKey = process.env.TURNOUT_SERVER_KEY!;

const doc: any = await (await fetch(`${API}environment-document/`, { headers: { 'X-Environment-Key': serverKey } })).json();
const segments = (doc.project?.segments ?? []) as { name: string; rules: unknown }[];
console.log('segments in the environment document:', segments.map((s) => s.name));
const fs = (doc.feature_states ?? []).find((f: { feature: { name: string } }) => f.feature.name === 'shop_release');
console.log('env default weights:', JSON.stringify(fs?.multivariate_feature_state_values?.map((v: { percentage_allocation: number }) => v.percentage_allocation)));

const eventResponses: string[] = [];
const loggingFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes('/events')) {
    const body = await res.clone().text();
    eventResponses.push(`${res.status} ${body.slice(0, 300)}`);
  }
  return res;
};

const flagsmith = new Flagsmith({
  environmentKey: serverKey,
  apiUrl: API,
  enableLocalEvaluation: true,
  enableEvents: true,
  eventProcessorConfig: { eventsApiUrl: 'http://localhost:8000/api/' },
  fetch: loggingFetch,
});

const counts: Record<string, number> = {};
let enrolled = 0;
const ids: string[] = [];
for (let i = 0; i < 200; i++) {
  const id = randomUUID();
  ids.push(id);
  const flag = await flagsmith.getExperimentFlag('shop_release', id);
  if (!(flag instanceof Flag)) throw new Error('flag not found');
  const key = `${flag.variant}=${flag.value}`;
  counts[key] = (counts[key] ?? 0) + 1;
  if (flag.experiment?.inExperiment) enrolled++;
}
console.log('variants over 200 identities:', counts, `enrolled: ${enrolled}`);

// A conversion for a quarter of them, so the events endpoint sees both kinds.
for (const id of ids.slice(0, 50)) flagsmith.trackEvent('order_placed', { identifier: id });

await flagsmith.close();
console.log('events endpoint responses:', eventResponses);
