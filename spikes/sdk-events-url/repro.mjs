// Minimal reproduction: @flagsmith/nodejs pointed at a self-hosted Flagsmith (apiUrl) still sends experiment events to
// Flagsmith Cloud, because the events address defaults to https://events.api.flagsmith.com/ whatever apiUrl says.
// No Turnout. A local stand-in answers the environment document; a custom fetch records where every request goes and
// answers it locally, so this script sends nothing to the internet.
//
//   npm i @flagsmith/nodejs        (9.4.0 and 9.5.0 behave the same)
//   node repro.mjs
import http from 'node:http';
import { Flagsmith } from '@flagsmith/nodejs';

const doc = { api_key: 'ser.selfhosted', feature_states: [], identity_overrides: [], segment_overrides: [], name: 'e', id: 1,
  project: { id: 1, name: 'p', hide_disabled_flags: false, segments: [], organisation: { id: 1, name: 'o', feature_analytics: false, persist_trait_data: true, stop_serving_flags: false } } };
const selfHosted = http.createServer((_q, r) => r.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(doc)));
await new Promise((r) => selfHosted.listen(0, '127.0.0.1', r));
const apiUrl = `http://127.0.0.1:${selfHosted.address().port}/api/v1/`;

const requests = [];
const recordingFetch = async (url, init) => {
  const u = String(url);
  requests.push(`${init?.method ?? 'GET'} ${u}`);
  if (u.startsWith(apiUrl)) return fetch(url, init); // the self-hosted instance: answered for real
  return new Response(JSON.stringify({ accepted: 1, rejected: [] }), { status: 202, headers: { 'content-type': 'application/json' } }); // not sent
};

const flagsmith = new Flagsmith({ environmentKey: 'ser.selfhosted', apiUrl, enableLocalEvaluation: true, enableEvents: true, fetch: recordingFetch });
await flagsmith.getEnvironmentFlags();
flagsmith.trackEvent('checkout_completed', { identifier: 'visitor-1' });
await flagsmith.close(); // flushes the event buffer
selfHosted.close();

console.log(`apiUrl (self-hosted): ${apiUrl}`);
for (const r of requests) console.log(`  ${r}`);
const leaked = requests.filter((r) => !r.includes(apiUrl));
console.log(leaked.length ? `\nEvents left for: ${leaked.map((r) => new URL(r.split(' ')[1]).origin).join(', ')} (not ${new URL(apiUrl).origin})` : '\nEvents stayed on the self-hosted instance.');
