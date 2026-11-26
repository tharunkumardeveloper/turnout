// Server mode's autopilot: the public judge view is read-only, so nobody there can press a button. The autopilot
// presses them, in the console process, by calling the same judge jobs the console's buttons call (judge.run): send
// visitors, get Flagsmith's results, follow Turnout's recommendation (ship / revert / keep running), verify, preview,
// release the next release, and when the story ends, reset and start again. It changes no experiment logic: every job
// keeps its own guards (judge.ts refusal()), and Flagsmith's 5-minute results refresh limit is waited out.
//   - never starts a job while another runs (the console's shared lock, also the guard's)
//   - pauses while someone uses the private console (SSH tunnel): noteHuman() from every write there
//   - pauses between steps, so a visitor to the public page always sees the last step's result before the next one
// TURNOUT_AUTOPILOT=on turns it on (compose.server.yml); local mode never does.
import type { Job, JudgeAction, JudgeState, RunResponse } from './judge.ts';

export type AutopilotOptions = {
  visitors?: number; // per visitors step; default 2,000: enough for Flagsmith to decide on its first look, so the story rarely waits out its 5-minute refresh limit
  ambientVisitors?: number; // a small top-up batch while Flagsmith's refresh window is closed; 0: none. Default 150
  pauseMs?: number; // after each step, before the next; default 8 s
  endPauseMs?: number; // after the story's last step, before Reset; default 30 s
  humanPauseMs?: number; // after a write from the private console; default 10 min
  errorPauseMs?: number; // after a refused or failed step; default 60 s
  maxKeepRunning?: number; // "keep running" this many times on one experiment (each waits out Flagsmith's 5-minute refresh limit), then follow its pick; default 1
  pollMs?: number; // how often it looks again while waiting (local checks only); default 1 s
  recheckMs?: number; // while waiting for a step, how often it re-reads the judge state from Flagsmith; default 30 s
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
};

/** What the autopilot needs from judge mode: the same three calls the console's routes use. */
export type JudgeLike = {
  state: () => Promise<JudgeState>;
  run: (body: unknown) => Promise<RunResponse>;
  job: () => Job | null;
};

export type AutopilotStatus = {
  enabled: true;
  phase: 'starting' | 'waiting' | 'running' | 'paused' | 'stopped';
  next: { action: JudgeAction; title: string; at: string | null } | null; // what it runs next, and not before when
  pausedUntil: string | null; // someone used the private console
  lastError: string | null; // the last refused or failed step (shown as "trying again")
  loops: number; // completed stories since start
};

export type Plan = { action: JudgeAction; title: string; notBefore: number | null; visitors?: number; end?: boolean };

const TITLES: Record<JudgeAction, string> = {
  visitors: 'Send simulated visitors',
  score: "Get Flagsmith's results",
  ship: 'Ship the winner',
  revert: 'Revert',
  'keep-running': 'Keep running',
  verify: 'Check everyone gets the decision',
  'swing-back': 'Swing back',
  'swing-forward': 'Swing forward',
  preview: 'Preview the next release',
  release: 'Release the next release',
  reset: 'Start the story again',
};

/**
 * The next step from judge mode's state: the step it says is current, and for the decision, Turnout's
 * recommendation (a losing guardrail always reverts). Pure. `keptRunning`: how often this experiment was kept running.
 */
export function planNext(s: JudgeState, o: { keptRunning?: number; maxKeepRunning?: number; visitors?: number } = {}): Plan {
  const plan = (action: JudgeAction, extra: Partial<Plan> = {}): Plan => ({ action, title: TITLES[action], notBefore: null, ...extra });
  if (!s.experiment) return plan('reset');
  const at = (iso: string | null | undefined) => (iso ? Date.parse(iso) : null);
  switch (s.current) {
    case 'visitors':
      return plan('visitors', { visitors: o.visitors ?? 2000 });
    case 'score':
      return plan('score', { notBefore: at(s.results?.refreshAllowedAt) });
    case 'decide': {
      const r = s.results;
      if (r?.losingGuardrails.length) return plan('revert', { title: 'Revert (a guardrail is losing)' });
      const call = r?.recommendation.call ?? 'keep-running';
      if (call === 'keep-running' && (o.keptRunning ?? 0) >= (o.maxKeepRunning ?? 1)) {
        // Enough rounds: Flagsmith's pick decides, as a judge pressing the stage's button would.
        return r?.winner && r.winner.key !== 'control' ? plan('ship', { title: `Ship Flagsmith's pick` }) : plan('revert');
      }
      if (call === 'ship' && !r?.winner) return plan('keep-running', { title: 'Keep running (interval crosses zero)' });
      if (call === 'keep-running') return plan('keep-running', { title: 'Keep running (interval crosses zero)' });
      return plan(call);
    }
    case 'verify':
      return plan('verify');
    case 'preview':
      return plan('preview', { title: s.next ? `Preview ${s.next} for the team` : TITLES.preview });
    case 'release':
      return plan('release', { title: s.next ? `Release ${s.next}` : TITLES.release });
    default:
      return plan('reset', { end: true });
  }
}

export function createAutopilot(judge: JudgeLike, lock: { busy: boolean }, opts: AutopilotOptions = {}) {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const pauseMs = opts.pauseMs ?? 8_000;
  const endPauseMs = opts.endPauseMs ?? 30_000;
  const humanPauseMs = opts.humanPauseMs ?? 10 * 60_000;
  const errorPauseMs = opts.errorPauseMs ?? 60_000;
  const pollMs = opts.pollMs ?? 1000;
  const ambient = opts.ambientVisitors ?? 150;
  const recheckMs = opts.recheckMs ?? 30_000;
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

  let stopped = true;
  let loop: Promise<void> = Promise.resolve();
  let humanUntil = 0;
  let readyAt = 0; // no step before this: the pause after the last one
  let lastJobEnd = 0;
  let recheckAt = 0; // while waiting for a step, no state read before this
  const keptRunning = new Map<number, number>();
  const status: AutopilotStatus = { enabled: true, phase: 'starting', next: null, pausedUntil: null, lastError: null, loops: 0 };

  async function step(): Promise<void> {
    if (now() < humanUntil) {
      status.phase = 'paused';
      status.pausedUntil = iso(humanUntil);
      return sleep(pollMs);
    }
    status.pausedUntil = null;
    if (lock.busy || judge.job()?.status === 'running') {
      status.phase = 'running'; // a job runs (the guard's, or one started from the console): wait for it
      readyAt = Math.max(readyAt, now() + pauseMs);
      return sleep(pollMs);
    }
    // Reading the judge state costs several Flagsmith admin API calls: never while a pause runs, and while waiting
    // for a step only every STATE_RECHECK_MS (once a second kept a 2-vCPU Flagsmith above 100% CPU around the clock).
    const quiet = Math.max(readyAt, recheckAt);
    if (now() < quiet) {
      if (status.phase !== 'waiting') status.phase = 'waiting';
      return sleep(Math.min(pollMs, quiet - now()));
    }
    const s = await judge.state();
    const expId = s.experiment?.id ?? 0;
    let plan = planNext(s, { keptRunning: keptRunning.get(expId) ?? 0, ...(opts.maxKeepRunning !== undefined ? { maxKeepRunning: opts.maxKeepRunning } : {}), ...(opts.visitors !== undefined ? { visitors: opts.visitors } : {}) });
    let at = Math.max(readyAt, plan.notBefore ?? 0, plan.end ? lastJobEnd + endPauseMs : 0);
    // Flagsmith's refresh window is closed for a while: a small batch of visitors keeps the map moving meanwhile.
    if (plan.action === 'score' && ambient > 0 && (plan.notBefore ?? 0) - Math.max(now(), readyAt) > 2 * pauseMs + 60_000) {
      plan = { action: 'visitors', title: 'Send more visitors while Flagsmith’s refresh window is closed', notBefore: null, visitors: ambient };
      at = readyAt;
    }
    status.next = { action: plan.action, title: plan.title, at: iso(at) };
    if (now() < at) {
      status.phase = 'waiting';
      recheckAt = Math.min(at, now() + recheckMs);
      return sleep(Math.min(pollMs, at - now()));
    }
    const ran = await judge.run({ action: plan.action, ...(s.experiment ? { experimentId: s.experiment.id } : {}), ...(plan.visitors ? { visitors: plan.visitors } : {}) });
    if (ran.status !== 202) {
      const error = (ran.body as { error?: string } | null)?.error ?? `HTTP ${ran.status}`;
      status.lastError = `${plan.title}: ${error}`;
      log(`autopilot: ${plan.title} refused (${error}); trying again in ${Math.round(errorPauseMs / 1000)} s`);
      readyAt = now() + errorPauseMs;
      return;
    }
    status.phase = 'running';
    log(`autopilot: ${plan.title}`);
    const id = (ran.body as { job?: Job }).job?.id;
    for (;;) {
      const j = judge.job();
      if (!j || j.id !== id || j.status !== 'running') break;
      await sleep(pollMs);
      if (stopped) return;
    }
    const done = judge.job();
    lastJobEnd = now();
    if (done?.status === 'failed') {
      status.lastError = `${plan.title}: ${done.error ?? 'failed'}`;
      log(`autopilot: ${plan.title} failed (${done.error}); trying again in ${Math.round(errorPauseMs / 1000)} s`);
      readyAt = now() + errorPauseMs;
      return;
    }
    status.lastError = null;
    if (plan.action === 'keep-running') keptRunning.set(expId, (keptRunning.get(expId) ?? 0) + 1);
    if (plan.action === 'reset') {
      keptRunning.clear();
      status.loops += 1;
    }
    readyAt = now() + pauseMs;
  }

  async function run(): Promise<void> {
    while (!stopped) {
      try {
        await step();
      } catch (error) {
        status.lastError = (error as Error).message;
        readyAt = now() + errorPauseMs;
        await sleep(Math.min(errorPauseMs, pollMs * 5));
      }
    }
    status.phase = 'stopped';
  }

  return {
    /** Starts the loop; the first step waits one pause, so a fresh start never races the stack coming up. */
    start(): void {
      if (!stopped) return;
      stopped = false;
      readyAt = now() + pauseMs;
      loop = run();
    },
    stop(): Promise<void> {
      stopped = true;
      return loop;
    },
    /** Someone used the private console: stay out of their way for a while. */
    noteHuman(): void {
      humanUntil = now() + humanPauseMs;
    recheckAt = 0; // after the pause, read the state afresh: the person may have changed everything
      status.phase = 'paused';
      status.pausedUntil = iso(humanUntil);
    },
    status: (): AutopilotStatus => ({ ...status, next: status.next && { ...status.next } }),
  };
}

export type Autopilot = ReturnType<typeof createAutopilot>;

/** TURNOUT_AUTOPILOT=on (and the TURNOUT_AUTOPILOT_* numbers) → options; anything else → null (off). */
export function autopilotFromEnv(env: NodeJS.ProcessEnv): AutopilotOptions | null {
  if ((env.TURNOUT_AUTOPILOT ?? '').trim().toLowerCase() !== 'on') return null;
  const num = (name: string, min: number, max: number): number | undefined => {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number from ${min} to ${max}, got "${raw}"`);
    return n;
  };
  const visitors = num('TURNOUT_AUTOPILOT_VISITORS', 50, 3000);
  const pause = num('TURNOUT_AUTOPILOT_PAUSE', 5, 3600);
  const endPause = num('TURNOUT_AUTOPILOT_END_PAUSE', 5, 3600);
  return {
    ...(visitors !== undefined ? { visitors } : {}),
    ...(pause !== undefined ? { pauseMs: pause * 1000 } : {}),
    ...(endPause !== undefined ? { endPauseMs: endPause * 1000 } : {}),
  };
}
