import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { autopilotFromEnv, createAutopilot, planNext, type JudgeLike } from '../src/console/autopilot.ts';
import type { Job, JudgeAction, JudgeState, StepId } from '../src/console/judge.ts';

const T0 = Date.parse('2026-11-23T10:00:00Z');

function state(current: StepId | 'reset', extra: Partial<JudgeState> = {}): JudgeState {
  return {
    simulated: true,
    dashboardUrl: '',
    links: { experiment: null, flag: null, shop: '', preview: null },
    releases: ['shop:1.4', 'shop:1.5', 'shop:1.6'],
    live: 'shop:1.4',
    next: 'shop:1.6',
    experiment: { id: 7, name: 'x', hypothesis: '', status: 'running', control: 'shop:1.4', v2: 'shop:1.5', startedAt: null, endedAt: null },
    results: null,
    ledger: [],
    preview: { active: false, release: null },
    routing: null,
    steps: [],
    current,
    job: null,
    totals: { visitorsSent: 0, eventsAccepted: null, eventsRejected: null },
    ...extra,
  };
}

const results = (call: 'ship' | 'revert' | 'keep-running', o: { losing?: boolean; winner?: boolean; refreshAllowedAt?: string | null } = {}) => ({
  asOf: null,
  refreshAllowedAt: o.refreshAllowedAt ?? null,
  metrics: [],
  winner: o.winner === false ? null : { key: 'v2', release: 'shop:1.5', chanceToWin: 0.97 },
  losingGuardrails: o.losing ? [{ metric: 'page_load_ms', chanceToWin: 0.01 }] : [],
  recommendation: { call, reason: 'r', variant: 'v2', interval: null, chanceToWin: 0.97 },
}) as unknown as JudgeState['results'];

describe('planNext: the step judge mode says is current, and Turnout’s recommendation for the decision', () => {
  test('each step maps to its job', () => {
    assert.equal(planNext(state('visitors')).action, 'visitors');
    assert.equal(planNext(state('verify')).action, 'verify');
    assert.equal(planNext(state('preview')).action, 'preview');
    assert.equal(planNext(state('release')).action, 'release');
    const end = planNext(state('reset'));
    assert.equal(end.action, 'reset');
    assert.equal(end.end, true);
    assert.equal(planNext(state('visitors', { experiment: null })).action, 'reset');
  });

  test("score waits for Flagsmith's refresh window", () => {
    const p = planNext(state('score', { results: results('keep-running', { refreshAllowedAt: '2026-11-23T10:05:00Z' }) }));
    assert.equal(p.action, 'score');
    assert.equal(p.notBefore, Date.parse('2026-11-23T10:05:00Z'));
  });

  test('decide follows the recommendation; a losing guardrail reverts; endless keep-running ends on Flagsmith’s pick', () => {
    assert.equal(planNext(state('decide', { results: results('ship') })).action, 'ship');
    assert.equal(planNext(state('decide', { results: results('revert') })).action, 'revert');
    assert.equal(planNext(state('decide', { results: results('keep-running') })).action, 'keep-running');
    assert.equal(planNext(state('decide', { results: results('ship', { losing: true }) })).action, 'revert');
    assert.equal(planNext(state('decide', { results: results('ship', { winner: false }) })).action, 'keep-running');
    assert.equal(planNext(state('decide', { results: results('keep-running') }), { keptRunning: 3 }).action, 'ship');
    assert.equal(planNext(state('decide', { results: results('keep-running', { winner: false }) }), { keptRunning: 3 }).action, 'revert');
  });
});

// A fake judge: a small story machine whose jobs finish after `jobMs` of fake time.
function fakeJudge(clock: { t: number }, o: { refreshEveryMs?: number; jobMs?: number } = {}) {
  const ran: { action: JudgeAction; at: number; visitors?: number }[] = [];
  let current: StepId | 'reset' = 'visitors';
  let refreshAt = 0;
  let job: Job | null = null;
  let n = 0;
  const after: Partial<Record<JudgeAction, StepId | 'reset'>> = {
    visitors: 'score', score: 'decide', ship: 'verify', revert: 'verify', 'keep-running': 'visitors', verify: 'preview', preview: 'release', release: 'visitors', reset: 'visitors',
  };
  let round = 0;
  const judge: JudgeLike & { ran: typeof ran } = {
    ran,
    async state() {
      if (job && job.status === 'running' && clock.t >= Date.parse(job.startedAt) + (o.jobMs ?? 5000)) {
        job.status = 'done';
        const a = job.action;
        if (a === 'score') refreshAt = clock.t + (o.refreshEveryMs ?? 300_000);
        if (a === 'release') round = 1;
        if (a === 'reset') round = 0;
        current = a === 'verify' && round === 1 ? 'reset' : (after[a] ?? current);
        if (a === 'visitors' && current === 'score') current = 'score';
      }
      return state(current, {
        results: results(round === 1 ? 'ship' : 'ship', { losing: round === 1, refreshAllowedAt: refreshAt > clock.t ? new Date(refreshAt).toISOString() : null }),
        job,
      });
    },
    async run(body) {
      const b = body as { action: JudgeAction; visitors?: number };
      if (job?.status === 'running') return { status: 409, body: { error: 'busy' } };
      ran.push({ action: b.action, at: clock.t, ...(b.visitors ? { visitors: b.visitors } : {}) });
      job = { id: `j${++n}`, action: b.action, status: 'running', startedAt: new Date(clock.t).toISOString() } as Job;
      return { status: 202, body: { job } };
    },
    job() {
      if (job && job.status === 'running' && clock.t >= Date.parse(job.startedAt) + (o.jobMs ?? 5000)) void judge.state();
      return job;
    },
  };
  return judge;
}

// A fake sleep: moves the clock, and yields to the event loop so the test's own loop gets a turn.
const tick = (clock: { t: number }) => (ms: number) => {
  clock.t += ms;
  return new Promise<void>((r) => setImmediate(r));
};

async function drive(ap: ReturnType<typeof createAutopilot>, until: () => boolean, clock: { t: number }, limit = 200_000) {
  ap.start();
  for (let i = 0; i < limit && !until(); i++) await new Promise((r) => setImmediate(r));
  const stopped = ap.stop();
  clock.t += 1; // let a pending fake sleep resolve
  await stopped;
}

describe('the autopilot loop (fake judge, fake clock)', () => {
  test('runs the whole story, follows the recommendation, waits out the refresh window, then resets and starts again', async () => {
    const clock = { t: T0 };
    const judge = fakeJudge(clock);
    const lock = { busy: false };
    const sleep = tick(clock);
    const ap = createAutopilot(judge, lock, { sleep, now: () => clock.t, pauseMs: 20_000, endPauseMs: 60_000, ambientVisitors: 0 });
    await drive(ap, () => judge.ran.filter((r) => r.action === 'reset').length >= 1 && judge.ran.at(-1)?.action === 'visitors', clock);
    const actions = judge.ran.map((r) => r.action);
    assert.deepEqual(actions.slice(0, 12), ['visitors', 'score', 'ship', 'verify', 'preview', 'release', 'visitors', 'score', 'revert', 'verify', 'reset', 'visitors']);
    // Never two steps without the pause between them.
    for (let i = 1; i < judge.ran.length; i++) assert.ok(judge.ran[i]!.at - judge.ran[i - 1]!.at >= 20_000 + 5000, `${actions[i]} came too soon`);
    // The second score waited for Flagsmith's 5-minute window after the first.
    const scores = judge.ran.filter((r) => r.action === 'score');
    assert.ok(scores[1]!.at - scores[0]!.at >= 300_000, 'respects the refresh limit');
    const reset = judge.ran.find((r) => r.action === 'reset')!;
    const before = judge.ran[judge.ran.indexOf(reset) - 1]!;
    assert.ok(reset.at - before.at >= 60_000, 'a longer pause at the end of the story');
    assert.equal(ap.status().loops >= 1, true);
  });

  test('tops up visitors while the refresh window is closed, so the map keeps moving', async () => {
    const clock = { t: T0 };
    const ran: { action: string; visitors?: number }[] = [];
    let job: Job | null = null;
    const judge: JudgeLike = {
      state: async () => state('score', { results: results('keep-running', { refreshAllowedAt: new Date(T0 + 300_000).toISOString() }) }),
      run: async (body) => {
        ran.push(body as { action: string; visitors?: number });
        job = { id: `j${ran.length}`, action: 'visitors', status: 'done' } as Job;
        return { status: 202, body: { job } };
      },
      job: () => job,
    };
    const ap = createAutopilot(judge, { busy: false }, { sleep: tick(clock), now: () => clock.t, pauseMs: 20_000, ambientVisitors: 120 });
    ap.start();
    for (let i = 0; i < 5000 && !ran.length; i++) await new Promise((r) => setImmediate(r));
    const stopped = ap.stop();
    clock.t += 1;
    await stopped;
    assert.deepEqual(ran[0], { action: 'visitors', experimentId: 7, visitors: 120 });
  });

  test("while it waits for Flagsmith's refresh window it reads the state from Flagsmith only every 30 s, not every poll", async () => {
    const clock = { t: T0 };
    let reads = 0;
    const judge: JudgeLike = {
      state: async () => {
        reads++;
        return state('score', { results: results('keep-running', { refreshAllowedAt: new Date(T0 + 300_000).toISOString() }) });
      },
      run: async () => ({ status: 202, body: { job: { id: 'j', status: 'done' } } }),
      job: () => null,
    };
    const ap = createAutopilot(judge, { busy: false }, { sleep: tick(clock), now: () => clock.t, pauseMs: 20_000, ambientVisitors: 0, pollMs: 1000 });
    ap.start();
    while (clock.t < T0 + 290_000) await new Promise((r) => setImmediate(r));
    const stopped = ap.stop();
    clock.t += 1;
    await stopped;
    // 270 s of waiting after the first 20 s pause: about 9 reads at 30 s, not 270 at 1 s.
    assert.ok(reads <= 12, `${reads} state reads`);
    assert.ok(reads >= 2);
  });

  test('never starts a job while the shared lock is held, and steps aside after a human action', async () => {
    const clock = { t: T0 };
    const judge = fakeJudge(clock);
    const lock = { busy: true };
    const ap = createAutopilot(judge, lock, { sleep: tick(clock), now: () => clock.t, pauseMs: 1000, humanPauseMs: 600_000 });
    ap.start();
    for (let i = 0; i < 500; i++) await new Promise((r) => setImmediate(r));
    assert.equal(judge.ran.length, 0, 'nothing while the lock is busy');
    assert.equal(ap.status().phase, 'running');
    lock.busy = false;
    ap.noteHuman();
    const pausedAt = clock.t;
    assert.equal(ap.status().phase, 'paused');
    for (let i = 0; i < 2000 && !judge.ran.length; i++) await new Promise((r) => setImmediate(r));
    const stopped = ap.stop();
    clock.t += 1;
    await stopped;
    assert.ok(judge.ran.length >= 1);
    assert.ok(judge.ran[0]!.at - pausedAt >= 600_000, 'waited out the human pause');
  });

  test('a refused step is retried after the error pause, and reported', async () => {
    const clock = { t: T0 };
    let calls = 0;
    const judge: JudgeLike = {
      state: async () => state('visitors'),
      run: async () => {
        calls++;
        return { status: 409, body: { error: 'Another action is still running.' } };
      },
      job: () => null,
    };
    const ap = createAutopilot(judge, { busy: false }, { sleep: tick(clock), now: () => clock.t, pauseMs: 1000, errorPauseMs: 60_000 });
    ap.start();
    for (let i = 0; i < 2000 && calls < 3; i++) await new Promise((r) => setImmediate(r));
    const stopped = ap.stop();
    clock.t += 1;
    await stopped;
    assert.ok(calls >= 3);
    assert.match(ap.status().lastError ?? '', /Another action/);
    assert.ok(clock.t - T0 >= 120_000, 'one error pause between tries');
  });
});

describe('autopilotFromEnv', () => {
  test('off unless TURNOUT_AUTOPILOT=on; numbers checked', () => {
    assert.equal(autopilotFromEnv({}), null);
    assert.equal(autopilotFromEnv({ TURNOUT_AUTOPILOT: 'off' }), null);
    assert.deepEqual(autopilotFromEnv({ TURNOUT_AUTOPILOT: 'on' }), {});
    assert.deepEqual(autopilotFromEnv({ TURNOUT_AUTOPILOT: 'ON', TURNOUT_AUTOPILOT_VISITORS: '400', TURNOUT_AUTOPILOT_PAUSE: '30' }), { visitors: 400, pauseMs: 30_000 });
    assert.throws(() => autopilotFromEnv({ TURNOUT_AUTOPILOT: 'on', TURNOUT_AUTOPILOT_VISITORS: 'lots' }), /TURNOUT_AUTOPILOT_VISITORS/);
  });
});
