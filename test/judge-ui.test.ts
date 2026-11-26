import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixtures } from './judge-fixtures.ts';

const UI = fileURLToPath(new URL('../src/console/ui/', import.meta.url));
const read = (name: string) => readFileSync(join(UI, name), 'utf8');
const html = read('judge.html');
const js = read('judge.js');
const css = read('judge.css');

// judge-format.js is plain browser JS with no types; the tests treat it as untyped.
const J: any = await import(pathToFileURL(join(UI, 'judge-format.js')).href);

const NOW = Date.parse('2026-11-17T10:13:00Z');
const labels = (c: any) => c.buttons.map((b: any) => b.label);
const actions = (c: any) => c.buttons.map((b: any) => b.action);

describe('judge.html and judge.js', () => {
  test('loads the shared console styles, then the layout, the track map and the tour styles, and judge.js as a module', () => {
    assert.match(
      html,
      /<link rel="stylesheet" href="\/style\.css">\s*<link rel="stylesheet" href="\/judge\.css">\s*<link rel="stylesheet" href="\/track\.css">\s*<link rel="stylesheet" href="\/tour\.css">/,
    );
    assert.match(html, /<script type="module" src="\/judge\.js"><\/script>/);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /name="viewport" content="width=device-width, initial-scale=1/);
    assert.match(html, /name="color-scheme" content="light dark"/);
    assert.ok(html.includes('<meta name="switchyard-console" content="">'), 'the server injects the API token here');
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/, 'no inline scripts: the CSP allows only same-origin ones');
  });

  test('app bar: title, Flagsmith context, simulated badge, the tabs, the live feed and the tour control', () => {
    assert.match(html, /<header class="appbar">/);
    assert.ok(html.includes('Switchyard <span class="jhead-mode">judge mode</span>'));
    assert.ok(html.includes('Simulated visitors'));
    for (const id of ['ctx-source', 'ctx-exp', 'ctx-status', 'feed-state', 'tour-open']) assert.match(html, new RegExp(`id="${id}"`), id);
    assert.match(html, /role="tablist"/);
    for (const tab of ['story', 'shop', 'map', 'setup']) {
      assert.match(html, new RegExp(`data-tab="${tab}" aria-selected`), tab);
      assert.match(html, new RegExp(`id="tab-${tab}"`), tab);
    }
    assert.match(html, /target="switchyard-flagsmith">Flagsmith ↗/, 'Flagsmith opens in its own tab: it refuses to be framed');
    assert.match(js, /\$\('tour-open'\)\.addEventListener\('click', openWelcome\)/, 'the app-bar control reopens the welcome card');
  });

  test('one prominent button starts the tour, from a welcome card, with a guided or an autoplay mode', () => {
    assert.equal((html.match(/btn-primary/g) ?? []).length, 1, 'exactly one primary button on the page: Start the judge tour');
    assert.match(html, /id="tour-start" class="btn btn-primary[^"]*"[^>]*>Start the judge tour</);
    assert.match(html, /id="welcome" class="welcome" role="dialog" aria-modal="true"/);
    assert.match(html, /id="welcome-skip"[^>]*>Explore on my own</);
    assert.match(html, /Every deploy becomes a Flagsmith experiment\./);
    assert.match(html, /name="tour-mode" value="guide" checked/);
    assert.match(html, /name="tour-mode" value="auto"/);
    assert.match(js, /tour\.start\(mode\)/);
    // "Explore on my own" is remembered for the session, and storage that throws (private mode) can't break the page.
    assert.match(js, /try \{\s*return sessionStorage\.getItem\(WELCOME_KEY\)/);
    assert.match(js, /try \{\s*sessionStorage\.setItem\(WELCOME_KEY, 'dismissed'\)/);
  });

  test('the Story tab is a dashboard: steps, flow, numbers, map, stage, and what Flagsmith holds', () => {
    for (const id of ['steps-panel', 'steps-list', 'flowline', 'kpis', 'kpi-visitors', 'kpi-rate', 'kpi-events', 'kpi-chance', 'track-card', 'track', 'track-legend', 'stage', 'stage-visual', 'fs-panel', 'fs-experiment', 'fs-flag', 'fs-results', 'fs-health', 'fs-exp-open', 'fs-flag-open', 'fs-results-open', 'action-dock', 'dock-go', 'history']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
    assert.match(html, /<h2 id="fs-title">In Flagsmith right now<\/h2>/);
    assert.match(js, /api\('\/api\/guard'/, 'Feature Health comes from the console bridge, with the token');
    assert.match(js, /res\.status === 404/, 'no bridge configured: the health card stays hidden');
    assert.match(js, /target: FLAGSMITH_TAB/, 'links into Flagsmith reuse its named tab');
  });

  test('the tour gets demo() and openWelcome(); demos are capped and guarded', () => {
    assert.match(js, /import \* as FX from '\.\/fx\.js'/);
    assert.match(js, /typeof fn !== 'function'/, 'a missing fx export is skipped, not thrown');
    assert.match(js, /\n {2}demo,\n {2}openWelcome: /);
    assert.match(js, /DEMO_MAX_MS = 2000/);
    for (const name of ['flow-sweep', 'track-burst', 'kpi-count', 'results-grow', 'diff-flash', 'verify-grow', 'stage-pulse', 'fs-flash', 'steps-sweep']) {
      assert.ok(js.includes(`case '${name}':`), name);
    }
    assert.match(js, /if \(motion\.matches \|\| !name\) return Promise\.resolve\(\)/, 'reduced motion: the SHOW phase resolves at once');
  });

  test('every element judge.js looks up by id exists in judge.html', () => {
    const used = [...js.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]!);
    assert.ok(used.length > 10);
    for (const id of new Set(used)) assert.ok(html.includes(`id="${id}"`), `judge.js uses #${id}, which judge.html lacks`);
  });

  test('progress is announced politely; landmarks are there', () => {
    for (const tag of ['<header', '<main', '<footer', '<nav']) assert.ok(html.includes(tag), tag);
    assert.match(html, /id="stage"[^>]*aria-live="polite"/);
    assert.match(js, /role: 'log'/);
    assert.match(js, /aria-current/);
  });

  test('every API call carries the token; POSTs are JSON and name the experiment', () => {
    assert.doesNotMatch(js, /(?<![\w.])fetch\('\/api/, 'use api(), which adds the token header');
    assert.match(js, /\[TOKEN_HEADER\]: TOKEN/);
    assert.match(js, /meta\[name="switchyard-console"\]/);
    assert.match(js, /new EventSource\(`\/api\/traffic\?token=\$\{encodeURIComponent\(TOKEN\)\}`\)/);
    assert.match(js, /api\('\/api\/judge\/state'/);
    assert.match(js, /api\('\/api\/judge\/job'/);
    const post = /api\('\/api\/judge\/run', \{[\s\S]*?\}\);/.exec(js)?.[0] ?? '';
    assert.match(post, /method: 'POST'/);
    assert.match(post, /'content-type': 'application\/json'/);
    assert.match(post, /experimentId: ui\.state\?\.experiment\?\.id/);
  });

  test('polls the job every second and the state every 5 s; pauses the feed when hidden', () => {
    assert.match(js, /JOB_POLL_MS = 1000/);
    assert.match(js, /STATE_POLL_MS = 5000/);
    assert.match(js, /visibilitychange/);
    assert.match(js, /prefers-reduced-motion: reduce/);
  });

  test('stylesheet: dark mode via the shared tokens, reduced motion, 44 px targets', () => {
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /--tap: 44px/);
    assert.match(read('style.css'), /@media \(prefers-color-scheme: dark\)/);
    assert.match(css, /@media \(prefers-color-scheme: dark\)/, 'the Flagsmith indigo has a dark-mode shade');
  });

  test('layout: full laptop width, three columns from 1280 px, two from 1024 px, one below', () => {
    assert.match(css, /\.wrap \{[^}]*max-width: 1680px/);
    assert.match(css, /@media \(min-width: 1280px\) \{ \.wrap \{ padding-left: 32px; padding-right: 32px; \} \}/);
    assert.match(css, /@media \(min-width: 1024px\) \{ \.wrap \{ padding-left: 24px; padding-right: 24px; \} \}/);
    assert.match(css, /@media \(min-width: 1280px\) \{\s*\.story \{ grid-template-columns: 280px minmax\(0, 1fr\) 380px;/);
    assert.match(css, /@media \(min-width: 1024px\) \{\s*\.story \{ grid-template-columns: minmax\(0, 1fr\) 340px;/);
    assert.match(css, /\.story \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
    assert.doesNotMatch(css, /max-width: 1080px/, 'no narrow centred column');
    assert.match(css, /\.appbar \{[^}]*position: sticky/);
  });

  test("judge.css leaves the tour's and the track map's rules to tour.css and track.css", () => {
    const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(selectors, /\.(tour[\w-]*|tnode[\w-]*|tdot[\w-]*|pct-tag|rail-[\w-]+|track-svg|track-legend)\b/);
    assert.doesNotMatch(selectors, /\.track\s*[{,]/);
    assert.doesNotMatch(js, /'rail-dot'/, 'the old stage rail is gone: the steps panel shows progress');
  });
});

describe('judge-format: steps', () => {
  test('each step has Flagsmith and Switchyard copy', () => {
    for (const id of [...J.STEP_IDS, 'reset']) {
      const c = J.stepCopy(id, fixtures.fresh());
      assert.ok(c.flagsmith.length > 20 && c.switchyard.length > 20, id);
      assert.doesNotMatch(c.flagsmith + c.switchyard, /\{\w+\}/, `${id} has an unfilled placeholder`);
    }
    assert.match(J.stepCopy('preview', fixtures.shipped()).switchyard, /shop:1\.6/);
    assert.match(J.stepCopy('score', fixtures.fresh()).flagsmith, /one refresh every 5 minutes/);
  });

  test('round badges and progress', () => {
    assert.equal(J.roundLabel('03'), 'Round 03 · Split traffic');
    assert.equal(J.roundLabel(null), '');
    assert.equal(J.progressText(fixtures.fresh()), 'Step 1 of 7');
    assert.equal(J.progressText(fixtures.v2Winner()), 'Step 3 of 7');
    assert.equal(J.progressText(fixtures.finale()), 'All steps done');
    assert.equal(J.stepStatusText('todo', false), 'to do');
    assert.equal(J.stepStatusText('current', true), 'you are here');
  });

  test('the plan is the README’s five steps', () => {
    assert.deepEqual(J.PLAN_STEPS.map((p: any) => p.title.split(' ')[0]), ['Pause', 'Save', 'Set', 'Set', 'Complete']);
  });
});

describe('judge-format: which buttons a state allows', () => {
  test('fresh experiment: send visitors, 1,500 by default, any of 500 / 1,500 / 3,000', () => {
    const s = fixtures.fresh();
    assert.deepEqual(labels(J.stepControls(s, 'visitors')), ['Send 1,500 simulated visitors']);
    const c = J.stepControls(s, 'visitors', { visitors: 3000 });
    assert.deepEqual(c.buttons[0].payload, { visitors: 3000 });
    assert.equal(J.stepControls(s, 'visitors', { visitors: 7 }).buttons[0].payload.visitors, 1500);
    assert.equal(c.buttons[0].disabled, false);
    assert.equal(c.links[0][1], s.links.experiment);
  });

  test('score: a countdown while Flagsmith refuses refreshes, then the button', () => {
    const s = fixtures.scoreWaiting();
    const waiting = J.stepControls(s, 'score', { now: NOW });
    assert.equal(waiting.buttons[0].label, 'Ask Flagsmith for results');
    assert.equal(waiting.buttons[0].disabled, true);
    assert.equal(waiting.countdown, s.results.refreshAllowedAt);
    assert.equal(J.countdownText(s.results.refreshAllowedAt, NOW), 'Flagsmith allows the next refresh in 4:00');
    assert.equal(J.countdownText(s.results.refreshAllowedAt, NOW + 239_500), 'Flagsmith allows the next refresh in 0:01');
    const later = J.stepControls(s, 'score', { now: Date.parse('2026-11-17T10:18:00Z') });
    assert.equal(later.buttons[0].disabled, false);
    assert.equal(later.countdown, null);
    assert.equal(J.countdownText(null, NOW), '');
    assert.equal(J.refreshAllowed(null, NOW), true);
  });

  test('v2 winning: Ship winner first, Revert second', () => {
    const c = J.stepControls(fixtures.v2Winner(), 'decide');
    assert.deepEqual(labels(c), ['Ship winner (v2 → shop:1.5)', 'Revert to control (shop:1.4)']);
    assert.deepEqual(actions(c), ['ship', 'revert']);
    assert.equal(c.accept, null);
    assert.match(c.note, /96\.7% chance to win/);
  });

  test('an inconclusive lead still offers Ship, and says it is the judge’s call', () => {
    const s = fixtures.v2Winner();
    s.results.winner = { key: 'v2', release: 'shop:1.5', chanceToWin: 0.8 };
    assert.match(J.stepControls(s, 'decide').note, /inconclusive.*your call/);
    assert.equal(J.stepControls(s, 'decide').buttons[0].label, "Ship Flagsmith's pick (v2 → shop:1.5)", 'no "winner" below the 95% bar');
  });

  test('an interval crossing zero: Keep running is primary, Ship is secondary, and the note shows the interval', () => {
    const s = fixtures.v2Winner();
    (s.results as any).recommendation = { call: 'keep-running', variant: 'v2', reason: 'interval −14% to +44% crosses zero', interval: { low: -0.14, high: 0.44 }, chanceToWin: 0.967 };
    const c = J.stepControls(s, 'decide');
    assert.deepEqual(labels(c), ['Keep running (interval crosses zero)', 'Ship anyway (v2 → shop:1.5)']);
    assert.deepEqual(actions(c), ['keep-running', 'ship']);
    assert.equal(c.buttons[0].tone, 'primary');
    assert.equal(c.buttons[1].tone, 'secondary');
    assert.match(c.note, /96\.7% chance to win\. Credible interval −14\.0% to \+44\.0%\./);
    assert.match(J.winnerLine(s).text, /not a win yet: interval −14% to \+44% crosses zero/);
    assert.equal(J.JOB_STEP['keep-running'], 'decide');
  });

  test('a kept-running ledger entry reads as such', () => {
    assert.equal(J.decisionText({ decision: 'kept-running', reason: 'interval −2% to +62% crosses zero' }), 'Kept running: interval −2% to +62% crosses zero. Nothing changed in Flagsmith.');
  });

  test('no v2 lead: Revert first, Ship v2 second', () => {
    const s = fixtures.v2Winner();
    (s.results as any).winner = { key: 'control', release: 'shop:1.4', chanceToWin: 0.7 };
    assert.deepEqual(actions(J.stepControls(s, 'decide')), ['revert', 'ship']);
  });

  test('losing guardrail: Revert is primary; Ship anyway needs the box and sends acceptLosingGuardrails', () => {
    const c = J.stepControls(fixtures.losingGuardrail(), 'decide');
    assert.deepEqual(labels(c), ['Revert (guardrail losing)', 'Ship anyway…']);
    assert.equal(c.buttons[0].tone, 'primary');
    assert.equal(c.buttons[1].tone, 'danger');
    assert.deepEqual(c.buttons[1].payload, { acceptLosingGuardrails: true });
    assert.equal(c.accept.label, 'I accept that doc_latency_ms is losing');
    assert.equal(c.accept.confirmLabel, 'Ship anyway (v2 → shop:1.6)');
  });

  test('completed and shipped: verify, and swing back is available as an optional step', () => {
    const s = fixtures.shipped();
    assert.deepEqual(labels(J.stepControls(s, 'verify')), ['Check 50 new visitors']);
    const swing = s.steps.find((x: any) => x.id === 'swing');
    assert.equal(swing!.status, 'optional');
    assert.equal(J.showsControls(s, swing), true);
    const c = J.stepControls(s, 'swing');
    assert.deepEqual(actions(c), ['swing-back']);
    assert.equal(c.buttons[0].label, 'Swing everyone back (one flag edit)');
    assert.match(c.note, /shop:1\.4.*flag editor/);
    assert.equal(c.links[0][1], s.links.flag);
    // Once swung back, the same step swings forward.
    const back = fixtures.swungBack();
    assert.deepEqual(labels(J.stepControls(back, 'swing')), ['Swing forward again']);
  });

  test('no swing after a revert, or before any decision', () => {
    const s = fixtures.fresh();
    const swing = s.steps.find((x: any) => x.id === 'swing');
    assert.equal(J.showsControls(s, swing), false);
    assert.deepEqual(J.stepControls(s, 'swing').buttons, []);
    const reverted = fixtures.finale();
    reverted.ledger = reverted.ledger.filter((e) => e.decision === 'reverted');
    assert.deepEqual(J.stepControls(reverted, 'swing').buttons, []);
  });

  test('preview: a button until it is on; then the page shows the link instead', () => {
    assert.deepEqual(labels(J.stepControls(fixtures.shipped(), 'preview')), ['Preview shop:1.6 for your team']);
    const on = fixtures.previewActive();
    assert.deepEqual(J.stepControls(on, 'preview').buttons, []);
    assert.deepEqual(J.stepEvidence(on, 'preview'), ['Preview on: browsers that open the link see shop:1.6.']);
    assert.deepEqual(labels(J.stepControls(on, 'release')), ['Start the next experiment: shop:1.6']);
  });

  test('finale: Start over', () => {
    const s = fixtures.finale();
    assert.deepEqual(actions(J.stepControls(s, 'reset')), ['reset']);
    assert.deepEqual(labels(J.stepControls(s, 'reset')), ['Start over']);
  });

  test('a running job disables every button and says why', () => {
    const s = fixtures.runningJob();
    assert.equal(J.jobRunning(s), true);
    const c = J.stepControls(s, 'visitors');
    assert.equal(c.buttons[0].disabled, true);
    assert.equal(c.note, 'Wait for the running step to finish.');
    assert.equal(J.jobRunning(fixtures.fresh()), false);
  });

  test('links to Flagsmith are dropped when the server has none', () => {
    const s = fixtures.fresh();
    s.links.experiment = null;
    assert.deepEqual(J.stepControls(s, 'visitors').links, []);
  });
});

describe('judge-format: results, as returned', () => {
  test('per-arm n and mean, v2 lift and chance, verdict chips', () => {
    const v = J.resultsView(fixtures.v2Winner());
    assert.deepEqual(v.metrics.map((m: any) => [m.name, m.roleLabel, m.verdict.word, m.verdict.tone]), [
      ['order_placed', 'Goal', 'winning', 'good'],
      ['doc_latency_ms', 'Guardrail', 'inconclusive', 'neutral'],
      ['server_error', 'Guardrail', 'no events', 'neutral'],
    ]);
    const goal = v.metrics[0];
    assert.deepEqual(goal.arms, [
      { key: 'control', release: 'shop:1.4', n: '750', value: '10.0%', mean: 0.1 },
      { key: 'v2', release: 'shop:1.5', n: '750', value: '13.0%', mean: 0.13 },
    ]);
    assert.deepEqual(goal.v2, { lift: '+30.0%', chance: '96.7%', chanceRatio: 0.967, interval: '−2.0% to +62.0%' });
    assert.equal(goal.meta, 'occurrence · higher is better');
    assert.equal(v.metrics[1].arms[1].value, '27 ms');
    assert.equal(v.metrics[2].v2, null);
    assert.equal(v.winner.tone, 'good');
    assert.match(v.winner.text, /v2 \(shop:1\.5\) is winning on order_placed: 96\.7%/);
    assert.deepEqual(v.losing, []);
    assert.equal(J.resultsView(fixtures.fresh()), null);
  });

  test('losing guardrail is red, with Flagsmith’s numbers', () => {
    const v = J.resultsView(fixtures.losingGuardrail());
    const lat = v.metrics.find((m: any) => m.name === 'doc_latency_ms');
    assert.deepEqual(lat.verdict, { word: 'losing', tone: 'bad' });
    assert.equal(lat.arms[1].value, '98 ms');
    assert.deepEqual(v.losing, ['doc_latency_ms is losing: <0.1% chance to win, lift +268.3% (as returned)']);
    assert.equal(v.winner.tone, 'neutral', 'a losing guardrail keeps the headline out of green');
  });

  test('verdict chips cover every verdict', () => {
    assert.equal(J.verdictChip('collecting').word, 'collecting data');
    assert.equal(J.verdictChip('mystery').word, 'mystery');
  });

  test('no leader yet', () => {
    assert.match(J.winnerLine(fixtures.scoreWaiting()).text, /^No leader yet/);
  });
});

describe('judge-format: evidence, jobs and the ledger', () => {
  test('evidence after each step', () => {
    assert.deepEqual(J.stepEvidence(fixtures.v2Winner(), 'visitors'), [
      "1,500 simulated visitors sent. Flagsmith's event counter: 9,210 accepted · 0 rejected (as returned)",
    ]);
    assert.deepEqual(J.stepEvidence(fixtures.shipped(), 'decide'), ['Shipped v2 → shop:1.5 (replaced shop:1.4)']);
    assert.deepEqual(J.stepEvidence(fixtures.swungBack(), 'swing'), ['Everyone is on shop:1.4 now.']);
    const nullCounter = fixtures.v2Winner();
    (nullCounter.totals as { eventsAccepted: number | null }).eventsAccepted = null;
    assert.equal(J.totalsText(nullCounter.totals), '1,500 simulated visitors sent');
  });

  test('verify: bars per release and the check', () => {
    const s = fixtures.verified();
    const v = J.verifySummary(s.job!.result);
    assert.deepEqual(v.bars, [{ release: 'shop:1.5', count: 50, pct: 100 }]);
    assert.equal(v.text, '50 of 50 new visitors got shop:1.5.');
    assert.equal(v.check, 'check: clean, no experiment split left on the flag');
    const split = J.verifySummary({ byRelease: { 'shop:1.4': 10, 'shop:1.5': 40 }, check: { clean: false } });
    assert.equal(split.text, 'shop:1.5: 40 · shop:1.4: 10 (of 50 new visitors)');
    assert.equal(split.check, 'check found an experiment split still on the flag');
    // The console's own verify result shape.
    const own = J.verifySummary({ byRelease: { 'shop:1.5': 50 }, expected: 'shop:1.5', leftovers: 0 });
    assert.equal(own.check, 'check: clean, no experiment split left on the flag');
    assert.equal(J.verifySummary({ byRelease: { 'shop:1.5': 50 }, leftovers: 2 }).check, 'check found 2 experiment splits still on the flag');
    assert.match(J.verifySummary({ byRelease: { 'shop:1.5': 50 }, leftovers: null }).check, /skipped/);
    assert.equal(J.verifySummary(null), null);
    assert.equal(J.verifySummary({ byRelease: {} }), null);
    assert.deepEqual(J.stepEvidence(s, 'verify', { verify: s.job!.result }), ['50 of 50 new visitors got shop:1.5.', 'check: clean, no experiment split left on the flag']);
  });

  test('a running job: title, elapsed time, log and the step it belongs to', () => {
    const s = fixtures.runningJob();
    const v = J.jobView(s.job, Date.parse('2026-11-17T10:05:12Z'));
    assert.equal(v.running, true);
    assert.equal(v.title, 'Sending simulated visitors');
    assert.equal(v.elapsed, '12 s');
    assert.equal(v.step, 'visitors');
    assert.equal(v.log.length, 2);
    assert.equal(v.outcome, '');
    assert.equal(J.jobView(null), null);
    assert.equal(J.formatDuration(65_000), '1 min 05 s');
  });

  test('a failed ship shows the error and the losing guardrails', () => {
    const s = fixtures.failedJob();
    const v = J.jobView(s.job, NOW, s.results.losingGuardrails);
    assert.equal(v.tone, 'bad');
    assert.equal(v.step, 'decide');
    assert.equal(v.outcome, 'Stopped: v2 is losing a guardrail; ship needs acceptLosingGuardrails');
    assert.deepEqual(v.guardrails, ['doc_latency_ms is losing: <0.1% chance to win, lift +268.3% (as returned)']);
    const done = J.jobView({ ...s.job, status: 'done', error: null }, NOW);
    assert.equal(done.outcome, 'Done in 2 s.');
    assert.deepEqual(done.guardrails, []);
  });

  test('the ledger, newest first', () => {
    const l = J.ledgerView(fixtures.finale().ledger);
    assert.deepEqual(l.map((e: any) => [e.decision, e.text]), [
      ['reverted', 'Reverted: everyone on shop:1.5'],
      ['shipped', 'Shipped v2 → shop:1.5 (replaced shop:1.4)'],
    ]);
    assert.equal(l[0].results.length, 2);
    assert.deepEqual(J.ledgerView(undefined), []);
  });

  test('run errors in plain words', () => {
    assert.equal(J.runErrorText(403, {}), "This page's session expired — reload");
    assert.equal(J.runErrorText(409, { error: 'Another step is running' }), 'Another step is running');
    assert.match(J.runErrorText(409, {}), /Not allowed right now/);
    assert.equal(J.runErrorText(400, { error: 'unknown action' }), 'unknown action');
    assert.equal(J.runErrorText(500, {}), 'The console answered HTTP 500.');
  });

  test('traffic rates and release colours', () => {
    assert.equal(J.perSecond([100, 1000, 1001, 4000, 5900], 6000), 0.6);
    assert.equal(J.formatRate(0.8), '0.8 req/s');
    assert.equal(J.formatRate(42.4), '42 req/s');
    assert.equal(J.formatRate(0), '0 req/s');
    const releases = ['shop:1.4', 'shop:1.5', 'shop:1.6'];
    assert.equal(J.releaseColor(releases, 'shop:1.4'), '#2563eb');
    assert.equal(J.releaseColor(releases, 'shop:1.5'), '#16a34a');
  });
});

test('after a console restart the visitor count falls back to what Flagsmith counted', () => {
  assert.equal(J.totalsText({ visitorsSent: 0, eventsAccepted: null, eventsRejected: null }, 1500), 'Flagsmith counted 1,500 visitors in this experiment');
  assert.equal(J.totalsText({ visitorsSent: 0, eventsAccepted: null, eventsRejected: null }, 0), '0 simulated visitors sent');
});

test('a decision made by the guard says so', () => {
  assert.equal(
    J.decisionText({ decision: 'reverted', release: 'shop:1.5', by: 'guard', guardReason: 'shop:1.6 losing doc_latency_ms, 0.0% chance to win' }),
    'Reverted: everyone on shop:1.5 (automatically, by the guard: shop:1.6 losing doc_latency_ms, 0.0% chance to win)',
  );
});

describe('judge-format: the guide, the track diagram and what changed', () => {
  const routing = {
    defaultRelease: 'shop:1.4',
    experiment: { id: 11, status: 'running', enrolledPct: 100, arms: [{ key: 'control', release: 'shop:1.4', pct: 50 }, { key: 'v2', release: 'shop:1.5', pct: 50 }] },
    preview: { active: true, release: 'shop:1.6' },
  };

  test("the page's stage names match the server's, job by job", async () => {
    const { JOB_STAGES } = await import('../src/console/judge.ts');
    assert.deepEqual(J.STAGES, JOB_STAGES);
  });

  test('tracks: preview, experiment split, everyone else', () => {
    const rules = J.trackRules(routing);
    assert.deepEqual(rules.map((r: any) => r.id), ['preview', 'experiment', 'default']);
    assert.deepEqual(rules[1].targets.map((t: any) => [t.release, t.pct]), [['shop:1.4', 50], ['shop:1.5', 50]]);
    assert.equal(rules[2].note, 'bots, and anyone outside the rollout');
    assert.equal(J.routingSummary(rules), 'Your team: shop:1.6. Experiment 11: 50% shop:1.4, 50% shop:1.5. Everyone else: shop:1.4');
    assert.deepEqual(J.trackRules(null), []);
  });

  test('a request rides the experiment if enrolled, the preview if it got that release, else the default', () => {
    const rules = J.trackRules(routing);
    assert.equal(J.routeOf({ enrolled: true, release: 'shop:1.5' }, rules), 'experiment');
    assert.equal(J.routeOf({ enrolled: false, release: 'shop:1.6' }, rules), 'preview');
    assert.equal(J.routeOf({ enrolled: false, release: 'shop:1.4' }, rules), 'default');
  });

  test('before → after marks only the rows that moved', () => {
    const after = { ...routing, experiment: null, defaultRelease: 'shop:1.5' };
    const rows = J.routingDiff(routing, after);
    assert.deepEqual(rows.map((r: any) => [r.label, r.changed]), [['Everyone else gets', true], ['Experiment split', true], ['Preview for your team', false]]);
    assert.equal(rows[0].before, 'shop:1.4');
    assert.equal(rows[0].after, 'shop:1.5');
    assert.equal(rows[1].after, 'none running');
    assert.ok(J.routingDiff(routing, null).every((r: any) => r.changed === false && r.after === null));
  });

  test('the guide points at the enabled primary button, and the bar says to click it', () => {
    const s = fixtures.v2Winner();
    const c = J.stepControls(s, 'decide', { now: NOW });
    assert.equal(J.coachButton(c), 'btn-ship');
    const line = J.coachLine({ ...s, current: 'decide' }, c, NOW);
    assert.equal(line.kind, 'click');
    assert.match(line.text, /Click “Ship winner/);
    const running = J.coachLine({ ...s, job: { action: 'ship', status: 'running', stages: [{ title: 'Pause the experiment', status: 'running' }, { title: 'x', status: 'todo' }] } }, c, NOW);
    assert.equal(running.kind, 'working');
    assert.match(running.text, /1 of 2: Pause the experiment/);
    assert.equal(J.coachButton({ buttons: [{ action: 'score', tone: 'primary', disabled: true, payload: {} }] }), null);
  });

  test('every step has a guide card that names a place in Flagsmith', () => {
    for (const id of J.STEP_IDS) {
      const g = J.stepGuide(id, fixtures.v2Winner());
      assert.ok(g && g.you && g.watch && g.proves && /^Flagsmith →/.test(g.where), id);
    }
  });

  test('a job view carries the stages, progress and the before/after', () => {
    const v = J.jobView({ id: 'j', action: 'visitors', status: 'running', startedAt: '2026-11-17T10:00:00Z', log: [], stages: [{ title: 'a', status: 'running' }], progress: { done: 250, total: 1500 }, changes: { before: routing, after: null } }, NOW);
    assert.deepEqual(v.progress, { done: 250, total: 1500 });
    assert.equal(v.stages[0].status, 'running');
    assert.equal(v.changes.before, routing);
    const old = J.jobView({ id: 'k', action: 'verify', status: 'done', startedAt: '2026-11-17T10:00:00Z', finishedAt: '2026-11-17T10:00:05Z', log: [] }, NOW);
    assert.deepEqual(old.stages.map((s: any) => s.status), ['done', 'done', 'done']);
  });
});

describe('judge.html: what the tour points at', () => {
  test('every element the tour targets is on the page', () => {
    for (const id of ['welcome', 'tour-start', 'steps-panel', 'flowline', 'kpis', 'track-card', 'track', 'stage', 'stage-visual', 'fs-panel', 'fs-experiment', 'fs-flag', 'fs-results', 'history', 'shop-frame', 'map-frame', 'setup-frame']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
    assert.match(js, /'data-key': `btn-\$\{b\.action\}`/, 'the stage button carries data-key="btn-<action>"');
    assert.match(js, /import \{ createTrack \} from '\.\/track\.js'/);
    assert.match(js, /import \{ createTour \} from '\.\/tour\.js'/);
  });

  test('every target named in the tour script exists in judge.html (or is the tour’s own bubble button)', () => {
    const plan = read('tour-plan.js');
    const ids = new Set([...plan.matchAll(/target: '#([\w-]+)'/g)].map((m) => m[1]!));
    assert.ok(ids.size > 3);
    for (const id of ids) assert.ok(id === 'tour-action' || html.includes(`id="${id}"`), `tour-plan.js targets #${id}, which judge.html lacks`);
  });
});

// format.js and tour.js are plain browser JS with no types; their pure helpers load in Node.
const F: any = await import(pathToFileURL(join(UI, 'format.js')).href);
const T: any = await import(pathToFileURL(join(UI, 'tour.js')).href);

describe('judge mode: the optional swing on the stage', () => {
  const shipped = (over: Record<string, unknown> = {}) => ({
    experiment: { id: 7, status: 'completed', control: 'shop:1.4', v2: 'shop:1.5' },
    steps: [{ id: 'swing', status: 'optional' }],
    ledger: [
      { experimentId: 6, decision: 'reverted', variant: 'control', release: 'shop:1.4', replaced: 'shop:1.4', at: '2026-11-17T09:00:00Z' },
      { experimentId: 7, decision: 'shipped', variant: 'v2', release: 'shop:1.5', replaced: 'shop:1.4', at: '2026-11-17T10:00:00Z' },
    ],
    variants: [{ key: 'v2', release: 'shop:1.5' }],
    live: 'shop:1.5',
    ...over,
  });

  test('after a ship: swing back first, then forward, naming the release', () => {
    assert.deepEqual(F.judgeSwingOffer(shipped()), { action: 'swing-back', label: 'Optional: swing everyone back to shop:1.4', release: 'shop:1.4' });
    assert.deepEqual(F.judgeSwingOffer(shipped({ live: 'shop:1.4' })), { action: 'swing-forward', label: 'Optional: swing forward to shop:1.5', release: 'shop:1.5' });
  });

  test('nothing to offer before a decision, after a revert, once both swings are done, or after a preview re-pointed v2', () => {
    assert.equal(F.judgeSwingOffer(shipped({ experiment: { id: 7, status: 'running' } })), null);
    assert.equal(F.judgeSwingOffer(shipped({ ledger: [{ experimentId: 7, decision: 'reverted', variant: 'control', release: 'shop:1.4', at: '2026-11-17T10:00:00Z' }] })), null);
    assert.equal(F.judgeSwingOffer(shipped({ ledger: [] })), null, "another experiment's decision doesn't count");
    assert.equal(F.judgeSwingOffer(shipped({ steps: [{ id: 'swing', status: 'done' }] })), null);
    assert.equal(F.judgeSwingOffer(shipped({ variants: [{ key: 'v2', release: 'shop:1.6' }] })), null);
    assert.equal(F.judgeSwingOffer(null), null);
  });

  test('judge mode keeps one prominent button: the swing is a small ghost button beside it', () => {
    assert.match(js, /class: 'btn btn-small btn-ghost stage-swing'/);
    assert.match(js, /'data-key': `btn-\$\{swing\.action\}`/);
    assert.match(js, /import \{ judgeSwingOffer \} from '\.\/format\.js'/);
    assert.doesNotMatch(js, /Ship anyway, swing and the visitor count live in the full console\./);
    assert.match(css, /\.stage-swing \{[^}]*border-style: dashed/);
  });
});

describe('judge mode: the release history is never cut off', () => {
  test('the left column has no scroll of its own; it is sticky only while it fits', () => {
    const rule = css.match(/@media \(min-width: 1280px\) \{[\s\S]*?\.col-left \{([^}]*)\}/)?.[1] ?? '';
    assert.ok(rule, 'the three-column .col-left rule');
    assert.doesNotMatch(rule, /overflow-y|max-height|position: sticky/);
    assert.match(css, /\.col-left\.is-sticky \{ position: sticky;/);
    assert.match(js, /box\.classList\.toggle\('is-sticky', [^;]*box\.offsetHeight <= room\)/);
  });

  test('the latest three decisions, the rest behind "Show all"', () => {
    assert.match(js, /const HISTORY_SHOWN = 3;/);
    assert.match(html, /<button id="history-more" class="history-more" type="button" aria-expanded="false" hidden><\/button>/);
  });
});

describe('the tour bubble beside a small target', () => {
  // The Revert beat at 1440 × 900: the stage's button, with the stage heading about 150 px above it.
  const button = { x: 337, y: 448, w: 257, h: 69 };
  const base = { vw: 1440, vh: 900, minY: 72, fw: 380, fh: 341, compactH: 77 };

  test('the compact bubble sits level with the button, not up over the heading', () => {
    const spot = T.bubbleSpot({ ...base, target: button, compact: true, bw: 300, bh: 77 });
    assert.equal(spot.side, 'right');
    assert.equal(spot.x, button.x + button.w + 18);
    assert.equal(spot.y, Math.round(button.y + button.h / 2 - 77 / 2));
    assert.ok(spot.y > 400, 'the old placement put it at 312, over the heading at 305-333');
  });

  test('opening it keeps its top: it grows down', () => {
    const compact = T.bubbleSpot({ ...base, target: button, compact: true, bw: 300, bh: 77 });
    const open = T.bubbleSpot({ ...base, target: button, compact: false, bw: 380, bh: 341 });
    assert.equal(open.y, compact.y);
  });

  test('near the bottom, it rises just enough for the open bubble to fit', () => {
    const low = { ...button, y: 760 };
    const spot = T.bubbleSpot({ ...base, target: low, compact: true, bw: 300, bh: 77 });
    assert.equal(spot.y, 900 - 341 - 16);
  });

  test('the side it had stays while it fits; no target means a centred card', () => {
    assert.equal(T.bubbleSpot({ ...base, target: { x: 900, y: 300, w: 200, h: 60 }, compact: true, bw: 300, bh: 77, prefer: 'left' }).side, 'left');
    assert.equal(T.bubbleSpot({ ...base, target: { x: 0, y: 0, w: 1440, h: 900 }, compact: false, bw: 380, bh: 341 }).side, 'overlap');
    const centre = T.bubbleSpot({ ...base, target: null, compact: false, bw: 380, bh: 341 });
    assert.deepEqual(centre, { side: 'center', x: (1440 - 380) / 2, y: (900 - 341) / 2 });
  });
});
