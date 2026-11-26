import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBlindStore, expectedCall, pickTruth, scoreRound, truthText } from '../src/console/blind.ts';
import type { Recommendation } from '../src/flagsmith/experiments.ts';

const seq = (...xs: number[]) => { let i = 0; return () => xs[i++ % xs.length]!; };
const rec = (call: Recommendation['call'], chance = 0.97): Recommendation => ({ call, variant: 'v2', reason: 'r', interval: null, chanceToWin: chance });

test('each scenario is drawn, with the better release converting 60% more, and identical rates for A/A', () => {
  const nb = pickTruth(1, 'shop:1.4', 'shop:1.5', 'shop:1.6', seq(0.1, 0.5));
  assert.equal(nb.scenario, 'new-better');
  assert.equal(nb.rates.control, 0.1);
  assert.equal(nb.rates.v2, 0.16);
  const ob = pickTruth(1, 'shop:1.4', 'shop:1.5', null, seq(0.5, 0));
  assert.equal(ob.scenario, 'old-better');
  assert.ok(ob.rates.control > ob.rates.v2);
  const aa = pickTruth(1, 'shop:1.4', 'shop:1.5', null, seq(0.99, 0.99));
  assert.equal(aa.scenario, 'same');
  assert.equal(aa.rates.control, aa.rates.v2);
  assert.ok(aa.rates.v2 >= 0.08 && aa.rates.v2 <= 0.12);
  assert.equal(pickTruth(2, 'shop:1.5', 'shop:1.6', 'shop:1.6', seq(0.1)).slow, true);
});

test('scoring: the right call, no call (keep running where there was a difference), or wrong', () => {
  const t = (scenario: 'new-better' | 'old-better' | 'same', slow = false) => ({ ...pickTruth(1, 'a', 'b', null, seq(0)), scenario, slow });
  assert.equal(expectedCall(t('new-better')), 'ship');
  assert.equal(expectedCall(t('old-better')), 'revert');
  assert.equal(expectedCall(t('same')), 'keep-running');
  assert.equal(expectedCall(t('new-better', true)), 'revert', 'the slow release must be stopped whatever its orders');
  assert.equal(scoreRound(t('new-better'), 'ship'), 'right');
  assert.equal(scoreRound(t('new-better'), 'keep-running'), 'no-call');
  assert.equal(scoreRound(t('new-better'), 'revert'), 'wrong');
  assert.equal(scoreRound(t('same'), 'keep-running'), 'right');
  assert.equal(scoreRound(t('same'), 'ship'), 'wrong', 'a winner declared in an A/A round is a false positive');
  assert.match(truthText({ ...t('same'), rates: { control: 0.1, v2: 0.1 } }), /identical on orders \(10\.0% each\)/);
});

test('the store keeps one hidden truth per experiment, records each round once, and survives a restart', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'blind-')), 'blind.json');
  const a = createBlindStore(file, { slowRelease: 'shop:1.6', rand: seq(0.1, 0.5) });
  const t1 = a.truthFor(7, 'shop:1.4', 'shop:1.5');
  assert.deepEqual(a.truthFor(7, 'shop:1.4', 'shop:1.5'), t1, 'drawn once');
  assert.equal(a.decide(99, rec('ship'), 'ship'), null, 'no truth, no round');
  const r = a.decide(7, rec('ship'), 'ship')!;
  assert.equal(r.outcome, 'right');
  assert.equal(a.decide(7, rec('revert'), 'revert')!.outcome, 'right', 'recorded once: the first decision stands');
  a.notePoint(7, { asOf: 't1', chanceToWin: 0.6, low: -0.1, high: 0.5, identities: 300 });
  a.notePoint(7, { asOf: 't1', chanceToWin: 0.6, low: -0.1, high: 0.5, identities: 300 });
  a.notePoint(7, { asOf: 't2', chanceToWin: 0.97, low: 0.1, high: 0.6, identities: 900 });
  const b = createBlindStore(file);
  assert.deepEqual(b.truth(7), t1);
  assert.deepEqual(b.score(), { rounds: 1, right: 1, wrong: 0, noCall: 0 });
  assert.deepEqual(b.series(7).map((p) => p.asOf), ['t1', 't2']);
});
