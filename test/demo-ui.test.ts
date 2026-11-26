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

const metric = (name: string, role: string, aggregation: string, direction: string, control: number, v2: number, verdict: string, chanceToWin: number | null) => ({
  name,
  role,
  aggregation,
  direction,
  arms: { control: { n: 750, mean: control }, v2: { n: 750, mean: v2 } },
  v2: chanceToWin === null ? null : { lift: v2 / control - 1, chanceToWin, ciLow: 0, ciHigh: 0 },
  verdict,
});
const steps = (visitors: string, score: string, decide: string, verify = 'todo') => [
  { id: 'visitors', status: visitors },
  { id: 'score', status: score },
  { id: 'decide', status: decide },
  { id: 'verify', status: verify },
];
const base = (over: any = {}) => ({
  releases: ['shop:1.4', 'shop:1.5', 'shop:1.6'],
  live: 'shop:1.4',
  next: 'shop:1.6',
  links: { shop: 'http://127.0.0.1:8080', experiment: null },
  experiment: { id: 7, status: 'running', control: 'shop:1.4', v2: 'shop:1.5' },
  results: null,
  steps: steps('current', 'todo', 'todo'),
  routing: { defaultRelease: 'shop:1.4', experiment: { id: 7, enrolledPct: 100, arms: [{ key: 'control', release: 'shop:1.4', pct: 50 }, { key: 'v2', release: 'shop:1.5', pct: 50 }] } },
  ledger: [],
  totals: { visitorsSent: 0 },
  ...over,
});
const shipResults = {
  asOf: '2026-11-24T10:00:00Z',
  refreshAllowedAt: null,
  metrics: [
    metric('order_placed', 'goal', 'occurrence', 'up', 0.1, 0.16, 'winning', 0.999),
    metric('doc_latency_ms', 'guardrail', 'mean', 'down', 70, 71, 'inconclusive', 0.4),
    metric('server_error', 'guardrail', 'mean', 'down', 0, 0, 'no-events', null),
  ],
  winner: { key: 'v2', release: 'shop:1.5', chanceToWin: 0.999 },
  losingGuardrails: [],
  recommendation: { call: 'ship', variant: 'v2', chanceToWin: 0.999, reason: 'clears zero', interval: { low: 0.2, high: 0.9 } },
};
const revertResults = {
  ...shipResults,
  metrics: [metric('order_placed', 'goal', 'occurrence', 'up', 0.163, 0.194, 'winning', 0.98), metric('doc_latency_ms', 'guardrail', 'mean', 'down', 70.27, 169.96, 'losing', 0)],
  losingGuardrails: [{ metric: 'doc_latency_ms', chanceToWin: 0, lift: 1.42 }],
  recommendation: { call: 'revert', variant: 'v2', chanceToWin: 0.98, reason: 'v2 is losing doc_latency_ms', interval: { low: 0.01, high: 0.37 } },
};
const tested = { control: 'shop:1.5', v2: 'shop:1.6' };

describe('demo-model.js: what the simple judge page says', () => {
  test('names releases and metrics in plain words', () => {
    assert.equal(M.label('shop:1.5'), '1.5 Express');
    assert.equal(M.label('app:2.0'), '2.0');
    assert.equal(M.metricName('doc_latency_ms'), 'Page load time');
    assert.equal(M.metricName('order_placed'), 'Orders');
    assert.equal(M.metricName('signup_done'), 'Signup done');
  });

  test('four fixed steps whose titles never change, whatever the state', () => {
    const titles = (s: any) => M.model(s).steps.map((x: any) => x.title);
    const expected = ['Start a test', 'Send shoppers', 'Ask Flagsmith', 'Decide'];
    assert.deepEqual(titles(base()), expected);
    assert.deepEqual(titles(base({ results: revertResults, steps: steps('done', 'done', 'current') })), expected);
    assert.deepEqual(titles(base({ experiment: { ...base().experiment, status: 'completed' }, results: shipResults, live: 'shop:1.5' })), expected);
    assert.deepEqual(titles(base({ experiment: null })), expected);
  });

  test('a running test: one green button per step, in order', () => {
    let m = M.model(base());
    assert.equal(m.now, 'Flagsmith is testing 1.5 Express against 1.4 Classic. Each new shopper gets one of them.');
    assert.deepEqual(m.steps.map((x: any) => x.status), ['done', 'current', 'todo', 'todo']);
    assert.equal(m.action.action, 'visitors');
    assert.equal(m.action.label, 'Send 1,500 shoppers');
    assert.deepEqual(m.versions.map((v: any) => v.badge), ['50% of shoppers', '50% of shoppers']);

    m = M.model(base({ steps: steps('done', 'current', 'todo'), totals: { visitorsSent: 1500 } }));
    assert.equal(m.action.action, 'score');
    assert.equal(m.steps[1].result, '1,500 shoppers went through Turnout.');

    m = M.model(base({ steps: steps('done', 'done', 'current'), results: shipResults }));
    assert.equal(m.action.action, 'ship');
    assert.equal(m.action.label, 'Ship 1.5 Express to everyone');
    assert.deepEqual(m.alt, { action: 'revert', label: 'Keep 1.4 Classic instead' });
    assert.equal(m.steps[1].result, 'Flagsmith counted 1,500 shoppers.');
    assert.equal(m.verdict.title, '1.5 Express wins');
    assert.equal(m.verdict.text, '1.5 Express gets more orders (16.0% vs 10.0%) and every safety check is fine. Flagsmith is 100% sure it\'s better.');
  });

  test('a release that sells more but slows the page: the verdict leads with the failed safety check, not "winning"', () => {
    const m = M.model(base({ experiment: { id: 9, status: 'running', ...tested }, live: 'shop:1.5', steps: steps('done', 'done', 'current'), results: revertResults }));
    assert.equal(m.action.action, 'revert');
    assert.equal(m.action.label, 'Roll back to 1.5 Express');
    assert.equal(m.alt, null);
    assert.equal(m.verdict.title, 'A safety check failed');
    assert.equal(
      m.verdict.text,
      '1.6 Bold gets more orders (19.4% vs 16.3%), but its pages load 2.4× slower (170 ms vs 70 ms). Flagsmith marks the release unhealthy, so the safe call is to keep everyone on 1.5 Express.',
    );
    const rows = M.findings({ experiment: tested, results: revertResults });
    assert.deepEqual(rows.map((r: any) => [r.name, r.roleText, r.current, r.next, r.word, r.note]), [
      ['Orders', 'Goal', '16.3%', '19.4%', 'Better', 'Flagsmith: 98% chance 1.6 Bold is better'],
      ['Page load time', 'Safety check', '70 ms', '170 ms', 'Worse', '2.4× slower on 1.6 Bold'],
    ]);
  });

  test('not sure yet: keep testing, with a way out', () => {
    const results = { ...shipResults, recommendation: { call: 'keep-running', chanceToWin: 0.7, reason: 'under 95%' } };
    const m = M.model(base({ steps: steps('done', 'done', 'current'), results }));
    assert.equal(m.verdict.title, 'Not sure yet');
    assert.match(m.verdict.text, /only 70% sure 1\.5 Express is better; it calls a winner at 95%/);
    assert.equal(m.action.action, 'keep-running');
    assert.equal(m.alt.action, 'revert');
  });

  test("Flagsmith's refresh limit: the button carries the time it opens again", () => {
    const now = Date.parse('2026-11-24T10:00:00Z');
    const results = { ...shipResults, refreshAllowedAt: '2026-11-24T10:03:00Z' };
    const m = M.model(base({ steps: steps('done', 'current', 'todo'), results }), { now });
    assert.equal(m.action.waitUntil, '2026-11-24T10:03:00Z');
  });

  test('a finished test reads as a finished story, with the next test as the only button', () => {
    const ledger = [{ experimentId: 9, decision: 'reverted', release: 'shop:1.5', replaced: 'shop:1.5', experiment: 'shop_release: shop:1.6 vs shop:1.5', at: '2026-11-24T10:05:00Z' }];
    const m = M.model(base({ experiment: { id: 9, status: 'completed', ...tested }, live: 'shop:1.5', next: null, results: revertResults, ledger }));
    assert.equal(m.finished, true);
    assert.equal(m.now, 'Everyone gets 1.5 Express. No test is running.');
    assert.deepEqual(m.steps.map((x: any) => x.status), ['done', 'done', 'done', 'done']);
    assert.equal(m.steps[3].result, 'Rolled back: everyone stays on 1.5 Express.');
    assert.equal(m.outcome.title, '1.6 Bold rolled back');
    assert.deepEqual(m.versions.map((v: any) => v.badge), ['Kept · everyone gets it', 'Rolled back']);
    assert.equal(m.action.action, 'reset');
    assert.equal(m.action.label, 'Start over: 1.5 Express against 1.4 Classic');

    const shipped = M.model(base({ experiment: { id: 7, status: 'completed', control: 'shop:1.4', v2: 'shop:1.5' }, live: 'shop:1.5', results: shipResults }));
    assert.equal(shipped.outcome.title, '1.5 Express shipped to everyone');
    assert.equal(shipped.action.action, 'release');
    assert.equal(shipped.action.label, 'Test the next version: 1.6 Bold');
  });

  test('no experiment yet: start the first test', () => {
    const m = M.model(base({ experiment: null }));
    assert.equal(m.action.action, 'reset');
    assert.equal(m.action.label, 'Start a test: 1.5 Express against 1.4 Classic');
    assert.equal(m.steps[0].status, 'current');
  });

  test('jobs, before → after, the check and the history in one line each', () => {
    assert.deepEqual(M.jobView({ action: 'visitors', status: 'running', progress: { done: 300, total: 1500 }, stages: [] }), {
      action: 'visitors', running: true, failed: false, title: 'Sending shoppers', detail: '300 of 1,500 shoppers', fraction: 0.2,
    });
    const before = { defaultRelease: 'shop:1.5', experiment: { id: 9, enrolledPct: 100, arms: [{ key: 'control', release: 'shop:1.5', pct: 50 }, { key: 'v2', release: 'shop:1.6', pct: 50 }] } };
    const after = { defaultRelease: 'shop:1.5', experiment: null };
    assert.deepEqual(M.changes({ action: 'revert', changes: { before, after } }), {
      before: '50% 1.5 Express, 50% 1.6 Bold (experiment #9)',
      after: 'everyone: 1.5 Express',
    });
    assert.deepEqual(M.verifyText({ action: 'verify', status: 'done', result: { byRelease: { 'shop:1.5': 50 }, expected: 'shop:1.5', leftovers: 0 } }), {
      ok: true,
      text: '50 of 50 brand-new shoppers got 1.5 Express, and no experiment split is left on the flag.',
    });
    assert.equal(M.verifyText({ action: 'verify', status: 'done', result: { byRelease: { 'shop:1.5': 49, 'shop:1.6': 1 }, expected: 'shop:1.5', leftovers: null } }).ok, false);
    assert.deepEqual(
      M.history([
        { decision: 'shipped', release: 'shop:1.5', replaced: 'shop:1.4', experiment: 'shop_release: shop:1.5 vs shop:1.4', at: 'a' },
        { decision: 'kept-running', release: null, experiment: 'x', at: 'b' },
        { decision: 'reverted', release: 'shop:1.5', replaced: 'shop:1.5', experiment: 'shop_release: shop:1.6 vs shop:1.5', at: 'c' },
      ]).map((r: any) => r.text),
      ['1.6 Bold rolled back, 1.5 Express kept', '1.5 Express shipped (replaced 1.4 Classic)'],
    );
  });
});

describe('demo.html and demo.js', () => {
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
