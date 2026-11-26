import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { decide, describeResults, keepRunning, LosingGuardrailsError } from '../src/decide.ts';
import { AdminClient } from '../src/flagsmith/admin.ts';
import { Experiments } from '../src/flagsmith/experiments.ts';
import { readLedger } from '../src/ledger.ts';
import { ENV, initialState, startFakeFlagsmith, type FakeState } from './fake-flagsmith.ts';

async function setup(state: FakeState) {
  const fake = await startFakeFlagsmith(state);
  const exp = new Experiments(new AdminClient(fake.apiUrl, { apiKey: 'test' }), { envKey: ENV, experimentId: state.experiment.id });
  return { fake, exp, snapshotDir: mkdtempSync(join(tmpdir(), 'sy-decide-snap-')), ledgerDir: mkdtempSync(join(tmpdir(), 'sy-decide-ledger-')) };
}

const writes = (state: FakeState) => state.requests.filter((r) => !r.startsWith('GET'));

// v2 losing the doc_latency_ms guardrail (chance to win 0.1%).
function withLosingGuardrail(state: FakeState): FakeState {
  state.results!.payload!.metrics.push({
    metric_id: 2,
    variants: { control: { n: 1000, sum: 15000, sum_squares: 0 }, v2: { n: 1000, sum: 83000, sum_squares: 0 } },
    inference: { v2: { lift: 4.5, ci_low: 4, ci_high: 5, chance_to_win: 0.001 } },
  });
  return state;
}

// A stand-in for GitHub's REST API: answers by "METHOD path", records each call.
function fakeGitHubFetch(answers: Record<string, { status: number; body: unknown }>) {
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    calls.push(key);
    const a = answers[key] ?? { status: 404, body: { message: 'Not Found' } };
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('decide', () => {
  test('ship: runs the steps, then records the decision with the snapshot it wrote', async () => {
    const state = initialState();
    const { fake, exp, snapshotDir, ledgerDir } = await setup(state);
    const steps: string[] = [];
    const d = await decide({ experiments: exp, action: 'ship', winner: 'v2', snapshotDir, ledgerDir, onStep: (s) => steps.push(s.status) });
    fake.close();

    assert.equal(state.experiment.status, 'completed');
    assert.deepEqual(steps, ['done', 'done', 'done', 'done', 'done']);
    assert.equal(d.github, null, 'no token, no GitHub call');
    assert.equal(d.entry.decision, 'shipped');
    assert.equal(d.entry.variant, 'v2');
    assert.equal(d.entry.release, 'shop:1.5');
    assert.equal(d.entry.replaced, 'shop:1.4');
    assert.equal(d.entry.by, undefined, 'a person decided');
    assert.deepEqual(d.entry.losingGuardrailsAccepted, []);

    assert.ok(d.entry.snapshot, 'the snapshot path is in the entry');
    assert.ok(!d.entry.snapshot.includes('\\'), 'written with forward slashes');
    assert.ok(existsSync(d.entry.snapshot));
    assert.equal(JSON.parse(readFileSync(d.entry.snapshot, 'utf8')).decision, 'v2');
    assert.deepEqual(readLedger(ledgerDir), [d.entry]);
    assert.ok(readFileSync(join(ledgerDir, 'RELEASES.md'), 'utf8').includes(`- Decision snapshot: \`${d.entry.snapshot}\``));
  });

  test('a losing guardrail stops the decision before anything moves, unless accepted', async () => {
    const state = withLosingGuardrail(initialState());
    const { fake, exp, snapshotDir, ledgerDir } = await setup(state);
    const err = await decide({ experiments: exp, action: 'ship', winner: 'v2', snapshotDir, ledgerDir }).catch((e: unknown) => e);
    assert.ok(err instanceof LosingGuardrailsError);
    assert.deepEqual(err.warnings, [{ metric: 'doc_latency_ms', chanceToWin: 0.001, lift: 4.5 }]);
    assert.match(err.message, /v2 is losing on doc_latency_ms \(0\.1% chance to win\)/);
    assert.deepEqual(writes(state), []);
    assert.deepEqual(readLedger(ledgerDir), []);

    const d = await decide({ experiments: exp, action: 'ship', winner: 'v2', acceptLosingGuardrails: true, snapshotDir, ledgerDir });
    fake.close();
    assert.deepEqual(d.entry.losingGuardrailsAccepted, [{ metric: 'doc_latency_ms', chanceToWin: 0.001, lift: 4.5 }]);
    assert.match(readFileSync(join(ledgerDir, 'RELEASES.md'), 'utf8'), /Shipped despite losing guardrails: doc_latency_ms/);
  });

  test("revert by the guard: control needs no acceptance, and the entry says it was the guard and why", async () => {
    const state = withLosingGuardrail(initialState());
    const { fake, exp, snapshotDir, ledgerDir } = await setup(state);
    const d = await decide({ experiments: exp, action: 'revert', snapshotDir, ledgerDir, by: 'guard', guardReason: 'shop:1.5 losing doc_latency_ms, 0.1% chance to win' });
    fake.close();
    assert.equal(d.entry.decision, 'reverted');
    assert.equal(d.entry.variant, 'control');
    assert.equal(d.entry.release, 'shop:1.4');
    assert.equal(d.entry.by, 'guard');
    assert.equal(d.entry.guardReason, 'shop:1.5 losing doc_latency_ms, 0.1% chance to win');
    assert.deepEqual(d.entry.losingGuardrailsAccepted, [], 'control never warns');
    assert.equal(state.experiment.status, 'completed');
    assert.match(readFileSync(join(ledgerDir, 'RELEASES.md'), 'utf8'), /automatically by Turnout's guard \(shop:1\.5 losing doc_latency_ms/);
  });

  test("revert records control's release even when the default's value was edited mid-experiment", async () => {
    const state = initialState();
    state.flag.environment_default.value = { type: 'string', value: 'shop:9.9' };
    const { fake, exp, snapshotDir, ledgerDir } = await setup(state);
    const d = await decide({ experiments: exp, action: 'revert', snapshotDir, ledgerDir });
    fake.close();
    assert.equal(d.entry.release, 'shop:1.4');
    assert.equal(state.flag.environment_default.value.value, 'shop:1.4', 'and the flag serves it');
  });

  test('a ship without a winner is refused', async () => {
    const state = initialState();
    const { fake, exp, snapshotDir, ledgerDir } = await setup(state);
    await assert.rejects(decide({ experiments: exp, action: 'ship', snapshotDir, ledgerDir }), /winner is required/);
    fake.close();
    assert.deepEqual(writes(state), []);
  });

  test('writes the GitHub Release for the new release, tagged from its label', async () => {
    const state = initialState();
    const { fake, exp, snapshotDir, ledgerDir } = await setup(state);
    const gh = fakeGitHubFetch({ 'POST /repos/o/r/releases': { status: 201, body: { id: 1, html_url: 'https://gh/r/1' } } });
    const d = await decide({ experiments: exp, action: 'ship', winner: 'v2', snapshotDir, ledgerDir, github: { token: 't', repository: 'o/r', fetch: gh.fetch } });
    fake.close();
    assert.deepEqual(d.github, { url: 'https://gh/r/1' });
    assert.deepEqual(gh.calls, ['GET /repos/o/r/releases/tags/v1.5', 'POST /repos/o/r/releases']);
  });

  test('an option without a key (Variant_1) still tags the new release, not control\'s', async () => {
    const state = initialState();
    state.experiment.feature.multivariate_options[0]!.key = null;
    const { fake, exp, snapshotDir, ledgerDir } = await setup(state);
    const gh = fakeGitHubFetch({ 'POST /repos/o/r/releases': { status: 201, body: { id: 1, html_url: 'https://gh/r/1' } } });
    const d = await decide({ experiments: exp, action: 'revert', snapshotDir, ledgerDir, github: { token: 't', repository: 'o/r', fetch: gh.fetch } });
    fake.close();
    assert.deepEqual(d.github, { url: 'https://gh/r/1' });
    assert.deepEqual(gh.calls, ['GET /repos/o/r/releases/tags/v1.5', 'POST /repos/o/r/releases'], 'shop:1.5, not v1.4');
  });

  test('a GitHub failure is reported, not thrown: the flag already moved and the ledger has the record', async () => {
    const state = initialState();
    const { fake, exp, snapshotDir, ledgerDir } = await setup(state);
    const gh = fakeGitHubFetch({ 'GET /repos/o/r/releases/tags/v1.5': { status: 500, body: { message: 'Server Error' } } });
    const d = await decide({ experiments: exp, action: 'revert', snapshotDir, ledgerDir, github: { token: 't', repository: 'o/r', fetch: gh.fetch } });
    fake.close();
    assert.deepEqual(d.github, { error: 'GitHub: 500 Server Error' });
    assert.equal(state.experiment.status, 'completed');
    assert.equal(readLedger(ledgerDir).length, 1);
  });
});

describe('describeResults', () => {
  test("labels a Mean metric's figures as per exposed identity", () => {
    const state = withLosingGuardrail(initialState());
    const lines = describeResults(state.experiment, state.results);
    assert.ok(lines.includes('  order_placed (occurrence, up): control 0.100 (n=1000), v2 0.130 (n=1000)'));
    assert.ok(lines.includes('  doc_latency_ms (mean per exposed identity, down): control 15.0 (n=1000), v2 83.0 (n=1000)'));
  });

  test('says when there are no results yet', () => {
    const state = initialState();
    assert.deepEqual(describeResults(state.experiment, null).slice(2), ['Flagsmith results: not computed yet ("Collecting data")']);
  });
});

describe('keepRunning', () => {
  test('writes nothing to Flagsmith; records the reason and the interval in the ledger', async () => {
    const state = initialState();
    const { fake, exp, ledgerDir } = await setup(state);
    const entry = await keepRunning({ experiments: exp, ledgerDir });
    fake.close();
    assert.deepEqual(writes(state), []);
    assert.equal(state.experiment.status, 'running');
    assert.equal(entry.decision, 'kept-running');
    assert.equal(entry.reason, 'interval −2% to +62% crosses zero');
    assert.deepEqual(entry.interval, { low: -0.02, high: 0.62 });
    assert.equal(readLedger(ledgerDir)[0]!.decision, 'kept-running');
    assert.match(readFileSync(join(ledgerDir, 'RELEASES.md'), 'utf8'), /Kept running: interval −2% to \+62% crosses zero/);
  });

  test('refuses a completed experiment', async () => {
    const state = initialState();
    state.experiment.status = 'completed';
    const { fake, exp, ledgerDir } = await setup(state);
    await assert.rejects(keepRunning({ experiments: exp, ledgerDir }), /already decided/);
    fake.close();
  });
});
