import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixtures } from './judge-fixtures.ts';

const UI = fileURLToPath(new URL('../src/console/ui/', import.meta.url));
// tour-plan.js is plain browser JS with no types; the tests treat it as untyped.
const P: any = await import(pathToFileURL(join(UI, 'tour-plan.js')).href);

const at = (current: string, over: any = {}) => ({ ...fixtures.v2Winner(), current, ...over });

// The element ids the dashboard provides for the tour (the interface contract), plus the stage's step buttons.
const TARGET_IDS = ['#welcome', '#tour-start', '#steps-panel', '#flowline', '#kpis', '#track-card', '#track', '#stage', '#stage-visual', '#fs-panel', '#fs-experiment', '#fs-flag', '#fs-results', '#history', '#shop-frame', '#map-frame', '#setup-frame'];
const ACTIONS = ['visitors', 'score', 'ship', 'revert', 'verify', 'preview', 'release', 'reset'];
const validTarget = (t: string | null) => t === null || TARGET_IDS.includes(t) || ACTIONS.some((a) => t === `[data-key="btn-${a}"]`);

function everyBeat() {
  const losing = { results: { ...fixtures.v2Winner().results, losingGuardrails: [{ metric: 'doc_latency_ms', chanceToWin: 0.001, lift: 0.4 }] } };
  return [
    ...P.introBeats(at('decide')),
    ...P.introBeats(at('visitors')),
    ...['visitors', 'score', 'decide', 'verify', 'preview', 'release'].map((c) => P.actionBeat(at(c), 'ship')),
    P.actionBeat(at('decide', losing), 'revert'),
    P.actionBeat(at('decide'), 'revert'),
    ...ACTIONS.flatMap((a) => P.afterBeats(a, at('verify'))),
    ...P.afterBeats('score', at('decide', losing), { unhealthy: true }),
    ...P.outroBeats(),
    P.waitBeat(),
  ];
}

describe('the tour script', () => {
  test('the intro walks the dashboard: flow, steps, numbers, map, the Flagsmith column, the shop, then Flagsmith', () => {
    const fresh = P.introBeats(at('visitors'));
    assert.deepEqual(
      fresh.map((b: any) => b.id),
      ['intro:flow', 'intro:steps', 'intro:kpis', 'intro:track', 'intro:fs', 'intro:shop', 'intro:signin'],
    );
    assert.deepEqual(
      fresh.map((b: any) => b.target),
      ['#flowline', '#steps-panel', '#kpis', '#track-card', '#fs-panel', '#shop-frame', null],
    );
    assert.deepEqual(
      fresh.slice(0, 5).map((b: any) => b.demo),
      ['flow-sweep', 'steps-sweep', 'kpi-count', 'track-burst', 'fs-flash'],
    );
    assert.equal(fresh[5].tab, 'shop');
    assert.ok(fresh[6].signin);
  });

  test('mid-story the intro offers a fresh start, its button in the bubble', () => {
    const restart = P.introBeats(at('decide')).at(-1);
    assert.equal(restart.action, 'reset');
    assert.equal(restart.bubbleAction, 'Start from the beginning');
    assert.equal(restart.target, '#steps-panel', 'the spotlight shows how far the earlier run got');
    assert.notEqual(restart.demo, 'stage-pulse', "SHOW never pulses the stage's own button when the action is in the bubble");
    assert.match(restart.body, /part-way/);
    // Once the loop is complete the page's own Start over button is the one to click.
    const done = P.introBeats(at('reset')).at(-1);
    assert.equal(done.target, '[data-key="btn-reset"]');
    assert.equal(done.bubbleAction, undefined);
    assert.match(done.body, /complete/);
    assert.ok(restart.skippable);
  });

  test("each step's beat targets that step's button and demonstrates it", () => {
    for (const [current, action] of [['visitors', 'visitors'], ['score', 'score'], ['verify', 'verify'], ['preview', 'preview'], ['release', 'release']]) {
      const b = P.actionBeat(at(current!), 'ship');
      assert.equal(b.action, action, current);
      assert.equal(b.target, `[data-key="btn-${action}"]`);
      assert.equal(b.tab, 'story');
      assert.equal(b.demo, 'stage-pulse');
    }
    assert.equal(P.actionBeat(at('reset'), 'ship'), null, 'nothing to click once the story is complete');
  });

  test('decide follows Flagsmith: ship the winner, or revert on a losing guardrail', () => {
    assert.equal(P.actionBeat(at('decide'), 'ship').action, 'ship');
    assert.equal(P.actionBeat(at('decide'), 'revert').action, 'revert');
    const losing = at('decide', { results: { ...fixtures.v2Winner().results, losingGuardrails: [{ metric: 'doc_latency_ms', chanceToWin: 0.001, lift: 0.4 }] } });
    const b = P.actionBeat(losing, 'ship');
    assert.equal(b.action, 'revert', 'a losing guardrail overrides the recommendation');
    assert.match(b.body, /losing on doc_latency_ms/);
  });

  test('decide follows the recommendation: keep running when the interval crosses zero', () => {
    const results = { ...fixtures.v2Winner().results, recommendation: { call: 'keep-running', variant: 'v2', reason: 'interval −14% to +44% crosses zero', interval: { low: -0.14, high: 0.44 }, chanceToWin: 0.967 } };
    const b = P.actionBeat(at('decide', { results }), 'keep-running');
    assert.equal(b.action, 'keep-running');
    assert.equal(b.title, 'Keep running: the interval crosses zero');
    assert.match(b.body, /−14% to \+44% crosses zero/);
    assert.match(b.body, /isn't a win/);
  });

  test('after a job: show it here first, then the same data in the Flagsmith column, with the Flagsmith tab offered', () => {
    const s = at('decide');
    const score = P.afterBeats('score', s);
    assert.deepEqual(score.map((b: any) => [b.target, b.demo]), [['#stage-visual', 'results-grow'], ['#fs-results', 'fs-flash']]);
    assert.equal(score[1].flagsmith.url, s.links.experiment);

    const visitors = P.afterBeats('visitors', s);
    assert.deepEqual(visitors.map((b: any) => b.target), ['#track-card', '#fs-experiment']);
    assert.equal(visitors[1].flagsmith.url, s.links.experiment);

    const shipped = P.afterBeats('ship', at('verify'));
    assert.deepEqual(shipped.map((b: any) => b.target), ['#stage-visual', '#fs-flag', '#shop-frame']);
    assert.deepEqual(shipped.map((b: any) => b.tab), ['story', 'story', 'shop']);
    assert.equal(shipped[0].demo, 'diff-flash');
    assert.equal(shipped[1].flagsmith.url, s.links.flag);
    assert.equal(shipped[2].shop, 'reload');

    assert.deepEqual(P.afterBeats('reset', s).map((b: any) => b.id.split(':')[0]), ['reset-diff']);
    assert.equal(P.afterBeats('verify', s)[0].demo, 'verify-grow');

    const preview = P.afterBeats('preview', at('release'));
    assert.equal(preview[0].shop, 'preview');
    assert.equal(preview.at(-1).target, '#fs-flag');

    const release = P.afterBeats('release', at('visitors'));
    assert.equal(release.at(-1).target, '#fs-experiment');

    const health = P.afterBeats('score', at('decide', { results: { ...fixtures.v2Winner().results, losingGuardrails: [{ metric: 'x', chanceToWin: 0, lift: 1 }] } }), { unhealthy: true });
    const unhealthy = health.find((b: any) => /Unhealthy/.test(b.title));
    assert.ok(unhealthy);
    assert.equal(unhealthy.target, '#fs-flag');
    assert.equal(P.afterBeats('score', at('decide', { results: { ...fixtures.v2Winner().results, losingGuardrails: [{ metric: 'x', chanceToWin: 0, lift: 1 }] } })).length, 2, 'no Unhealthy beat unless Feature Health says so');
  });

  test('every Flagsmith link beat spotlights the matching card in the Flagsmith column first', () => {
    for (const b of everyBeat().filter((x: any) => x.flagsmith && x.id !== 'intro:signin')) {
      assert.match(b.target, /^#fs-(experiment|flag|results)$/, b.id);
      assert.equal(b.demo, 'fs-flash', b.id);
      assert.match(b.flagsmith.label, /Flagsmith/, b.id);
    }
  });

  test('the outro visits the feature map and the setup check, and ends', () => {
    assert.deepEqual(P.outroBeats().map((b: any) => b.tab), ['map', 'setup', 'story']);
    assert.ok(P.outroBeats().at(-1).last);
  });

  test('every beat names a tab and a target the page has, a known demo, and readable text', () => {
    const all = everyBeat();
    const ids = new Set<string>();
    for (const b of all) {
      assert.ok(P.TABS.includes(b.tab), `${b.id}: tab ${b.tab}`);
      assert.ok(validTarget(b.target), `${b.id}: target ${b.target}`);
      if (b.demo !== undefined) assert.ok(P.DEMOS.includes(b.demo), `${b.id}: demo ${b.demo}`);
      assert.ok(b.title && b.body, b.id);
      const r = P.readingMs(b);
      assert.ok(r >= 4500 && r <= 13000, `${b.id}: readingMs ${r}`);
      const sh = P.showMs(b);
      assert.ok(sh >= 1200 && sh <= 2200, `${b.id}: showMs ${sh}`);
      ids.add(b.id);
    }
    assert.ok(ids.size > 20);
  });

  test('the demo names are exactly the ones the page implements', () => {
    assert.deepEqual([...P.DEMOS].sort(), ['diff-flash', 'flow-sweep', 'fs-flash', 'kpi-count', 'results-grow', 'stage-pulse', 'steps-sweep', 'track-burst', 'verify-grow']);
  });

  test('readingMs grows with the text and stays within bounds', () => {
    assert.equal(P.readingMs({ title: 'Hi', body: '' }), 4500);
    assert.equal(P.readingMs({ title: 'x', body: 'word '.repeat(400) }), 13000);
    const short = P.readingMs({ title: 'a', body: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen' });
    const long = P.readingMs({ title: 'a', body: 'word '.repeat(30) });
    assert.ok(long > short);
  });

  test('"Step x of N": the estimate shrinks as the story moves on, and always counts the outro', () => {
    const fresh = P.remainingBeats(at('visitors'));
    const later = P.remainingBeats(at('verify'));
    const done = P.remainingBeats(at('reset'));
    assert.ok(fresh > later && later > done, `${fresh} > ${later} > ${done}`);
    assert.equal(done, P.outroBeats().length);
    assert.equal(P.remainingBeats(null), P.outroBeats().length);
    const lastRound = P.remainingBeats(at('visitors', { next: null }));
    assert.ok(lastRound < fresh, 'no next release: no further round');
  });

  test('the dashboard has every element the tour points at', () => {
    const html = readFileSync(join(UI, 'judge.html'), 'utf8');
    const ids = new Set(everyBeat().map((b: any) => b.target).filter((t: any) => typeof t === 'string' && t.startsWith('#')));
    for (const id of ids) assert.match(html, new RegExp(`id="${id.slice(1)}"`), `judge.html lacks ${id}`);
  });

  test('the flow line lights the phase of each step', () => {
    assert.equal(P.phaseOf('visitors'), 'split');
    assert.equal(P.phaseOf('score'), 'measure');
    assert.equal(P.phaseOf('decide'), 'decide');
    assert.equal(P.phaseOf('verify'), 'everyone');
    assert.equal(P.phaseOf('release'), 'deploy');
    assert.equal(P.phaseOf('reset'), 'everyone', 'the finished loop sits at the last stage, not back at Deploy');
  });

  test('an inconclusive lead is never called a winner', () => {
    const s = at('decide', { results: { ...fixtures.v2Winner().results, winner: { key: 'v2', release: 'shop:1.5', chanceToWin: 0.933 } } });
    const b = P.actionBeat(s, 'ship');
    assert.equal(b.action, 'ship');
    assert.doesNotMatch(`${b.title} ${b.body}`, /winner|winning/i);
    assert.match(b.title, /below its 95% bar/);
    assert.match(b.body, /93\.3%/);
    assert.match(b.body, /inconclusive/);
    assert.match(P.actionBeat(at('decide'), 'ship').title, /^Ship the winner/, '96.7% is above the bar');
  });

  test('the closing beat tells what this tour actually decided', () => {
    const won = P.decisionNote('ship', at('decide'));
    assert.match(won, /shop:1\.5 shipped on Flagsmith's verdict \(96\.7% chance to win\)/);
    const pick = P.decisionNote('ship', at('decide', { results: { ...fixtures.v2Winner().results, winner: { key: 'v2', release: 'shop:1.5', chanceToWin: 0.9 } } }));
    assert.match(pick, /shipped as Flagsmith's pick \(90\.0%, below its 95% bar\)/);
    const lost = P.decisionNote('revert', at('decide', { results: { ...fixtures.v2Winner().results, losingGuardrails: [{ metric: 'doc_latency_ms', chanceToWin: 0, lift: 1 }] } }));
    assert.match(lost, /reverted when doc_latency_ms lost/);
    assert.equal(P.decisionNote('visitors', at('visitors')), '');
    const end = P.outroBeats([pick, lost]).at(-1);
    assert.match(end.body, /^Two releases: .*below its 95% bar.*; then .*reverted/);
    assert.doesNotMatch(P.outroBeats().at(-1).body, /Two releases/, 'no claim without decisions to back it');
  });

  test('the bubble reads by chapter, not by a beat count', () => {
    assert.equal(P.chapter({ id: 'intro:flow' }), 'Overview');
    assert.equal(P.chapter({ id: 'intro:restart' }), 'Fresh start');
    assert.equal(P.chapter({ id: 'results-fs:12' }), 'Results');
    assert.equal(P.chapter({ id: 'health:12' }), 'Results');
    assert.equal(P.chapter({ id: 'decide:12' }), 'Decision');
    assert.equal(P.chapter({ id: 'outro:end' }), 'Wrap-up');
    assert.equal(P.chapter(null), 'Tour');
    for (const b of everyBeat()) assert.notEqual(P.chapter(b), 'Tour', b.id);
  });
});
