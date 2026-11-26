// The CLI's status, ship and revert (src/commands/ship.ts), against the fake Flagsmith, with the prompt and the
// log injected.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { revert, ship, status } from '../src/commands/ship.ts';
import { AdminClient } from '../src/flagsmith/admin.ts';
import { Experiments } from '../src/flagsmith/experiments.ts';
import { readLedger } from '../src/ledger.ts';
import { ENV, initialState, startFakeFlagsmith, type FakeState } from './fake-flagsmith.ts';

async function setup(state: FakeState, answers: boolean[] = []) {
  const fake = await startFakeFlagsmith(state);
  const experiments = new Experiments(new AdminClient(fake.apiUrl, { apiKey: 'test' }), { envKey: ENV, experimentId: state.experiment.id });
  const lines: string[] = [];
  const questions: string[] = [];
  return {
    fake,
    lines,
    questions,
    opts: {
      experiments,
      snapshotDir: mkdtempSync(join(tmpdir(), 'sy-ship-snap-')),
      ledgerDir: mkdtempSync(join(tmpdir(), 'sy-ship-ledger-')),
      log: (line: string) => lines.push(line),
      confirm: async (question: string) => {
        questions.push(question);
        const answer = answers.shift();
        if (answer === undefined) throw new Error(`unexpected question: ${question}`);
        return answer;
      },
    },
  };
}

const writes = (state: FakeState) => state.requests.filter((r) => !r.startsWith('GET'));

function withLosingGuardrail(state: FakeState): FakeState {
  state.results!.payload!.metrics.push({
    metric_id: 2,
    variants: { control: { n: 1000, sum: 15000, sum_squares: 0 }, v2: { n: 1000, sum: 83000, sum_squares: 0 } },
    inference: { v2: { lift: 4.5, ci_low: 4, ci_high: 5, chance_to_win: 0.001 } },
  });
  return state;
}

describe('status', () => {
  test("prints Flagsmith's results, the results page's winner and any losing guardrail", async () => {
    const state = withLosingGuardrail(initialState());
    const { fake, lines, opts } = await setup(state);
    await status(opts);
    fake.close();
    assert.ok(lines.includes("Flagsmith's results page would show: winning variation v2 (96.7% chance to be best)"));
    assert.ok(lines.some((l) => l.includes('Guardrail: v2 is losing on doc_latency_ms (0.1% chance to win)')));
    assert.deepEqual(writes(state), []);
  });

  test('--refresh asks Flagsmith to recompute', async () => {
    const state = initialState();
    const { fake, lines, opts } = await setup(state);
    await status({ ...opts, refresh: true });
    fake.close();
    assert.equal(lines[0], 'Requested a results refresh (computed in the background).');
    assert.deepEqual(writes(state), [`POST /api/v1/environments/${ENV}/experiments/7/results/refresh/`]);
  });

  for (const code of [429, 400]) {
    test(`--refresh reports a ${code} and still prints the results`, async () => {
      const state = initialState();
      state.refreshAnswer = { status: code, body: { detail: 'Results can be refreshed once every 5 minutes.' } };
      const { fake, lines, opts } = await setup(state);
      await status({ ...opts, refresh: true });
      fake.close();
      assert.equal(lines[0], 'Refresh not allowed yet: {"detail":"Results can be refreshed once every 5 minutes."}');
      assert.ok(lines.some((l) => l.startsWith("Flagsmith's results page would show")));
    });
  }

  test('--refresh lets any other error through', async () => {
    const state = initialState();
    state.refreshAnswer = { status: 403, body: { detail: 'no' } };
    const { fake, opts } = await setup(state);
    await assert.rejects(status({ ...opts, refresh: true }), /403/);
    fake.close();
  });
});

describe('ship', () => {
  test("--yes ships the results page's winner and records it", async () => {
    const state = initialState();
    const { fake, lines, questions, opts } = await setup(state);
    await ship({ ...opts, yes: true });
    fake.close();
    assert.deepEqual(questions, []);
    assert.equal(state.experiment.status, 'completed');
    assert.ok(lines.includes("\nShipping v2, the variation Flagsmith's results page shows as winning (96.7%)."));
    assert.ok(lines.some((l) => l.startsWith('Decision snapshot: ')));
    assert.ok(lines.some((l) => l.includes('Everyone now gets v2')));
    const [entry] = readLedger(opts.ledgerDir);
    assert.equal(entry?.variant, 'v2');
    assert.ok(entry?.snapshot && existsSync(entry.snapshot));
  });

  test('asks before shipping; a declined confirm changes nothing', async () => {
    const state = initialState();
    const { fake, lines, questions, opts } = await setup(state, [false]);
    await ship(opts);
    fake.close();
    assert.deepEqual(questions, ['Ship it?']);
    assert.equal(lines.at(-1), 'Nothing changed.');
    assert.deepEqual(writes(state), []);
    assert.deepEqual(readLedger(opts.ledgerDir), []);
  });

  test('--yes refuses a losing guardrail without --accept-losing-guardrails', async () => {
    const state = withLosingGuardrail(initialState());
    const { fake, questions, opts } = await setup(state);
    await assert.rejects(ship({ ...opts, yes: true }), /--accept-losing-guardrails/);
    fake.close();
    assert.deepEqual(questions, []);
    assert.deepEqual(writes(state), []);
  });

  test('--yes --accept-losing-guardrails ships and records the accepted guardrail', async () => {
    const state = withLosingGuardrail(initialState());
    const { fake, opts } = await setup(state);
    await ship({ ...opts, yes: true, acceptLosingGuardrails: true });
    fake.close();
    assert.equal(state.experiment.status, 'completed');
    assert.deepEqual(readLedger(opts.ledgerDir)[0]?.losingGuardrailsAccepted, [{ metric: 'doc_latency_ms', chanceToWin: 0.001, lift: 4.5 }]);
  });

  test('without --yes, a losing guardrail asks first; declining points at revert and changes nothing', async () => {
    const state = withLosingGuardrail(initialState());
    const { fake, lines, questions, opts } = await setup(state, [false]);
    await ship(opts);
    fake.close();
    assert.equal(questions.length, 1);
    assert.match(questions[0]!, /Ship v2 even though it's losing on doc_latency_ms\?/);
    assert.equal(lines.at(-1), 'Nothing changed. To send everyone back to control instead: switchyard revert');
    assert.deepEqual(writes(state), []);
  });

  test('without --yes, accepting the losing guardrail still asks to confirm the plan', async () => {
    const state = withLosingGuardrail(initialState());
    const { fake, questions, opts } = await setup(state, [true, true]);
    await ship(opts);
    fake.close();
    assert.equal(questions[1], 'Ship it?');
    assert.equal(readLedger(opts.ledgerDir)[0]?.losingGuardrailsAccepted.length, 1);
  });

  test('--winner with a variant the flag does not have is refused before anything moves', async () => {
    const state = initialState();
    const { fake, lines, opts } = await setup(state);
    await assert.rejects(ship({ ...opts, yes: true, winner: 'v9' }), /"v9" is not a variant of shop_release \(control, v2\)/);
    fake.close();
    assert.ok(lines.includes("\nShipping v9 (chosen by you; Flagsmith's results page leans v2)."));
    assert.deepEqual(writes(state), []);
  });

  test('--winner control overrides the results page', async () => {
    const state = initialState();
    const { fake, opts } = await setup(state);
    await ship({ ...opts, yes: true, winner: 'control' });
    fake.close();
    assert.deepEqual(state.flag.environment_default.variants, [{ id: 11, weight: 0 }]);
    assert.equal(readLedger(opts.ledgerDir)[0]?.decision, 'shipped');
  });

  test('with no result to pick from, asks for --winner', async () => {
    const state = initialState();
    state.results = null;
    const { fake, opts } = await setup(state);
    await assert.rejects(ship({ ...opts, yes: true }), /Pass --winner <variant>/);
    fake.close();
    assert.deepEqual(writes(state), []);
  });
});

describe('revert', () => {
  test('goes ahead even while v2 is losing a guardrail: control needs no acceptance', async () => {
    const state = withLosingGuardrail(initialState());
    const { fake, lines, questions, opts } = await setup(state, [true]);
    await revert(opts);
    fake.close();
    assert.deepEqual(questions, ['Revert everyone to control?']);
    assert.ok(lines.some((l) => l.includes('Everyone now gets control')));
    const [entry] = readLedger(opts.ledgerDir);
    assert.equal(entry?.decision, 'reverted');
    assert.deepEqual(entry?.losingGuardrailsAccepted, []);
    assert.equal(entry?.by, undefined);
  });

  test('a declined confirm changes nothing', async () => {
    const state = initialState();
    const { fake, opts } = await setup(state, [false]);
    await revert(opts);
    fake.close();
    assert.deepEqual(writes(state), []);
  });

  test('refuses a completed experiment', async () => {
    const state = initialState();
    state.experiment.status = 'completed';
    const { fake, opts } = await setup(state);
    await assert.rejects(revert({ ...opts, yes: true }), /completed/);
    fake.close();
  });
});
