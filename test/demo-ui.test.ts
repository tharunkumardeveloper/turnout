import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The simple judge page (/judge): demo.html, demo.js, demo.css, and its wording and rules in demo-model.js.
const UI = fileURLToPath(new URL('../src/console/ui/', import.meta.url));
const read = (name: string) => readFileSync(join(UI, name), 'utf8');
const html = read('demo.html');
const js = read('demo.js');
const css = read('demo.css');
const M: any = await import(pathToFileURL(join(UI, 'demo-model.js')).href);

// A metric as the judge state carries it: means per arm, Flagsmith's inference per new version.
const metric = (name: string, role: string, aggregation: string, direction: string, means: Record<string, number>, byArm: Record<string, [string, number]>) => ({
  name,
  role,
  aggregation,
  direction,
  arms: Object.fromEntries(Object.entries(means).map(([k, mean]) => [k, { n: 700, mean }])),
  v2: byArm.v2 ? { lift: 0, chanceToWin: byArm.v2[1], ciLow: 0, ciHigh: 0 } : null,
  verdict: byArm.v2?.[0] ?? 'no-events',
  byArm: Object.fromEntries(Object.entries(byArm).map(([k, [verdict, chanceToWin]]) => [k, { lift: 0, chanceToWin, ciLow: 0, ciHigh: 0, verdict }])),
});
const steps = (visitors: string, score: string, decide: string, verify = 'todo') => [
  { id: 'visitors', status: visitors },
  { id: 'score', status: score },
  { id: 'decide', status: decide },
  { id: 'verify', status: verify },
];
const ARMS = [{ key: 'control', release: 'shop:1.4' }, { key: 'v2', release: 'shop:1.5' }, { key: 'v3', release: 'shop:1.6' }];
const base = (over: any = {}) => ({
  releases: ['shop:1.4', 'shop:1.5', 'shop:1.6'],
  live: 'shop:1.4',
  next: null,
  links: { shop: 'http://127.0.0.1:8080', experiment: null },
  experiment: { id: 7, status: 'running', control: 'shop:1.4', v2: 'shop:1.5', arms: ARMS },
  results: null,
  steps: steps('current', 'todo', 'todo'),
  routing: { defaultRelease: 'shop:1.4', experiment: { id: 7, enrolledPct: 100, arms: [{ key: 'control', release: 'shop:1.4', pct: 34 }, { key: 'v2', release: 'shop:1.5', pct: 33 }, { key: 'v3', release: 'shop:1.6', pct: 33 }] } },
  ledger: [],
  totals: { visitorsSent: 0 },
  ...over,
});
// B wins on orders and is safe; C sells more too but its pages are slow: ship B.
const abcResults = {
  asOf: '2026-11-24T10:00:00Z',
  refreshAllowedAt: null,
  metrics: [
    metric('order_placed', 'goal', 'occurrence', 'up', { control: 0.1, v2: 0.2, v3: 0.22 }, { v2: ['winning', 0.999], v3: ['winning', 1] }),
    metric('doc_latency_ms', 'guardrail', 'mean', 'down', { control: 55, v2: 56, v3: 150 }, { v2: ['inconclusive', 0.4], v3: ['losing', 0] }),
    metric('server_error', 'guardrail', 'mean', 'down', { control: 0, v2: 0, v3: 0 }, {}),
  ],
  losingGuardrails: [{ metric: 'doc_latency_ms', chanceToWin: 0, lift: 1.7 }],
  losingByArm: { v2: [], v3: [{ metric: 'doc_latency_ms', chanceToWin: 0, lift: 1.7 }] },
  recommendation: { call: 'ship', variant: 'v2', chanceToWin: 0.999, reason: 'clears zero', interval: { low: 0.5, high: 1.5 } },
};

describe('demo-model.js: what the simple judge page says', () => {
  test('names releases, metrics and the versions (A is what everyone gets now)', () => {
    assert.equal(M.label('shop:1.5'), '1.5 Express');
    assert.equal(M.label('app:2.0'), '2.0');
    assert.equal(M.metricName('doc_latency_ms'), 'Page load time');
    assert.equal(M.metricName('signup_done'), 'Signup done');
    assert.deepEqual(M.arms(base()).map((a: any) => a.name), ['A · 1.4 Classic', 'B · 1.5 Express', 'C · 1.6 Bold']);
    // An A/B test from before arms existed: control and v2.
    const ab = base({ experiment: { id: 3, status: 'running', control: 'shop:1.4', v2: 'shop:1.5' } });
    assert.deepEqual(M.arms(ab).map((a: any) => a.name), ['A · 1.4 Classic', 'B · 1.5 Express']);
  });

  test('four fixed steps whose titles never change, whatever the state', () => {
    const titles = (s: any) => M.model(s).steps.map((x: any) => x.title);
    const expected = ['Start the test', 'Send shoppers', 'Ask Flagsmith', 'Decide'];
    assert.deepEqual(titles(base()), expected);
    assert.deepEqual(titles(base({ results: abcResults, steps: steps('done', 'done', 'current') })), expected);
    assert.deepEqual(titles(base({ experiment: { ...base().experiment, status: 'completed' }, live: 'shop:1.5' })), expected);
    assert.deepEqual(titles(base({ experiment: null })), expected);
  });

  test('a running A/B/C test: who gets what, and one green button per step', () => {
    let m = M.model(base());
    assert.equal(m.now, 'Flagsmith is testing B · 1.5 Express and C · 1.6 Bold against A · 1.4 Classic. Each new shopper gets one of them.');
    assert.deepEqual(m.versions.map((v: any) => v.badge), ['34% of shoppers', '33% of shoppers', '33% of shoppers']);
    assert.deepEqual(m.steps.map((x: any) => x.status), ['done', 'current', 'todo', 'todo']);
    assert.equal(m.steps[0].result, 'A/B/C test, experiment #7 in Flagsmith.');
    assert.equal(m.action.action, 'visitors');
    assert.equal(m.action.label, 'Send 2,100 shoppers');
    assert.match(m.action.explain, /Flagsmith picks A, B or C for each one/);

    m = M.model(base({ steps: steps('done', 'current', 'todo'), totals: { visitorsSent: 2100 } }));
    assert.equal(m.action.action, 'score');
    assert.equal(m.steps[1].result, '2,100 shoppers went through Turnout.');
  });

  test('B wins and C fails a safety check: ship B, and say why C is out', () => {
    const m = M.model(base({ steps: steps('done', 'done', 'current'), results: abcResults }));
    assert.equal(m.steps[1].result, 'Flagsmith counted 2,100 shoppers.');
    assert.equal(m.action.action, 'ship');
    assert.equal(m.action.label, 'Ship B · 1.5 Express to everyone');
    assert.deepEqual(m.alt, { action: 'revert', label: 'Keep A · 1.4 Classic instead' });
    assert.equal(m.verdict.title, 'B · 1.5 Express wins');
    assert.equal(
      m.verdict.text,
      'B · 1.5 Express gets more orders than A (20.0% vs 10.0%), Flagsmith is 100% sure, and every safety check is fine. ' +
        "C · 1.6 Bold sold more too, but its pages load 2.7× slower (150 ms vs 55 ms), so it's out.",
    );
  });

  test('the results table: a column per version, Flagsmith’s call on each new one against A', () => {
    const rows = M.findings(base({ results: abcResults }));
    assert.deepEqual(rows.map((r: any) => [r.name, r.roleText]), [['Orders', 'Goal'], ['Page load time', 'Safety check'], ['Server errors', 'Safety check']]);
    assert.deepEqual(rows[0].cells.map((c: any) => [c.value, c.word, c.note]), [
      ['10.0%', '', ''],
      ['20.0%', 'Better', '100% sure it beats A'],
      ['22.0%', 'Better', '100% sure it beats A'],
    ]);
    assert.deepEqual(rows[1].cells.map((c: any) => [c.value, c.word, c.tone, c.note]), [
      ['55 ms', '', 'base', ''],
      ['56 ms', 'No clear difference', 'neutral', ''],
      ['150 ms', 'Worse', 'bad', '2.7× slower'],
    ]);
    assert.deepEqual(rows[2].cells.map((c: any) => c.word), ['', 'None', 'None']);
  });

  test("a safety check Flagsmith calls losing but within Turnout's margin is never shown as a failure", () => {
    // B is 2 ms slower and Flagsmith is sure of it, but that is under the 20 ms floor: B still ships, so no red.
    const results = {
      ...abcResults,
      metrics: [abcResults.metrics[0], metric('doc_latency_ms', 'guardrail', 'mean', 'down', { control: 57, v2: 59, v3: 152 }, { v2: ['losing', 0.01], v3: ['losing', 0] }), abcResults.metrics[2]],
    };
    const rows = M.findings(base({ results }));
    assert.deepEqual(rows[1].cells.map((c: any) => [c.word, c.tone, c.note]), [
      ['', 'base', ''],
      ['Slightly worse', 'neutral', 'within the safety margin'],
      ['Worse', 'bad', '2.7× slower'],
    ]);
    assert.match(M.verdict(base({ results })).text, /every safety check is fine/);
  });

  test('an also-watched metric that got worse for the winner is said, and still never blocks', () => {
    const results = { ...abcResults, metrics: [...abcResults.metrics, metric('add_to_cart', 'secondary', 'occurrence', 'up', { control: 0.32, v2: 0.28, v3: 0.31 }, { v2: ['losing', 0.04], v3: ['inconclusive', 0.4] })] };
    const v = M.verdict(base({ results }));
    assert.equal(v.call, 'ship');
    assert.match(v.text, /Worth knowing: B · 1\.5 Express did worse on add to cart, which is watched but doesn't decide\./);
  });

  test('every new version failing: roll back to A', () => {
    const results = {
      ...abcResults,
      metrics: [abcResults.metrics[0], metric('doc_latency_ms', 'guardrail', 'mean', 'down', { control: 55, v2: 120, v3: 150 }, { v2: ['losing', 0], v3: ['losing', 0] })],
      losingByArm: { v2: [{ metric: 'doc_latency_ms', chanceToWin: 0, lift: 1.2 }], v3: [{ metric: 'doc_latency_ms', chanceToWin: 0, lift: 1.7 }] },
      recommendation: { call: 'revert', variant: 'v3', chanceToWin: 1, reason: 'r', interval: null },
    };
    const m = M.model(base({ steps: steps('done', 'done', 'current'), results }));
    assert.equal(m.action.action, 'revert');
    assert.equal(m.action.label, 'Roll back to A · 1.4 Classic');
    assert.equal(m.verdict.title, 'A safety check failed');
    assert.match(m.verdict.text, /B · 1\.5 Express sold more too, but its pages load 2\.2× slower .*C · 1\.6 Bold sold more too.* Keep everyone on A · 1\.4 Classic\.$/);
  });

  test('not sure yet: the reason is the one Flagsmith gave, never "only 96% sure… at 95%"', () => {
    const under = { ...abcResults, recommendation: { call: 'keep-running', variant: 'v2', chanceToWin: 0.7, reason: 'under 95%' } };
    let m = M.model(base({ steps: steps('done', 'done', 'current'), results: under }));
    assert.equal(m.verdict.title, 'Not sure yet');
    assert.match(m.verdict.text, /only 70% sure B · 1\.5 Express beats A; it calls a winner at 95%/);
    assert.equal(m.action.action, 'keep-running');
    assert.equal(m.alt.action, 'revert');
    const crosses = { ...abcResults, recommendation: { call: 'keep-running', variant: 'v2', chanceToWin: 0.96, reason: 'interval crosses zero' } };
    m = M.model(base({ steps: steps('done', 'done', 'current'), results: crosses }));
    assert.match(m.verdict.text, /96% sure B · 1\.5 Express beats A, but its likely range still includes no gain at all/);
  });

  test("Flagsmith's refresh limit: the button carries the time it opens again", () => {
    const now = Date.parse('2026-11-24T10:00:00Z');
    const results = { ...abcResults, refreshAllowedAt: '2026-11-24T10:03:00Z' };
    assert.equal(M.model(base({ steps: steps('done', 'current', 'todo'), results }), { now }).action.waitUntil, '2026-11-24T10:03:00Z');
  });

  test('a finished test reads as a finished story, with a new A/B/C test as the only button', () => {
    const ledger = [{ experimentId: 7, decision: 'shipped', release: 'shop:1.5', replaced: 'shop:1.4', experiment: 'shop_release: shop:1.5 vs shop:1.6 vs shop:1.4', at: '2026-11-24T10:05:00Z' }];
    const m = M.model(base({ experiment: { ...base().experiment, status: 'completed' }, live: 'shop:1.5', results: abcResults, ledger }));
    assert.equal(m.finished, true);
    assert.equal(m.now, 'Everyone gets B · 1.5 Express. No test is running.');
    assert.deepEqual(m.steps.map((x: any) => x.status), ['done', 'done', 'done', 'done']);
    assert.equal(m.steps[3].result, 'Shipped B · 1.5 Express to everyone.');
    assert.equal(m.outcome.title, 'B · 1.5 Express shipped to everyone');
    assert.deepEqual(m.versions.map((v: any) => [v.badge, v.state]), [['Replaced', 'out'], ['Shipped', 'winner'], ['Not shipped', 'out']]);
    assert.deepEqual([m.action.action, m.action.arms, m.action.label], ['start', 3, 'Run an A/B/C test']);
    assert.equal(M.model(base({ experiment: { ...base().experiment, status: 'completed' }, live: 'shop:1.5', results: abcResults, ledger }), { kind: 1 }).action.label, 'Run an A/A test');

    const reverted = M.model(base({ experiment: { ...base().experiment, status: 'completed' }, live: 'shop:1.4', results: abcResults, ledger: [{ ...ledger[0], decision: 'reverted', release: 'shop:1.4' }] }));
    assert.equal(reverted.outcome.title, 'Everyone stays on A · 1.4 Classic');
    assert.deepEqual(reverted.versions.map((v: any) => v.badge), ['Kept', 'Rolled back', 'Rolled back']);
  });

  test('no experiment yet: start the kind picked, an A/B/C test by default (A/B with only two releases)', () => {
    const m = M.model(base({ experiment: null }));
    assert.deepEqual([m.action.action, m.action.arms, m.action.label], ['start', 3, 'Start an A/B/C test']);
    assert.equal(m.steps[0].status, 'current');
    assert.deepEqual(M.model(base({ experiment: null, releases: ['shop:1.4', 'shop:1.5'] })).action.label, 'Start an A/B test');
    const ab = M.model(base({ experiment: null }), { kind: 2 }).action;
    assert.equal(ab.label, 'Start an A/B test');
    assert.match(ab.explain, /Flagsmith shows B · 1\.5 Express to half the shoppers\.$/);
    assert.match(M.model(base({ experiment: null }), { kind: 1 }).action.explain, /two identical copies of it\. It should find no difference\./);
  });

  test('the kinds of test: A/A, then A/B, A/B/C… up to the number of releases', () => {
    assert.deepEqual(M.kinds(['a', 'b', 'c']).map((k: any) => [k.arms, k.label]), [[1, 'A/A'], [2, 'A/B'], [3, 'A/B/C']]);
    assert.deepEqual(M.kinds(['a', 'b', 'c', 'd', 'e']).map((k: any) => k.label).at(-1), 'A/B/C/D/E');
    assert.deepEqual(M.kinds(['a']), []);
    assert.equal(M.kindOf(base()), 3);
    assert.equal(M.kindOf(base({ experiment: null })), null);
    assert.equal(M.shoppersFor(2), 1400);
    assert.equal(M.shoppersFor(3), 2100);
    assert.equal(M.shoppersFor(9), 5000);
  });

  test('an A/A test: the copy is A′, no difference is the expected answer, and finishing changes nothing', () => {
    const aaArms = [{ key: 'control', release: 'shop:1.4' }, { key: 'v2', release: 'shop:1.4' }];
    const aa = (over: any = {}) => base({ experiment: { id: 9, status: 'running', control: 'shop:1.4', v2: 'shop:1.4', arms: aaArms }, routing: null, ...over });
    assert.equal(M.kindOf(aa()), 1);
    assert.deepEqual(M.arms(aa()).map((a: any) => a.name), ['A · 1.4 Classic', 'A′ · 1.4 Classic']);
    let m = M.model(aa());
    assert.equal(m.now, 'An A/A test: both sides get A · 1.4 Classic. Flagsmith counts each new shopper on one side.');
    assert.equal(m.steps[0].result, 'A/A test, experiment #9 in Flagsmith.');
    assert.equal(m.action.label, 'Send 1,400 shoppers');
    const same = {
      ...abcResults,
      metrics: [metric('order_placed', 'goal', 'occurrence', 'up', { control: 0.098, v2: 0.097 }, { v2: ['inconclusive', 0.47] })],
      losingByArm: { v2: [] },
      recommendation: { call: 'keep-running', variant: 'v2', chanceToWin: 0.47, reason: 'crosses zero', interval: { low: -0.2, high: 0.2 } },
    };
    m = M.model(aa({ steps: steps('done', 'done', 'current'), results: same }));
    assert.equal(m.verdict.title, 'No difference, as expected');
    assert.match(m.verdict.text, /the split and the counting are fair/);
    assert.deepEqual([m.action.action, m.action.label, m.alt], ['revert', 'Finish the A/A check', null]);
    const differs = { ...same, recommendation: { ...same.recommendation, call: 'ship', chanceToWin: 0.99 } };
    assert.equal(M.model(aa({ steps: steps('done', 'done', 'current'), results: differs })).verdict.title, 'A difference between identical copies');
    const ledger = [{ experimentId: 9, decision: 'reverted', release: 'shop:1.4', replaced: 'shop:1.4', experiment: 'shop_release: A/A shop:1.4', at: 'x' }];
    m = M.model(aa({ experiment: { id: 9, status: 'completed', control: 'shop:1.4', v2: 'shop:1.4', arms: aaArms }, results: same, ledger }));
    assert.equal(m.outcome.title, 'A/A check finished');
    assert.equal(m.steps[3].result, 'A/A check finished: everyone stays on A.');
    assert.deepEqual(m.versions.map((v: any) => v.badge), ['Kept', 'Copy']);
    assert.equal(M.history(ledger)[0].text, 'A/A check on 1.4 Classic finished');
  });

  test('jobs, before → after, the check and the history in one line each', () => {
    assert.deepEqual(M.jobView({ action: 'visitors', status: 'running', progress: { done: 300, total: 2100 }, stages: [] }), {
      action: 'visitors', running: true, failed: false, title: 'Sending shoppers', detail: '300 of 2,100 shoppers', fraction: 300 / 2100,
    });
    const before = { defaultRelease: 'shop:1.4', experiment: { id: 9, enrolledPct: 100, arms: [{ key: 'control', release: 'shop:1.4', pct: 34 }, { key: 'v2', release: 'shop:1.5', pct: 33 }, { key: 'v3', release: 'shop:1.6', pct: 33 }] } };
    const after = { defaultRelease: 'shop:1.5', experiment: null };
    assert.deepEqual(M.changes({ action: 'ship', changes: { before, after } }), {
      before: '34% 1.4 Classic, 33% 1.5 Express, 33% 1.6 Bold (experiment #9)',
      after: 'everyone: 1.5 Express',
    });
    assert.deepEqual(M.verifyText({ action: 'verify', status: 'done', result: { byRelease: { 'shop:1.5': 50 }, expected: 'shop:1.5', leftovers: 0 } }), {
      ok: true,
      text: '50 of 50 brand-new shoppers got 1.5 Express; no test split is left on the flag.',
    });
    assert.equal(M.verifyText({ action: 'verify', status: 'done', result: { byRelease: { 'shop:1.5': 16, 'shop:1.6': 34 }, expected: 'shop:1.5', leftovers: 0 } }).ok, false);
    assert.deepEqual(
      M.history([
        { decision: 'shipped', release: 'shop:1.5', replaced: 'shop:1.4', experiment: 'shop_release: shop:1.5 vs shop:1.4', at: 'a' },
        { decision: 'kept-running', release: null, experiment: 'x', at: 'b' },
        { decision: 'reverted', release: 'shop:1.4', replaced: 'shop:1.4', experiment: 'shop_release: shop:1.5 vs shop:1.6 vs shop:1.4', at: 'c' },
      ]).map((r: any) => r.text),
      ['1.5 Express and 1.6 Bold rolled back, 1.4 Classic kept', '1.5 Express shipped (replaced 1.4 Classic)'],
    );
  });
});

describe('demo-model.js: the picker, you, and the autopilot', () => {
  test('a picked kind shows its versions at once, before Flagsmith confirms the test', () => {
    const rel = ['shop:1.4', 'shop:1.5', 'shop:1.6'];
    assert.deepEqual(M.plannedVersions(rel, 1).map((v: any) => v.name), ['A · 1.4 Classic', 'A′ · 1.4 Classic']);
    assert.deepEqual(M.plannedVersions(rel, 2).map((v: any) => v.name), ['A · 1.4 Classic', 'B · 1.5 Express']);
    assert.deepEqual(M.plannedVersions(rel, 3).map((v: any) => [v.key, v.badge]), [['control', 'Starting…'], ['v2', 'Starting…'], ['v3', 'Starting…']]);
  });

  test('where you land, in one line', () => {
    const s = base();
    assert.equal(M.youText(null, s), '');
    assert.match(M.youText({ visited: false }, s), /not in the shop yet/);
    const r = { at: 1, event: 'doc_latency_ms', status: 'accepted', httpStatus: 202 };
    assert.equal(M.youText({ visited: true, variant: 'v3', release: 'shop:1.6', enrolled: true, receipt: r }, s), 'You got C · 1.6 Bold: Flagsmith counts you in this test.');
    assert.equal(M.youText({ visited: true, variant: 'v3', release: 'shop:1.6', enrolled: true, receipt: null }, s), "You'll get C · 1.6 Bold when you open the shop, and count in this test.", 'a cookie without a page load is not counted yet');
    assert.equal(M.youText({ visited: true, variant: 'control', release: 'shop:1.4', enrolled: false }, s), 'You got 1.4 Classic, outside the test (not counted).');
    assert.equal(M.youText({ viewing: true, release: 'shop:1.5' }, s), "You're looking at 1.5 Express on its own (not counted).");
    assert.equal(M.youText({ visited: true, variant: 'v2', release: 'shop:1.5', enrolled: true, receipt: r }, s, true), 'You got 1.5 Express: Flagsmith counts you in the live test for real visitors.');
    assert.equal(M.youText({ visited: true, variant: 'v2', release: 'shop:1.5', enrolled: true, receipt: null }, s, true), "You'll get 1.5 Express when you open the shop.");
  });

  test("server mode: the autopilot's next step in place of a button", () => {
    const now = Date.parse('2026-11-24T10:00:00Z');
    assert.equal(M.autopilotLine({ autopilot: { phase: 'waiting', next: { title: 'Send simulated visitors', at: '2026-11-24T10:00:05Z' } } }, now), 'Running by itself. Next: send simulated visitors, in 5 s.');
    assert.match(M.autopilotLine({ job: { status: 'running', action: 'score' } }), /^Running by itself: flagsmith is computing the results…$/);
    assert.match(M.autopilotLine({ autopilot: { phase: 'paused' } }), /Paused while someone uses the console/);
  });
});

const STOPS: any = await import(pathToFileURL(join(UI, 'tour-stops.js')).href);
const consoleHtml = read('index.html');

describe('the tour: one engine (tour.js), a list of stops per page (tour-stops.js)', () => {
  test('every stop points at something its page has, and reads in a few seconds', () => {
    for (const [stops, page, name] of [[STOPS.JUDGE_STOPS, html, 'demo.html'], [STOPS.CONSOLE_STOPS, consoleHtml, 'index.html']] as const) {
      for (const s of stops) {
        for (const sel of [s.target].flat().filter(Boolean)) {
          const id = sel.match(/^#([\w-]+)/)![1];
          const attr = sel.match(/\[([\w-]+="[^"]+")\]/)?.[1];
          assert.ok(id === 'go' || page.includes(`id="${id}"`), `the tour points at ${sel}, which ${name} lacks`);
          if (attr) assert.ok(page.includes(attr), `the tour points at ${sel}, which ${name} lacks`);
        }
        const text = typeof s.text === 'function' ? s.text() : s.text;
        assert.ok(text.split(/\s+/).length <= 60, `${s.title}: ${text.split(/\s+/).length} words`);
      }
    }
  });

  test("guided demo's tour walks one test by clicks: pick a kind, start, send shoppers, ask Flagsmith, decide, then Flagsmith and you", () => {
    const clicks = STOPS.JUDGE_STOPS.filter((s: any) => s.click).map((s: any) => s.title);
    assert.deepEqual(clicks, ['Pick the kind of test', 'Start the test', 'Send shoppers', 'Ask Flagsmith', 'Decide', 'Look inside Flagsmith', 'Be a visitor yourself']);
    const actions = STOPS.JUDGE_STOPS.filter((s: any) => s.action).map((s: any) => [s.action].flat().join('|'));
    assert.deepEqual(actions, ['start', 'visitors', 'score', 'ship|revert|keep-running'], 'each follows the green button of its step');
    const pick = STOPS.JUDGE_STOPS.find((s: any) => s.target === '#kinds');
    assert.match(pick.text, /Nothing starts yet: first you see what it will compare/);
    assert.match(js, /data-action': a\.action/, 'the green button names its action for the tour');
  });

  test('server mode: no buttons it lacks (test picker, steps, Play it for me, console); the tabs and Be a visitor stay clickable', () => {
    const pub = STOPS.stopsFor(STOPS.JUDGE_STOPS, true);
    assert.ok(!pub.some((s: any) => s.action || (s.click && !['#tab-flagsmith', '#be-visitor'].includes(s.click))), 'only what the public page has');
    assert.ok(!pub.some((s: any) => s.target === '#autoplay' || String(s.target).includes('console')));
    assert.equal(STOPS.stopsFor(STOPS.JUDGE_STOPS, false).length, STOPS.JUDGE_STOPS.length);
    assert.match(pub.find((s: any) => s.target === '#tab-flagsmith').text, /dashboard stays private/);
  });

  test('the engine: opens once per page, from the Tour button any time; → next, ← back, Esc closes; a click stop moves on when you click', () => {
    const tour = read('tour.js');
    assert.match(tour, /e\.key === 'ArrowRight'/);
    assert.match(tour, /e\.key === 'ArrowLeft'/);
    assert.match(tour, /e\.key === 'Escape'/);
    assert.match(tour, /if \(e\.target\.closest\(stop\.click\)\) setTimeout/);
    assert.match(tour, /Click the highlighted button/);
    assert.doesNotMatch(tour, /innerHTML|outerHTML|insertAdjacentHTML/);
    assert.match(js, /createTour\(\{ stops: stopsFor\(JUDGE_STOPS, READONLY\), seenKey:/);
    assert.match(read('app.js'), /createTour\(\{ stops: stopsFor\(CONSOLE_STOPS, READONLY\), seenKey: READONLY \? 'turnout-tour-public-console-seen' : 'turnout-tour-console-seen' \}\)/);
    assert.match(html, /<link rel="stylesheet" href="\/tour\.css">/);
    assert.match(consoleHtml, /<link rel="stylesheet" href="\/tour\.css">/);
  });
});

describe('a picked test, in Flagsmith, and your visits (demo-model.js)', () => {
  test('picking a kind previews it: its versions, step 1 with Start, and the running test kept until then', () => {
    const p = M.planModel(base(), 2);
    assert.equal(p.plan, true);
    assert.deepEqual(p.versions.map((v: any) => [v.letter, v.release, v.badge]), [['A', 'shop:1.4', 'Preview'], ['B', 'shop:1.5', 'Preview']]);
    assert.deepEqual(p.steps.map((x: any) => x.status), ['current', 'todo', 'todo', 'todo']);
    assert.equal(p.action.action, 'start');
    assert.equal(p.action.arms, 2);
    assert.match(p.action.explain, /The running A\/B\/C test #7 stops first\./);
    assert.deepEqual(p.alt, { action: 'cancel-plan', label: 'Keep test #7' });
    assert.match(p.now, /^Preview of an A\/B test: B · 1\.5 Express against A · 1\.4 Classic\. Nothing has changed yet\.$/);
    const aa = M.planModel(base(), 1);
    assert.deepEqual(aa.versions.map((v: any) => v.letter), ['A', 'A′']);
    assert.equal(aa.letters, 'A/A');
  });

  test('in Flagsmith: the route with your arm marked, the flag, the variants and the experiment', () => {
    const s = base({ flag: 'shop_release', variants: [{ key: 'v2', release: 'shop:1.5' }, { key: 'v3', release: 'shop:1.6' }], results: abcResults });
    const f = M.flagsmithModel(s, { visited: true, variant: 'v3', release: 'shop:1.6', enrolled: true });
    assert.equal(f.flag, 'shop_release');
    assert.deepEqual(f.route.map((r: any) => [r.letter, r.pct, r.you]), [['A', 34, false], ['B', 33, false], ['C', 33, true]]);
    assert.deepEqual(f.variants.map((v: any) => `${v.key}=${v.value}`), ['control=shop:1.4', 'v2=shop:1.5', 'v3=shop:1.6']);
    assert.equal(f.experiment.kind, 'A/B/C');
    assert.deepEqual(f.experiment.metrics.map((m: any) => m.role), ['Goal', 'Safety check', 'Safety check']);
    const done = M.flagsmithModel(base({ experiment: { id: 7, status: 'completed', control: 'shop:1.4', v2: 'shop:1.5', arms: ARMS }, live: 'shop:1.5' }), { visited: true, release: 'shop:1.5' });
    assert.deepEqual(done.route.map((r: any) => [r.name, r.pct, r.you]), [['1.5 Express', 100, true]], 'after the test: everyone, you included');
  });

  test('your visits: what this browser got before the test, in it, and after the decision; a repeat adds nothing', () => {
    const before = M.visitOf({ visited: true, release: 'shop:1.4', enrolled: false }, base({ experiment: null }));
    assert.match(before.where, /everyone's version/);
    const during = M.visitOf({ visited: true, variant: 'v2', release: 'shop:1.5', enrolled: true }, base());
    assert.equal(during.where, 'in A/B/C test #7 as B');
    let j = M.addVisit([], before, 't1');
    j = M.addVisit(j, during, 't2');
    assert.equal(M.addVisit(j, during, 't3'), j, 'the same place twice is one entry');
    assert.deepEqual(j.map((x: any) => x.name), ['1.4 Classic', '1.5 Express']);
    assert.equal(M.visitOf({ viewing: true, release: 'shop:1.6' }, base()), null, 'looking at a version on its own is not a visit');
  });
});

describe('demo.html and demo.js', () => {
  test('one desktop screen with no page scroll: the bar, the steps, the versions and the results', () => {
    assert.match(css, /body \{[^}]*overflow: hidden;/);
    assert.match(css, /grid-template-areas: "steps versions" "steps results";/);
    for (const id of ['steps', 'versions', 'results', 'autoplay', 'history', 'kinds', 'tour-open', 'tab-results', 'tab-flagsmith', 'flagsmith-tab', 'be-visitor']) assert.ok(html.includes(`id="${id}"`), id);
  });

  test('one stylesheet and one module script; a page in the console look, light and dark', () => {
    assert.match(html, /<link rel="stylesheet" href="\/demo\.css">/);
    assert.match(html, /<script type="module" src="\/demo\.js"><\/script>/);
    assert.match(html, /<meta name="turnout-console" content="">/);
    assert.match(css, /@media \(prefers-color-scheme: dark\)/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  });

  test('every element demo.js looks up by id exists in demo.html', () => {
    const used = [...js.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]!);
    assert.ok(used.length > 8);
    for (const id of new Set(used)) assert.ok(html.includes(`id="${id}"`), `demo.js uses #${id}, which demo.html lacks`);
  });

  test('every API call carries the token; POSTs are JSON and name the experiment the page shows', () => {
    assert.doesNotMatch(js, /(?<![\w.])fetch\('\/api/);
    assert.match(js, /\[TOKEN_HEADER\]: TOKEN/);
    assert.match(js, /method: 'POST', headers: \{ 'content-type': 'application\/json' \}/);
    assert.match(js, /experimentId: s\.experiment\.id/);
    assert.match(js, /new EventSource\(`\$\{BASE\}\/api\/traffic\?token=\$\{encodeURIComponent\(TOKEN\)\}`\)/);
  });

  test('a click can only be sent once, and the buttons wait for the state to show a finished job', () => {
    assert.match(js, /if \(ui\.sending\) return;/);
    assert.match(js, /ui\.settle = \{ sig: ui\.before \?\? signature\(ui\.state\)/);
    assert.match(js, /'Reading Flagsmith…'/);
  });

  test('after Ship or Revert, the page checks brand-new shoppers get the decision', () => {
    assert.match(js, /job\.action === 'ship' \|\| job\.action === 'revert'[\s\S]{0,200}await run\('verify'\)/);
  });
});

describe('blind rounds on the judge page (server mode)', () => {
  test('hidden while a round runs; revealed next to Flagsmith’s call after it; a scoreboard throughout; nothing when off', () => {
    assert.equal(M.blindView(base()), null);
    assert.equal(M.blindView(base({ blind: { enabled: false } })), null);
    const score = { rounds: 4, right: 3, wrong: 0, noCall: 1 };
    const hidden = M.blindView(base({ blind: { enabled: true, round: { hidden: true }, score } }));
    assert.equal(hidden.title, 'Blind round');
    assert.match(hidden.text, /stay hidden until the decision/);
    assert.match(hidden.score, /right in 3 of 4 blind rounds \(1 where it wasn't sure yet\)/);
    const shown = M.blindView(base({ blind: { enabled: true, round: { hidden: false, truth: 'shop:1.5 better on orders (16% vs 10%)', round: { outcome: 'right' } }, score } }));
    assert.equal(shown.title, 'Revealed: Flagsmith got it right');
    assert.equal(shown.tone, 'good');
    assert.match(shown.text, /^The truth: shop:1\.5 better on orders/);
  });
});
