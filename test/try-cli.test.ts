import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdict } from '../src/commands/try-cli.ts';

const state = (arms: Record<string, number>, extra: object = {}) => ({
  results: {
    metrics: [{ name: 'signup', role: 'goal', arms: Object.fromEntries(Object.entries(arms).map(([k, n]) => [k, { n, mean: 0.1 }])), v2: { lift: 0.18, chanceToWin: 0.97, ciLow: 0.02, ciHigh: 0.3 } }],
    winner: { key: 'v2', release: 'try:b', chanceToWin: 0.97 },
    losingGuardrails: [],
    recommendation: { call: 'ship' },
    ...extra,
  },
});

test('the verdict is one sentence from Flagsmith\'s numbers', () => {
  assert.equal(verdict(state({ control: 120, v2: 118 }), { 'try:b': 'B' }), 'B gets 18% more signup, 97% sure, no safety check losing: ship B.');
});

test('not sure yet, in plain words', () => {
  assert.equal(verdict(state({ control: 120, v2: 31 })), 'Not sure yet: v2 has 31 of 50 visitors.');
  assert.match(verdict({ results: null }), /^Not sure yet: Flagsmith has no results/);
});

test('a losing safety check is named', () => {
  assert.match(verdict(state({ control: 120, v2: 118 }, { losingGuardrails: [{ metric: 'doc_latency_ms' }] })), /but worse on doc_latency_ms/);
});

test('the split check flags a lopsided split', async () => {
  const { splitCheck } = await import('../src/commands/try-cli.ts');
  assert.equal(splitCheck({ control: { n: 152 }, v2: { n: 148 } }).ok, true);
  assert.equal(splitCheck({ control: { n: 200 }, v2: { n: 100 } }).ok, false);
});

test('the report is Markdown with the verdict and every metric', async () => {
  const { report } = await import('../src/commands/try-cli.ts');
  const md = report(state({ control: 120, v2: 118 }), new Date('2026-11-25T10:00:00Z'));
  assert.match(md, /^# Test report/);
  assert.match(md, /\*\*try:b gets 18% more signup/);
  assert.match(md, /\| signup \| goal \| v2 \| 118 \|/);
});

test('watching: request patterns, visitors needed, the next step after Ship', async () => {
  const { patternOf, ActionLog, visitorsNeeded } = await import('../src/tryit/watch.ts');
  const { afterShip } = await import('../src/commands/try-cli.ts');
  assert.equal(patternOf('/product/42?x=1'), '/product/*');
  assert.equal(patternOf('/'), '/');
  const log = new ActionLog();
  for (const p of ['/product/1', '/product/2', '/style.css', '/__turnout/receipt']) log.record({ method: 'GET', path: p, status: 200, release: 'try:a' });
  log.record({ method: 'POST', path: '/api/contact', status: 500, release: 'try:b' });
  assert.deepEqual(log.list().map((a) => [a.action, a.count]), [['GET /product/*', 2], ['POST /api/contact', 1]]);
  assert.deepEqual(log.list()[1]!.statuses, { '5xx': 1 });
  assert.equal(visitorsNeeded(0.1, 0.2), 3600);
  assert.equal(visitorsNeeded(0.9, 1), 50);
  assert.match(afterShip('try:b', { 'try:b': 'B' }), /^Next: make B the default deploy/);
});

test('the split check reads the split the flag asks for, not always an even one', async () => {
  const { splitCheck, splitWeights } = await import('../src/commands/try-cli.ts');
  // --split 20: 80/20 is right, and the even-split rule would have called it off.
  const arms = { control: { n: 1607 }, v2: { n: 393 } };
  assert.equal(splitCheck(arms).ok, false);
  const weights = splitWeights({ routing: { experiment: { arms: [{ key: 'control', pct: 80 }, { key: 'v2', pct: 20 }] } } });
  assert.deepEqual(weights, { control: 80, v2: 20 });
  const check = splitCheck(arms, weights);
  assert.equal(check.ok, true);
  assert.match(check.text, /for a 80\/20 split: as expected/);
  // Lopsided against that split: still caught.
  assert.equal(splitCheck({ control: { n: 1000 }, v2: { n: 1000 } }, weights).ok, false);
  // No routing (a completed test): an even split, as before.
  assert.equal(splitWeights({ routing: { experiment: null } }), null);
  // Three versions: the critical value for 2 degrees of freedom (13.82), not 1 (10.83).
  assert.equal(splitCheck({ control: { n: 1000 }, v2: { n: 1060 }, v3: { n: 940 } }).ok, true);
});

test('keep running says what it would take to settle it', () => {
  const crossing = state({ control: 250, v2: 252 }, {
    recommendation: { call: 'keep-running', settle: 'roughly 2.1× the visitors so far, about 550 per version, would settle a lift this size, if it holds' },
  });
  assert.match(verdict(crossing, { 'try:b': 'B' }), /: keep it running \(to settle it, roughly 2\.1× the visitors so far, about 550 per version, would settle a lift this size, if it holds\)\.$/);
});

test('visitors climbing while nobody reaches the goal: the goal is not being counted', async () => {
  const { fairness } = await import(new URL('../src/console/ui/verdict.js', import.meta.url).href);
  const zero = { results: { metrics: [{ name: 'signup', role: 'goal', arms: { control: { n: 140, mean: 0 }, v2: { n: 151, mean: 0 } } }] } };
  assert.match(fairness(zero, [], 'POST /signup'), /^Nobody reached the goal in any version \(140 and 151 visitors\): the goal isn't being counted\. Check that your site really sends POST \/signup/);
  // Too early to tell: nothing said.
  const early = { results: { metrics: [{ name: 'signup', role: 'goal', arms: { control: { n: 40, mean: 0 }, v2: { n: 38, mean: 0 } } }] } };
  assert.equal(fairness(early, [], 'POST /signup'), null);
});

test('turnout results warns first when nobody reaches the goal', async () => {
  const { resultsCommand } = await import('../src/commands/try-cli.ts');
  const lines: string[] = [];
  const st = { results: { metrics: [{ name: 'signup', role: 'goal', arms: { control: { n: 140, mean: 0 }, v2: { n: 151, mean: 0 } } }], winner: null, losingGuardrails: [], recommendation: { call: 'keep-running' } } };
  const client = { call: async (path: string) => (path === '/try/status' ? { goal: 'POST /signup' } : st) };
  await resultsCommand(client as any, false, (l: string) => lines.push(l));
  assert.match(lines[0]!, /^! Nobody reached the goal in any version \(140 and 151 visitors\)/);
});
