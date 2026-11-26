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
