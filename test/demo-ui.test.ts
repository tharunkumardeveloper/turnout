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
    assert.equal(m.action.action, 'abc');
    assert.equal(m.action.label, 'Run a new: A/B/C test');

    const reverted = M.model(base({ experiment: { ...base().experiment, status: 'completed' }, live: 'shop:1.4', results: abcResults, ledger: [{ ...ledger[0], decision: 'reverted', release: 'shop:1.4' }] }));
    assert.equal(reverted.outcome.title, 'Everyone stays on A · 1.4 Classic');
    assert.deepEqual(reverted.versions.map((v: any) => v.badge), ['Kept', 'Rolled back', 'Rolled back']);
  });

  test('no experiment yet: start an A/B/C test (an A/B test with only two releases)', () => {
    const m = M.model(base({ experiment: null }));
    assert.equal(m.action.action, 'abc');
    assert.equal(m.action.label, 'Start: A/B/C test');
    assert.equal(m.steps[0].status, 'current');
    assert.equal(M.model(base({ experiment: null, releases: ['shop:1.4', 'shop:1.5'] })).action.action, 'reset');
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

describe('demo.html and demo.js', () => {
  test('one desktop screen with no page scroll: the bar, the steps, the versions and the results', () => {
    assert.match(css, /body \{[^}]*overflow: hidden;/);
    assert.match(css, /grid-template-areas: "steps versions" "steps results";/);
    for (const id of ['steps', 'versions', 'results', 'autoplay', 'history']) assert.ok(html.includes(`id="${id}"`), id);
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
    assert.match(js, /new EventSource\(`\/api\/traffic\?token=\$\{encodeURIComponent\(TOKEN\)\}`\)/);
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
