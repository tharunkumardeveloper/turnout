// Minimal reproduction: @flagsmith/nodejs drops events when they're tracked faster than one batch round-trip.
// No Turnout. One file, the SDK, and a local stand-in for Flagsmith's events endpoint that answers like 2.291.0
// (202 { accepted, rejected }, 413 over 2 MiB) after a configurable delay.
//
//   npm i @flagsmith/nodejs@9.4.0
//   node repro.mjs [eventsPerSecond=700] [seconds=20] [endpointDelayMs=4000] [maxBuffer=default] [flushMs=default]
//
// Prints: events tracked, events the endpoint received, events lost, and how many the SDK logged as dropped.
import http from 'node:http';
import { Flagsmith } from '@flagsmith/nodejs';

const [rate = 700, seconds = 20, delayMs = 4000, maxBuffer, flushMs] = process.argv.slice(2).map(Number);
const MAX_BODY = 2_097_152; // Flagsmith 2.291.0: experimentation/constants.py MAX_BODY_BYTES

let received = 0;
let batches = 0;
let tooLarge = 0;
const server = http.createServer((req, res) => {
  if (!req.url.endsWith('/v1/events')) {
    // The SDK only needs an environment document for local evaluation; events don't depend on it.
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ api_key: 'k', feature_states: [], identity_overrides: [], segment_overrides: [], name: 'e', id: 1,
      project: { id: 1, name: 'p', hide_disabled_flags: false, segments: [], organisation: { id: 1, name: 'o', feature_analytics: false, persist_trait_data: true, stop_serving_flags: false } } }));
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => setTimeout(() => {
    const body = Buffer.concat(chunks);
    if (body.length > MAX_BODY) { tooLarge++; res.writeHead(413).end('length limit exceeded'); return; }
    const n = JSON.parse(body).events.length;
    received += n;
    batches++;
    res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ accepted: n, rejected: [] }));
  }, delayMs));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/`;

let droppedLogged = 0;
const count = (m) => { const many = String(m).match(/Dropping its (\d+) oldest/); if (many) droppedLogged += +many[1]; else if (/Dropping its oldest event/.test(m)) droppedLogged++; };
const logger = { debug() {}, info() {}, error() {}, warn: (...a) => count(a.filter((x) => typeof x === 'string').join(' ')), child() { return logger; } };

const flagsmith = new Flagsmith({
  environmentKey: 'ser.repro',
  apiUrl: `${base}v1/`,
  enableLocalEvaluation: true,
  enableEvents: true,
  eventProcessorConfig: { eventsApiUrl: base, ...(maxBuffer ? { maxBuffer } : {}), ...(flushMs ? { flushInterval: flushMs } : {}), requestTimeoutMs: 30_000 },
  logger,
});

// Track `rate` events a second for `seconds`, spread over 10 ms ticks (like a busy server handling requests).
// Paced by elapsed time, so the rate is exact whatever the timer resolution.
let tracked = 0;
const started = Date.now();
await new Promise((done) => {
  const t = setInterval(() => {
    const elapsed = Math.min(Date.now() - started, seconds * 1000);
    for (const target = Math.floor((rate * elapsed) / 1000); tracked < target; tracked++) {
      flagsmith.trackEvent('page_view', { identifier: `user-${tracked % 5000}`, value: 1 });
    }
    if (elapsed >= seconds * 1000) { clearInterval(t); done(); }
  }, 10);
});
await flagsmith.close(); // flushes what is left
server.close();

const lost = tracked - received;
console.log(JSON.stringify({
  sdk: '@flagsmith/nodejs 9.4.0', eventsPerSecond: rate, seconds, endpointDelayMs: delayMs,
  maxBuffer: maxBuffer ?? 'default (1000)', flushIntervalMs: flushMs ?? 'default (10000)',
  tracked, received, lost, lostPct: +(100 * lost / tracked).toFixed(1), droppedLoggedAsWarning: droppedLogged, batches, rejected413: tooLarge,
}));
