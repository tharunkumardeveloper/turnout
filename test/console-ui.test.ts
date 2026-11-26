import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createConsole } from '../src/console/server.ts';
import type { Experiments } from '../src/flagsmith/experiments.ts';
import { initialState } from './fake-flagsmith.ts';

const UI = fileURLToPath(new URL('../src/console/ui/', import.meta.url));
const read = (name: string) => readFileSync(join(UI, name), 'utf8');
const files = readdirSync(UI);
const jsFiles = files.filter((f) => f.endsWith('.js'));
const html = read('index.html');

// format.js is plain browser JS with no types; the tests treat it as untyped.
const F: any = await import(pathToFileURL(join(UI, 'format.js')).href);

describe('console UI files', () => {
  test('only file types the console serves, in a flat directory', () => {
    for (const f of files) assert.ok(['.html', '.js', '.css', '.svg'].includes(extname(f)), `${f} would not be served`);
    assert.ok(files.includes('index.html') && files.includes('app.js') && files.includes('style.css'));
  });

  test('index.html loads app.js as a module and style.css', () => {
    assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
    assert.match(html, /<link rel="stylesheet" href="\/style\.css">/);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /name="color-scheme" content="light dark"/);
    assert.ok(html.includes('<meta name="switchyard-console" content="">'), 'the server injects the API token here');
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/, 'no inline scripts: the CSP allows only same-origin ones');
  });

  test('index.html has the landmarks and regions the console needs', () => {
    for (const tag of ['<header', '<main', '<footer', '<dialog']) assert.ok(html.includes(tag), tag);
    const ids = [
      'experiment-header', 'exp-name', 'exp-status', 'exp-hypothesis', 'exp-started', 'flag-name', 'flag-routing',
      'traffic', 'map', 'sampling', 'merged-badge',
      'results', 'results-asof', 'refresh-btn', 'refresh-status', 'winner', 'metrics', 'srm', 'events',
      'actions', 'ship-form', 'ship-choices', 'ship-btn', 'revert-btn', 'action-status',
      'snapshots', 'snapshot-list', 'confirm-dialog', 'dialog-title', 'dialog-body', 'dialog-result', 'dialog-confirm', 'dialog-cancel',
    ];
    for (const id of ids) assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
    for (const id of ['action-status', 'refresh-status', 'dialog-result']) {
      assert.match(html, new RegExp(`id="${id}"[^>]*aria-live="polite"`), `#${id} should announce results`);
    }
    assert.ok(html.includes("Flagsmith decides; Switchyard never computes its own statistics. Every action is visible in Flagsmith's audit log."));
  });

  test('every element app.js looks up by id exists in index.html', () => {
    const used = [...read('app.js').matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]!);
    assert.ok(used.length > 20);
    for (const id of new Set(used)) assert.ok(html.includes(`id="${id}"`), `app.js uses #${id}, which index.html lacks`);
  });

  test('each script parses', () => {
    for (const f of jsFiles) execFileSync(process.execPath, ['--check', join(UI, f)]);
  });

  test('imports stay inside the flat ui directory', () => {
    for (const f of jsFiles) {
      for (const m of read(f).matchAll(/^import .* from '([^']+)';$/gm)) {
        const spec = m[1]!;
        assert.match(spec, /^\.\/[\w-]+\.js$/, `${f} imports ${spec}`);
        assert.ok(files.includes(spec.slice(2)), `${f} imports missing ${spec}`);
      }
    }
  });

  test('no external requests: no remote URLs besides the SVG namespace', () => {
    for (const f of files) {
      const urls = [...read(f).matchAll(/https?:\/\/[^\s'"`)]+/g)].map((m) => m[0]).filter((u) => !u.startsWith('http://www.w3.org/2000/svg'));
      assert.deepEqual(urls, [], `${f} references ${urls.join(', ')}`);
    }
  });

  test('server strings are never inserted as HTML', () => {
    for (const f of jsFiles) assert.doesNotMatch(read(f), /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, f);
  });

  test('every API call carries the token; the event stream sends it as a query parameter', () => {
    const app = read('app.js');
    assert.doesNotMatch(app, /(?<![\w.])fetch\('\/api/, 'use api(), which adds the token header');
    assert.match(app, /new EventSource\(`\/api\/traffic\?token=\$\{encodeURIComponent\(TOKEN\)\}`\)/);
    assert.match(app, /meta\[name="switchyard-console"\]/);
  });

  test('Ship and Revert send the experiment the page shows', () => {
    const app = read('app.js');
    assert.match(app, /experimentId: job\.experimentId/);
    assert.match(app, /experimentId: String\(e\.id\)/);
    assert.match(app, /acceptLosingGuardrails: true/);
  });

  test('POSTs send JSON, which the console requires', () => {
    const app = read('app.js');
    const posts = [...app.matchAll(/method: 'POST'[^}]*\}/g)].map((m) => m[0]);
    assert.ok(posts.length >= 2);
    for (const p of posts) assert.match(p, /'content-type': 'application\/json'/);
  });

  test('reduced motion and dark mode are handled in the stylesheet', () => {
    const css = read('style.css');
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /@media \(prefers-color-scheme: dark\)/);
    assert.match(css, /--control: #2563eb/);
    assert.match(css, /--treatment: #16a34a/);
    assert.match(read('app.js'), /prefers-reduced-motion: reduce/);
  });

  test('the header links to judge mode', () => {
    assert.match(html, /<a class="btn btn-small judge-link" href="\/judge">Judge mode<\/a>/);
  });

  test('phones: 44 px touch targets, dialogs that fit, a compact traffic map', () => {
    const css = read('style.css');
    assert.match(css, /--tap: 44px/);
    assert.match(css, /@media \(pointer: coarse\), \(max-width: 760px\) \{\s*\.btn, \.btn-small \{ min-height: var\(--tap\); \}/);
    assert.match(css, /max-height: calc\(100dvh - 32px - env\(safe-area-inset-top\) - env\(safe-area-inset-bottom\)\);\s*overflow: auto;/);
    assert.match(css, /\.junction\.compact/);
    assert.match(css, /\.map-platforms/);
    const map = read('map.js');
    assert.match(map, /const COMPACT_BELOW_PX = \d+;/);
    assert.match(map, /new ResizeObserver/);
    assert.match(map, /viewBox: `0 0 \$\{W\} \$\{H\}`/);
  });
});

describe('console serves the UI', () => {
  let server: http.Server;
  let base = '';
  before(async () => {
    // Static files never touch Flagsmith.
    server = createConsole({ experiments: {} as Experiments, feedUrl: 'http://127.0.0.1:9', snapshotDir: UI, ledgerDir: UI, uiDir: UI });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  test('index, scripts, styles and icon load with the right types', async () => {
    const expect: Record<string, string> = { '/': 'text/html', '/style.css': 'text/css', '/favicon.svg': 'image/svg+xml' };
    for (const f of jsFiles) expect[`/${f}`] = 'text/javascript';
    for (const [path, type] of Object.entries(expect)) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
      assert.ok(res.headers.get('content-type')?.startsWith(type), `${path}: ${res.headers.get('content-type')}`);
      await res.arrayBuffer();
    }
  });

  test('the page gets a token in its meta tag and a CSP', async () => {
    const res = await fetch(`${base}/`);
    const page = await res.text();
    assert.match(page, /<meta name="switchyard-console" content="[\w-]{32}">/);
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  });
});

// ---- format.js -------------------------------------------------------------------------------------------------

const experiment = () => structuredClone(initialState().experiment);
const flag = () => structuredClone(initialState().flag);

describe('format: variants and routing', () => {
  test('variants: control first with the initial value as its release, then each option', () => {
    const v = F.variantList(experiment());
    assert.deepEqual(
      v.map((x: any) => [x.key, x.label, x.color]),
      [['control', 'shop:1.4', '#2563eb'], ['v2', 'shop:1.5', '#16a34a']],
    );
    assert.equal(F.releaseLabel(experiment(), 'v2'), 'shop:1.5');
    assert.deepEqual(F.variantList(null), []);
  });

  test('a running split', () => {
    const r = F.routing(experiment(), flag());
    assert.equal(r.summary, 'rollout 100% · v2 50%');
    assert.deepEqual(r.shares, { control: 50, v2: 50 });
    assert.equal(r.soleKey, null);
    assert.equal(r.mode, 'rollout');
  });

  test('after Ship: drained rollout, environment default on the winner', () => {
    const e = experiment();
    e.status = 'completed';
    e.experiment_rollout!.rollout_percentage = 0;
    e.experiment_rollout!.multivariate_feature_state_values = [{ multivariate_feature_option: 11, percentage_allocation: 100 }];
    const f = flag();
    f.environment_default.variants = [{ id: 11, weight: 100 }];
    const r = F.routing(e, f);
    assert.equal(r.summary, 'environment default → shop:1.5');
    assert.deepEqual(r.shares, { control: 0, v2: 100 });
    assert.equal(r.soleKey, 'v2');
  });

  test('after Revert: every variant weight 0, so everyone gets control', () => {
    const e = experiment();
    e.experiment_rollout!.multivariate_feature_state_values = [{ multivariate_feature_option: 11, percentage_allocation: 0 }];
    const r = F.routing(e, flag());
    assert.equal(r.summary, 'rollout 100% · v2 0% → everyone on shop:1.4');
    assert.equal(r.soleKey, 'control');
  });

  test('a partial rollout mentions where everyone else goes', () => {
    const e = experiment();
    e.experiment_rollout!.rollout_percentage = 20;
    const r = F.routing(e, flag());
    assert.equal(r.summary, 'rollout 20% · v2 50% · others → shop:1.4');
    assert.deepEqual(r.shares, { control: 90, v2: 10 });
  });

  test('a disabled flag routes to control, as the proxy does', () => {
    const e = experiment();
    e.experiment_rollout = null;
    const f = flag();
    f.environment_default.enabled = false;
    f.environment_default.variants = [{ id: 11, weight: 100 }];
    const r = F.routing(e, f);
    assert.equal(r.summary, 'environment default → shop:1.4');
    assert.equal(r.flagEnabled, false);
  });
});

describe('format: numbers', () => {
  test('percentages, lift and intervals use signed, typographic minus', () => {
    assert.equal(F.formatPercent(0.1), '10.0%');
    assert.equal(F.formatLift(0.3), '+30.0%');
    assert.equal(F.formatLift(-0.02), '−2.0%');
    assert.equal(F.formatLift(0), '0.0%');
    assert.equal(F.formatInterval(-0.02, 0.62), '−2.0% to +62.0%');
    assert.equal(F.formatLift(null), '—');
  });

  test('chance to win never claims certainty', () => {
    assert.equal(F.formatChance(0.967), '96.7%');
    assert.equal(F.formatChance(0.9999), '>99.9%');
    assert.equal(F.formatChance(0.0001), '<0.1%');
    assert.equal(F.formatChance(undefined), '—');
  });

  test('per-variant value is sum / n, formatted by aggregation', () => {
    assert.equal(F.metricValue({ n: 1000, sum: 130, sum_squares: 130 }), 0.13);
    assert.equal(F.metricValue({ n: 0, sum: 0, sum_squares: 0 }), null);
    assert.equal(F.formatMetricValue(0.13, 'occurrence', 'order_placed'), '13.0%');
    assert.equal(F.formatMetricValue(182, 'mean', 'doc_latency_ms'), '182 ms');
    assert.equal(F.formatMetricValue(0.0123, 'mean', 'server_error'), '1.23%');
    assert.equal(F.formatMetricValue(3.5, 'count', 'items'), '3.50');
    assert.equal(F.formatMetricValue(null, 'mean', 'x'), '—');
    // Flagsmith averages over every exposed identity (no event counts as 0); the label says so.
    assert.equal(F.aggregationLabel('mean'), 'mean per exposed identity');
    assert.equal(F.aggregationLabel('occurrence'), 'occurrence');
    assert.equal(F.formatInt(1234567), '1,234,567');
  });
});

describe('format: wording', () => {
  test("verdicts use Flagsmith's thresholds: >95% winning, <5% losing", () => {
    assert.equal(F.verdict(0.951).word, 'winning');
    assert.equal(F.verdict(0.95).word, 'inconclusive');
    assert.equal(F.verdict(0.5).word, 'inconclusive');
    assert.equal(F.verdict(0.05).word, 'inconclusive');
    assert.equal(F.verdict(0.049).word, 'losing');
    assert.equal(F.verdict(null).word, 'collecting data');
  });

  test('a metric with inference is ready, with values and lift as returned', () => {
    const e = experiment();
    const m = F.assessMetric(e, e.metrics[0], initialState().results, 0);
    assert.equal(m.state, 'ready');
    assert.equal(m.role, 'goal');
    assert.equal(m.direction, 'higher is better');
    assert.deepEqual(m.rows.map((r: any) => [r.key, r.display, r.n]), [['control', '10.0%', 1000], ['v2', '13.0%', 1000]]);
    const [t] = m.treatments;
    assert.equal(t.key, 'v2');
    assert.equal(t.verdict.word, 'winning');
    assert.equal(F.formatLift(t.lift), '+30.0%');
  });

  test('a missing metric or null inference is collecting data', () => {
    const e = experiment();
    const m = F.assessMetric(e, e.metrics[1], initialState().results, 1);
    assert.equal(m.state, 'collecting');
    assert.equal(m.note, 'Collecting data');
    assert.equal(m.role, 'guardrail');
    assert.equal(m.direction, 'lower is better');
    assert.equal(F.assessMetric(e, e.metrics[0], null, 0).state, 'collecting');
    const results = initialState().results!;
    results.payload!.metrics[0]!.inference = { v2: null };
    assert.equal(F.assessMetric(e, e.metrics[0], results, 0).state, 'collecting');
  });

  test('a mean guardrail at 0 in every release reads "no errors", not "collecting data"', () => {
    const e = experiment();
    const def = { metric: 3, metric_name: 'server_error', aggregation: 'mean', direction: 'down', expected_direction: 'not_increase' };
    const results = initialState().results!;
    results.payload!.metrics.push({
      metric_id: 3,
      variants: { control: { n: 500, sum: 0, sum_squares: 0 }, v2: { n: 480, sum: 0, sum_squares: 0 } },
      inference: { v2: null },
    });
    const m = F.assessMetric(e, def, results, 2);
    assert.equal(m.state, 'no-events');
    assert.equal(m.note, 'No errors in either release');
    assert.equal(F.noEventsText('doc_latency_ms', 3), 'No doc_latency_ms recorded in any release');
    // Not all zero, or no data in one release: not "no errors".
    assert.equal(F.isAllZero(def, { variants: { control: { n: 500, sum: 1 }, v2: { n: 480, sum: 0 } } }, ['control', 'v2']), false);
    assert.equal(F.isAllZero(def, { variants: { control: { n: 500, sum: 0 } } }, ['control', 'v2']), false);
    assert.equal(F.isAllZero({ ...def, aggregation: 'occurrence' }, results.payload!.metrics[1], ['control', 'v2']), false);
    // Both releases reported with no events at all: still "no errors", not "collecting data".
    const empty = { metric_id: 3, variants: { control: { n: 0, sum: 0, sum_squares: 0 }, v2: { n: 0, sum: 0, sum_squares: 0 } }, inference: { v2: null } };
    const r2 = initialState().results!;
    r2.payload!.metrics.push(empty);
    assert.equal(F.assessMetric(e, def, r2, 2).note, 'No errors in either release');
  });

  test('losing guardrails, ledger decisions, sidings and the swing-back', () => {
    assert.equal(F.guardrailWarningText('v2', { metric: 'doc_latency_ms', chanceToWin: 0.0001, lift: 0.4 }), 'v2 is losing on doc_latency_ms: 0.0% chance to win');
    const shipped = { at: '2026-11-17T02:00:00Z', experimentId: 7, decision: 'shipped', variant: 'v2', release: 'shop:1.5' };
    const reverted = { at: '2026-11-12T00:00:00Z', experimentId: 4, decision: 'reverted', variant: 'control', release: 'shop:1.3' };
    assert.equal(F.ledgerDecisionText(shipped), 'shipped v2 (shop:1.5)');
    assert.equal(F.ledgerDecisionText(reverted), 'reverted');
    assert.equal(F.latestEntryFor([shipped, reverted], 7), shipped);
    assert.equal(F.latestEntryFor([], 7), null);

    const history = [
      { id: 7, name: 'current', status: 'completed', started_at: '2026-11-17T00:00:00Z', ended_at: null },
      { id: 4, name: 'older', status: 'completed', started_at: '2026-11-10T00:00:00Z', ended_at: '2026-11-12T00:00:00Z' },
    ];
    const past = F.sidings(history, 7, [shipped, reverted]);
    assert.deepEqual(past.map((p: any) => [p.id, p.name, p.statusLabel, p.decision]), [[4, 'older', 'Completed', 'reverted']]);
    assert.deepEqual(F.sidings(null, 7, []), []);

    const e = experiment();
    assert.equal(F.swingBackText(e, [shipped], 'shop:1.4'), null, 'still running');
    e.status = 'completed';
    assert.equal(F.swingBackText(e, [shipped], 'shop:1.5'), null, 'serves what was shipped');
    assert.equal(F.swingBackText(e, [shipped], 'shop:1.4'), 'Changed in Flagsmith after the ship: everyone now gets shop:1.4');
    assert.equal(F.swingBackText(e, [], 'shop:1.4'), null, 'no decision recorded');
  });

  test('the winner headline is honest about inconclusive leads', () => {
    const e = experiment();
    assert.equal(F.winnerText(e, null).headline, 'No leader yet');
    const win = F.winnerText(e, { key: 'v2', chanceToWin: 0.967, isControl: false });
    assert.equal(win.headline, 'v2 (shop:1.5) is winning');
    assert.equal(win.tone, 'good');
    const lead = F.winnerText(e, { key: 'v2', chanceToWin: 0.71, isControl: false });
    assert.equal(lead.headline, 'v2 (shop:1.5) leads, inconclusive');
    assert.match(lead.detail, /only >95% winning/);
  });

  test('sample-ratio, event counter and refresh refusal', () => {
    assert.equal(F.srmText(initialState().results), 'Sample-ratio check: not computed');
    assert.equal(F.srmText(null), 'Sample-ratio check: not computed');
    assert.equal(F.srmText({ payload: { srm_p_value: 0.4123, metrics: [] } }), 'Sample-ratio check: p = 0.412, as returned');
    assert.equal(F.eventsText({ accepted: 1324, rejected: 2 }), '1,324 accepted · 2 rejected');
    assert.match(F.eventsText(null), /unavailable/);
    assert.equal(F.refreshReason('{"detail":"Request was throttled. Expected available in 120 seconds."}'), 'Request was throttled. Expected available in 120 seconds.');
    assert.equal(F.refreshReason('{"non_field_errors":["Too soon."]}'), 'Too soon.');
    assert.equal(F.refreshReason('plain text'), 'plain text');
    assert.equal(F.refreshReason(''), 'Flagsmith refused the refresh.');
  });

  test('steps, sampling, times and snapshot names', () => {
    assert.equal(F.stepMark('done'), '✓');
    assert.equal(F.stepMark('skipped'), '·');
    assert.equal(F.samplingLabel(100, 100), '');
    assert.equal(F.samplingLabel(300, 100), '1 dot ≈ 3 requests');
    assert.equal(F.samplingLabel(0, 0), '');
    const now = Date.parse('2026-11-17T12:00:00Z');
    assert.equal(F.formatAgo(now - 2_000, now), 'just now');
    assert.equal(F.formatAgo(now - 42_000, now), '42 s ago');
    assert.equal(F.formatAgo(now - 5 * 60_000, now), '5 min ago');
    assert.equal(F.formatAgo(now - 65 * 60_000, now), '1 h 5 min ago');
    assert.equal(F.formatAgo(now - 72 * 3_600_000, now), '3 d ago');
    assert.equal(F.snapshotTime('experiment-7-2026-11-17T02-00-00-000Z.json'), '2026-11-17T02:00:00.000Z');
    assert.equal(F.snapshotTime('notes.json'), null);
    assert.equal(F.statusLabel('completed'), 'Completed');
  });
});

test('control is labelled with the release the rollout serves, not the flag\'s first value', async () => {
  const experiment = {
    name: 'shop_release: shop:1.6 vs shop:1.5',
    feature: { initial_value: 'shop:1.4', multivariate_options: [{ id: 11, key: 'v2', string_value: 'shop:1.7' }] },
    experiment_rollout: { enabled: false, rollout_percentage: 0, feature_state_value: { type: 'string', value: 'shop:1.5' }, multivariate_feature_state_values: [] },
  };
  assert.deepEqual(F.variantList(experiment).map((v: { label: string }) => v.label), ['shop:1.5', 'shop:1.6']);
});

describe('demo controls: send visitors, swing back and forward', () => {
  const app = read('app.js');
  const experiment = (status: string, v2 = 'shop:1.5') => ({
    id: 7,
    status,
    name: 'shop_release: shop:1.5 vs shop:1.4',
    feature: { initial_value: 'shop:1.4', multivariate_options: [{ id: 11, key: 'v2', string_value: v2 }] },
    experiment_rollout: { enabled: true, rollout_percentage: 0, feature_state_value: { type: 'string', value: 'shop:1.4' }, multivariate_feature_state_values: [] },
  });
  const shipped = [{ experimentId: 7, decision: 'shipped', variant: 'v2', release: 'shop:1.5', replaced: 'shop:1.4', at: '2026-11-17T10:00:00Z' }];

  test('the card, its controls and its live status are in index.html, hidden until the console answers', () => {
    for (const id of ['demo', 'visitors-form', 'visitors-count', 'visitors-btn', 'visitors-note', 'swing-back-btn', 'swing-forward-btn', 'swing-note', 'demo-progress', 'demo-status']) {
      assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
    }
    assert.match(html, /<section class="card demo-card" id="demo" aria-labelledby="demo-title" hidden>/);
    assert.match(html, /id="visitors-count"[^>]*type="number" min="50" max="3000"/);
    assert.match(html, /id="demo-status"[^>]*aria-live="polite"/);
    assert.match(read('style.css'), /"demo results"/);
  });

  test("app.js runs the console's judge jobs and follows them on GET /api/judge/job", () => {
    assert.match(app, /api\('\/api\/judge\/run', \{/);
    assert.match(app, /api\('\/api\/judge\/job'/);
    assert.match(app, /runDemo\('visitors', \{ visitors: n \}\)/);
    assert.match(app, /runDemo\('swing-back', \{ experimentId: app\.state\.experiment\.id \}\)/);
    assert.match(app, /runDemo\('swing-forward', \{ experimentId: app\.state\.experiment\.id \}\)/);
    assert.match(app, /if \(res\.status === 404\) \{\s*demo\.available = false;/, 'no judge options: the card stays hidden');
    assert.match(app, /const busy = app\.busy \|\| demoRunning\(\);/, 'Ship and Revert wait for a running job');
  });

  test('the visitor count is clamped to what the console accepts', () => {
    assert.equal(F.visitorCount('500'), 500);
    assert.equal(F.visitorCount('10'), 50);
    assert.equal(F.visitorCount('99999'), 3000);
    assert.equal(F.visitorCount('1234.6'), 1235);
    assert.equal(F.visitorCount(''), 1500);
    assert.equal(F.visitorCount('lots'), 1500);
  });

  test('visitors only while the experiment runs', () => {
    assert.equal(F.visitorsView(experiment('running')).enabled, true);
    assert.match(F.visitorsView(experiment('running')).note, /Simulated, labelled visitors/);
    assert.equal(F.visitorsView(experiment('completed')).enabled, false);
    assert.match(F.visitorsView(experiment('completed')).note, /Release the next version/);
    assert.equal(F.visitorsView(experiment('paused')).enabled, false);
  });

  test('swing only after shipping a new release, suggesting the edit that changes something', () => {
    const on = F.swingView(experiment('completed'), shipped, 'shop:1.5');
    assert.equal(on.enabled, true);
    assert.equal(on.back, 'shop:1.4');
    assert.equal(on.forward, 'shop:1.5');
    assert.equal(on.suggested, 'back');
    assert.match(on.note, /one edit to the flag's environment default in Flagsmith/);
    assert.equal(F.swingView(experiment('completed'), shipped, 'shop:1.4').suggested, 'forward');

    assert.equal(F.swingView(experiment('running'), shipped, 'shop:1.4').enabled, false);
    assert.match(F.swingView(experiment('completed'), [], 'shop:1.4').note, /no Switchyard decision/);
    const reverted = [{ ...shipped[0], decision: 'reverted', variant: 'control', release: 'shop:1.4' }];
    assert.match(F.swingView(experiment('completed'), reverted, 'shop:1.4').note, /was reverted/);
    const previewed = F.swingView(experiment('completed', 'shop:1.6'), shipped, 'shop:1.5');
    assert.equal(previewed.enabled, false, 'v2 now holds the preview: the console refuses this swing');
    assert.match(previewed.note, /now serves shop:1\.6 for the preview/);
  });

  test("a job's outcome in one line", () => {
    assert.equal(F.demoJobText(null), '');
    assert.equal(F.demoJobText({ action: 'visitors', status: 'running', progress: { done: 250, total: 1500 }, stages: [] }), 'Sending simulated visitors: 250 of 1,500…');
    assert.equal(F.demoJobText({ action: 'swing-back', status: 'running', stages: [{ title: "Edit the flag's default in Flagsmith", status: 'running' }] }), "Edit the flag's default in Flagsmith…");
    assert.match(F.demoJobText({ action: 'visitors', status: 'done', result: { visitors: 1500 } }), /^Sent 1,500 simulated visitors\./);
    assert.equal(F.demoJobText({ action: 'swing-back', status: 'done', result: { matched: true, served: 'shop:1.4' } }), 'Swung back: Flagsmith saved the flag and a new visitor now gets shop:1.4.');
    assert.match(F.demoJobText({ action: 'swing-forward', status: 'done', result: { matched: false, served: 'shop:1.4' } }), /still served shop:1\.4 after 10 s/);
    assert.equal(F.demoJobText({ action: 'visitors', status: 'failed', error: 'no token' }), 'Stopped: no token.');
  });
});
