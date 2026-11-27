// Guided demo: the whole Turnout story from one page with buttons, no terminal. A small state machine over the
// flag's latest experiment (deriveSteps) plus background jobs that drive the real stack: labelled simulated visitors
// through the proxy, Flagsmith's results, Ship winner / Revert, swing-back, preview, release, verify and reset.
// Every job reuses the commands the CLI runs; Flagsmith, the simulator and the proxy are injectable for tests.
import { defaultHypothesis } from '../config.ts';
import { truthText, type BlindStore, type Point, type Round, type Score } from './blind.ts';
import { randomBytes } from 'node:crypto';
import { simulate as runSimulation, type SimOptions, type SimReport } from '../../demo/simulator/simulate.ts';
import { check as runCheck } from '../commands/check.ts';
import { preview as runPreview, PREVIEW_SEGMENT } from '../commands/preview.ts';
import { currentRelease, release as runRelease } from '../commands/release.ts';
import { decide, keepRunning, LosingGuardrailsError } from '../decide.ts';
import {
  CONTROL,
  losingGuardrails,
  pickWinner,
  recommend,
  releaseOf,
  type Recommendation,
  type ExperimentDetail,
  type Experiments,
  type FlagState,
  type GuardrailWarning,
  type Results,
  formatInterval,
  isGuardrail,
} from '../flagsmith/experiments.ts';
import { readLedger, type LedgerEntry } from '../ledger.ts';

export const JUDGE_ACTIONS = ['visitors', 'score', 'ship', 'revert', 'keep-running', 'verify', 'swing-back', 'swing-forward', 'preview', 'release', 'reset', 'abc', 'start'] as const;
export type JudgeAction = (typeof JUDGE_ACTIONS)[number];
export type StepId = 'visitors' | 'score' | 'decide' | 'verify' | 'swing' | 'preview' | 'release';
export type StepStatus = 'done' | 'current' | 'todo' | 'optional';
export type Step = { id: StepId; title: string; round: '01' | '02' | '03' | '04' | null; status: StepStatus };

// Who gets which release right now, read from the flag and the experiment: the page draws it as a track diagram
// and compares the copy taken before a job with the one taken after it ("what changed in Flagsmith").
export type Routing = {
  defaultRelease: string | null; // the flag's environment default: everyone outside the experiment and the preview
  experiment: {
    id: number;
    status: ExperimentDetail['status'];
    enrolledPct: number; // the rollout's share of visitors; 0 once drained
    arms: { key: string; release: string | null; pct: number }[]; // the split inside the rollout
  } | null; // null when the flag has no experiment, or it is completed and drained
  preview: { active: boolean; release: string | null };
};

export type JobStage = { title: string; status: 'todo' | 'running' | 'done' | 'failed' };

export type Job = {
  id: string;
  action: JudgeAction;
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  log: { at: string; text: string }[];
  error: string | null;
  result: unknown;
  stages: JobStage[]; // what the job does, ticked off as it goes
  progress: { done: number; total: number } | null; // visitors sent so far, for the visitors job
  changes: { before: Routing; after: Routing | null }; // the flag's routing before and after the job
};

// The stages each job shows, in order. The page draws them as a checklist instead of a log.
export const JOB_STAGES: Record<JudgeAction, string[]> = {
  visitors: ['Wait for the proxy to enrol visitors', 'Send the visitors through Turnout', 'Hand their events to Flagsmith'],
  score: ["Wait for the events to reach Flagsmith", 'Ask Flagsmith to compute the results', 'Read the new results'],
  ship: ['Pause the experiment', "Save a snapshot of Flagsmith's results", "Set the flag's default to the winner", 'Drain the rollout to 0%', 'Complete the experiment', 'Write the release ledger'],
  revert: ['Pause the experiment', "Save a snapshot of Flagsmith's results", "Set the flag's default to control", 'Drain the rollout to 0%', 'Complete the experiment', 'Write the release ledger'],
  'keep-running': ["Read Flagsmith's credible interval", 'Write the release ledger (nothing changes in Flagsmith)'],
  verify: ['Send 50 brand-new visitors', 'Count the release each one got', 'Check no experiment split is left'],
  'swing-back': ["Edit the flag's default in Flagsmith", 'Wait for Turnout to follow the flag'],
  'swing-forward': ["Edit the flag's default in Flagsmith", 'Wait for Turnout to follow the flag'],
  preview: ['Point v2 at the next release', 'Give it to the preview segment only', 'Make the preview link'],
  release: ['Point v2 at the next release', 'Start the experiment in Flagsmith'],
  reset: ['Revert the running experiment', "Set the flag's default back to the first release", 'Start a fresh experiment'],
  abc: ['Revert the running experiment', "Set the flag's default back to the first release", 'Start the A/B/C experiment'],
  start: ['Revert the running experiment', "Set the flag's default back to the first release", 'Start the new experiment'],
};

/** The routing the page draws, from the experiment, the release everyone else gets and the preview override. */
export function routingFrom(
  experiment: ExperimentDetail,
  tested: { control: string | null; v2: string | null },
  defaultRelease: string | null,
  preview: { active: boolean; release: string | null },
): Routing {
  const r = experiment.experiment_rollout;
  const live = experiment.status !== 'completed' && experiment.status !== 'created' && r?.enabled !== false;
  let exp: Routing['experiment'] = null;
  if (live && r) {
    const byOption = new Map(r.multivariate_feature_state_values.map((v) => [v.multivariate_feature_option, v.percentage_allocation]));
    const treatments = experiment.feature.multivariate_options
      .filter((o) => o.key)
      .map((o) => ({ key: o.key!, release: o.key === 'v2' ? (tested.v2 ?? o.string_value) : o.string_value, pct: byOption.get(o.id) ?? 0 }));
    const rest = Math.max(0, 100 - treatments.reduce((sum, t) => sum + t.pct, 0));
    exp = {
      id: experiment.id,
      status: experiment.status,
      enrolledPct: r.rollout_percentage,
      arms: [{ key: CONTROL, release: tested.control, pct: rest }, ...treatments.filter((t) => t.pct > 0 || t.key === 'v2')],
    };
  }
  return { defaultRelease, experiment: exp, preview };
}

export type Verdict = 'winning' | 'losing' | 'inconclusive' | 'collecting' | 'no-events';
export type MetricSummary = {
  name: string;
  role: 'goal' | 'secondary' | 'guardrail';
  aggregation: string;
  direction: string;
  arms: Record<string, { n: number; mean: number }>;
  v2: { lift: number; chanceToWin: number; ciLow: number; ciHigh: number } | null;
  verdict: Verdict;
  // Every new version against control (an A/B/C test has v2 and v3), as Flagsmith returned it.
  byArm?: Record<string, { lift: number; chanceToWin: number; ciLow: number; ciHigh: number; verdict: Verdict }>;
};

export type JudgeState = {
  simulated: true;
  flag?: string; // the release flag's name in Flagsmith
  simulator?: boolean; // false: a console for your own app; no simulated shoppers (turnout simulate has its own)
  dashboardUrl: string;
  links: { experiment: string | null; flag: string | null; shop: string; preview: string | null };
  releases: string[];
  live: string | null;
  next: string | null;
  experiment: {
    id: number;
    name: string;
    hypothesis: string;
    status: ExperimentDetail['status'];
    control: string | null;
    v2: string | null;
    arms?: { key: string; release: string | null }[]; // control first, then every new version tested (v2, v3…)
    startedAt: string | null;
    endedAt: string | null;
  } | null;
  results: {
    asOf: string | null;
    refreshAllowedAt: string | null;
    metrics: MetricSummary[];
    winner: { key: string; release: string | null; chanceToWin: number } | null;
    losingGuardrails: GuardrailWarning[];
    losingByArm?: Record<string, GuardrailWarning[]>; // each new version's losing guardrails
    recommendation: Recommendation; // ship / keep running / revert, read off Flagsmith's interval and chance to win
  } | null;
  ledger: LedgerEntry[];
  preview: { active: boolean; release: string | null };
  routing: Routing | null;
  // The flag's multivariate options as Flagsmith holds them now. A preview re-points v2 at the next release while
  // `experiment.v2` keeps naming the release the experiment tested.
  variants?: { key: string; release: string | null }[];
  steps: Step[];
  current: StepId | 'reset';
  job: Job | null;
  totals: { visitorsSent: number; eventsAccepted: number | null; eventsRejected: number | null };
  // Blind rounds (blind.ts): the hidden truth stays hidden until the round is decided; the scoreboard; and
  // Flagsmith's chance to win over time for this experiment.
  blind?: {
    enabled: boolean;
    round: { hidden: true } | { hidden: false; truth: string; round: Round } | null;
    score: Score;
    recent: { experimentId: number; v2: string; control: string; outcome: Round['outcome']; call: Round['call']; expected: Round['expected'] }[];
    last24h?: number; // rounds decided in the last 24 hours
    lastAt?: string | null; // when the last round was decided
  };
  flagsmithVersion?: string | null; // Flagsmith's image tag, e.g. 2.291.0
  history?: Point[];
  // Server mode's live experiment for real visitors ("Be a visitor"): its own flag and experiment, never mixed
  // with the simulated ones. Null when there is none (local mode).
  visitors?: LiveVisitors | null;
};

export type LiveVisitors = {
  flag: string;
  experimentId: number;
  status: string;
  arms: { key: string; release: string | null; identities: number }[]; // exposed visitors per release, from Flagsmith
  asOf: string | null; // Flagsmith's results time (it refreshes them at most every 5 minutes)
  chanceToWin: number | null;
};

/** The live experiment's summary from Flagsmith: who it has counted, per release. */
// Nobody presses "refresh" on the live experiment, so this asks Flagsmith to recompute its results whenever they're
// older than its 5-minute limit; the counts on the page then follow real visitors with at most that delay.
const LIVE_REFRESH_MS = 5 * 60_000 + 5_000;
export async function readLiveVisitors(exps: Experiments, now: () => number = Date.now): Promise<LiveVisitors> {
  let [experiment, results] = await Promise.all([exps.detail(), exps.results()]);
  const age = results?.as_of ? now() - Date.parse(results.as_of) : Infinity;
  if (experiment.status === 'running' && age > LIVE_REFRESH_MS && (await exps.refreshResults().catch(() => ({ ok: false }))).ok) {
    results = (await exps.results().catch(() => results)) ?? results;
  }
  const goal = results?.payload?.metrics.find((m) => m.metric_id === experiment.metrics[0]?.metric);
  const keys = [CONTROL, ...experiment.feature.multivariate_options.flatMap((o) => (o.key ? [o.key] : []))];
  const tested = experiment.name.match(/: (.+) vs (.+)$/);
  return {
    flag: experiment.feature.name,
    experimentId: experiment.id,
    status: experiment.status,
    arms: keys.map((key) => ({
      key,
      release: key === CONTROL ? (tested?.[2] ?? null) : (tested?.[1] ?? null),
      identities: goal?.variants[key]?.n ?? 0,
    })),
    asOf: results?.as_of ?? null,
    chanceToWin: goal?.inference.v2?.chance_to_win ?? null,
  };
}

// What the jobs call outside this process. Defaults drive the real stack; tests replace them.
export type JudgeDeps = {
  simulate: (opts: SimOptions) => Promise<SimReport>;
  preview: (release: string, envKey: string, log: (line: string) => void) => Promise<void>;
  release: (release: string, hypothesis: string, envKey: string, log: (line: string) => void, extra?: { also?: string[]; aa?: boolean }) => Promise<{ experimentId: number }>;
  check: ((log: (line: string) => void) => Promise<number>) | null; // leftover splits; null without a server key
  visit: () => Promise<string | null>; // one fresh visitor loads / twice; the release the second load got
  probe: () => Promise<boolean>; // one cookie-less request (never counted): is the proxy enrolling visitors yet?
  readEvents: () => Promise<{ accepted: number; rejected: number } | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

export type JudgeOptions = {
  flag: string;
  releases: string[]; // config allowlist order
  goal: string; // the goal event, for release hypotheses
  apiUrl: string;
  adminKey: string;
  proxyUrl: string; // where simulated visitors go, e.g. http://turnout:8080
  shopUrl: string; // the URL a judge's browser uses for the shop
  dashboardUrl: string; // Flagsmith's UI
  concurrency?: number; // simulated visitors in flight at once; default 20 (TURNOUT_DEMO_CONCURRENCY)
  previewToken?: string; // also the proxy's debug token: the simulator reads the routing headers with it
  serverKey?: string; // for verify's leftover-split check
  rates: Record<string, number>; // true conversion rate per RELEASE (inputs, not evidence)
  // Blind rounds: hidden random rates per experiment, revealed when the round is decided (TURNOUT_BLIND=on). The
  // store also keeps the chance-to-win history, with or without blind rounds.
  blind?: { store: BlindStore; enabled: boolean };
  stateCacheMs?: number; // how long one read of the page's state is shared; default STATE_CACHE_MS
  // false: a console for your own app (turnout compare). Tests still start, are scored and decided from the console,
  // but the demo shop's simulated shoppers never run: they would land in your real experiment.
  simulator?: boolean;
  metrics?: { name: string; expected_direction: string }[]; // each new experiment's metrics, the goal first (Try it)
  deps?: Partial<JudgeDeps>;
};

export type JudgeContext = {
  experiments: () => Promise<Experiments>; // the flag's latest experiment
  readEvents: () => Promise<{ accepted: number; rejected: number } | null>;
  snapshotDir: string;
  ledgerDir: string;
  github?: { token: string; repository: string };
  lock: { busy: boolean }; // shared with the console's Ship winner / Revert
  // Drops the console's cached reads: 'experiment' before an action checks which experiment is latest, 'all' after
  // a job, which may have changed the flag or started a new experiment.
  invalidate?: (scope: 'experiment' | 'all') => void;
  liveVisitors?: () => Promise<LiveVisitors | null>; // server mode's real-visitor experiment, if any
};

// One read shared by everyone who asks while it runs, then kept for `ttlMs` after it succeeds. A failed read is
// never kept. clear() drops it, so the next caller starts a fresh read; a read already running when clear() is
// called still answers the callers that joined it, but is not kept.
export const STATE_CACHE_MS = 1500;
export function shared<T>(load: () => Promise<T>, ttlMs: number, now: () => number = Date.now) {
  let entry: { at: number | null; value: Promise<T> } | null = null;
  return {
    get(fresh = false): Promise<T> {
      if (entry && (entry.at === null || (!fresh && now() - entry.at < ttlMs))) return entry.value;
      // Expired but not cleared (nothing was written since): answer with it now and read again behind it, so a page
      // opening after a quiet spell doesn't wait a full Flagsmith read. A write clears it, and then everyone waits.
      if (entry && !fresh && entry.at !== null) {
        const stale = entry.value;
        const next: { at: number | null; value: Promise<T> } = { at: null, value: load() };
        entry = next;
        next.value.then(
          () => {
            if (entry === next) next.at = now();
          },
          () => {
            if (entry === next) entry = null;
          },
        );
        return stale;
      }
      const mine: { at: number | null; value: Promise<T> } = { at: null, value: load() };
      entry = mine;
      mine.value.then(
        () => {
          if (entry === mine) mine.at = now();
        },
        () => {
          if (entry === mine) entry = null;
        },
      );
      return mine.value;
    },
    clear(): void {
      entry = null;
    },
  };
}

// shop:1.6 converts better but carries a deliberate test fault, a seeded 60 ms delay: it wins on orders and loses
// the latency guardrail.
// The demo's true order rates (inputs, not evidence). 1.5 converts twice as often as 1.4, so even an A/B/C test's 700
// shoppers per version give Flagsmith a clear answer on its first look: a closer pair often meant "keep running", and
// Flagsmith allows its next look only 5 minutes later, which stalled the demo.
export const DEFAULT_RATES = 'shop:1.4=0.10,shop:1.5=0.20,shop:1.6=0.22';
export const REFRESH_EVERY_MS = 5 * 60_000; // Flagsmith accepts one results refresh per experiment every 5 minutes
const DEFAULT_VISITORS = 1500;
const VERIFY_VISITORS = 50;
const MAX_LOG = 400;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

// "shop:1.4=0.10,shop:1.5=0.135" → { "shop:1.4": 0.1, "shop:1.5": 0.135 }. Labels may hold ':' but not '='.
export function parseRates(text: string): Record<string, number> {
  const rates: Record<string, number> = {};
  for (const part of text.split(',').map((p) => p.trim()).filter(Boolean)) {
    const at = part.lastIndexOf('=');
    const rate = Number(part.slice(at + 1));
    if (at <= 0 || !Number.isFinite(rate) || rate < 0 || rate > 1) throw new Error(`TURNOUT_DEMO_RATES expects <release>=<0..1>, got "${part}"`);
    rates[part.slice(0, at).trim()] = rate;
  }
  return rates;
}

// The releases an experiment compares. Turnout names every experiment "<flag>: <v2> vs <control>"; the name
// survives a later preview re-pointing v2's option at the next release, which releaseOf would then report.
export function testedReleases(experiment: ExperimentDetail, releases: readonly string[]): { control: string | null; v2: string | null } {
  const control = releaseOf(experiment, CONTROL);
  const m = experiment.name.match(/:\s*(\S+)\s+vs\s+(\S+)\s*$/);
  if (m && releases.includes(m[1]!) && releases.includes(m[2]!)) return { control: m[2]!, v2: m[1]! };
  return { control, v2: releaseOf(experiment, 'v2') };
}

/**
 * Every arm the experiment tests: control first, then v2, v3… From the experiment's name as Turnout writes it
 * ("flag: shop:1.5 vs shop:1.6 vs shop:1.4", the last is control), else from the flag's options in the rollout.
 */
export function testedArms(experiment: ExperimentDetail, releases: readonly string[]): { key: string; release: string | null }[] {
  const parts = experiment.name.replace(/^[^:]*:\s*/, '').split(/\s+vs\s+/).map((x) => x.trim());
  if (parts.length >= 2 && parts.every((x) => releases.includes(x))) {
    const control = parts.pop()!;
    return [{ key: CONTROL, release: control }, ...parts.map((release, i) => ({ key: `v${i + 2}`, release }))];
  }
  const allocated = new Set(
    (experiment.experiment_rollout?.multivariate_feature_state_values ?? []).filter((v) => v.percentage_allocation > 0).map((v) => v.multivariate_feature_option),
  );
  const treatments = experiment.feature.multivariate_options.filter((o) => o.key && (o.key === 'v2' || allocated.has(o.id)));
  return [{ key: CONTROL, release: releaseOf(experiment, CONTROL) }, ...treatments.map((o) => ({ key: o.key!, release: o.string_value }))];
}

export function nextRelease(releases: readonly string[], v2: string | null): string | null {
  const i = v2 ? releases.indexOf(v2) : -1;
  return i >= 0 ? (releases[i + 1] ?? null) : null;
}

export function verdictOf(inference: { chance_to_win: number } | null | undefined, arms: { sum: number }[] | null): Verdict {
  if (inference) return inference.chance_to_win >= 0.95 ? 'winning' : inference.chance_to_win <= 0.05 ? 'losing' : 'inconclusive';
  if (arms && arms.length && arms.every((a) => a.sum === 0)) return 'no-events';
  return 'collecting';
}

// Flagsmith's results, per metric, in the shape the judge page shows. v2's numbers only: control is the baseline.
export function summarizeResults(experiment: ExperimentDetail, results: Results | null): MetricSummary[] {
  return experiment.metrics.map((m, i) => {
    const r = results?.payload?.metrics.find((x) => x.metric_id === m.metric);
    const arms = Object.fromEntries(Object.entries(r?.variants ?? {}).map(([key, v]) => [key, { n: v.n, mean: v.n ? v.sum / v.n : 0 }]));
    const inference = r?.inference.v2 ?? null;
    return {
      name: m.metric_name,
      role: i === 0 ? 'goal' : isGuardrail(m) ? 'guardrail' : 'secondary',
      aggregation: m.aggregation,
      direction: m.direction,
      arms,
      v2: inference ? { lift: inference.lift, chanceToWin: inference.chance_to_win, ciLow: inference.ci_low, ciHigh: inference.ci_high } : null,
      verdict: verdictOf(inference, r ? Object.values(r.variants) : null),
      byArm: Object.fromEntries(
        Object.entries(r?.inference ?? {}).flatMap(([key, x]) => (x ? [[
          key,
          { lift: x.lift, chanceToWin: x.chance_to_win, ciLow: x.ci_low, ciHigh: x.ci_high, verdict: verdictOf(x, null) },
        ]] : [])),
      ),
    };
  });
}

// Identities Flagsmith counted on the goal metric, across arms.
export function identitiesOf(experiment: ExperimentDetail, results: Results | null): number {
  const goal = results?.payload?.metrics.find((x) => x.metric_id === experiment.metrics[0]?.metric);
  return Object.values(goal?.variants ?? {}).reduce((n, v) => n + v.n, 0);
}

export type StepInput = {
  status: ExperimentDetail['status'];
  visitorsSent: number; // this console sent visitors for this experiment
  identities: number; // Flagsmith's identity count on the goal metric
  resultsAsOf: string | null;
  lastVisitorsAt: string | null; // when the last visitors job for this experiment finished
  losingGuardrails: boolean; // the winner is losing a guardrail
  decision: 'shipped' | 'reverted' | null; // the ledger's decision on this experiment
  keptRunningAt?: string | null; // the last "Keep running" on this experiment, if any
  recommendation?: Recommendation['call'] | null; // what recommend() says now
  verified: boolean;
  swungBack: boolean;
  swungForward: boolean;
  previewServes: string | null; // the release the preview override serves
  previewAvailable: boolean; // false without a preview token: nobody could open the preview, so it's optional
  next: string | null;
};

const later = (a: string | null, b: string | null) => a !== null && (b === null || Date.parse(a) > Date.parse(b));

export function deriveSteps(i: StepInput): { steps: Step[]; current: StepId | 'reset' } {
  const completed = i.status === 'completed';
  const decideTitle =
    completed && i.decision === 'shipped'
      ? 'Ship winner'
      : i.losingGuardrails
        ? 'Revert (a guardrail is losing)'
        : !completed && i.recommendation === 'keep-running'
          ? 'Keep running (interval crosses zero)'
        : completed && i.decision === 'reverted'
          ? 'Revert'
          : 'Ship winner';
  const steps: Step[] = [
    { id: 'visitors', title: 'Send simulated visitors', round: '03', status: 'todo' },
    { id: 'score', title: "Get Flagsmith's results", round: '02', status: 'todo' },
    { id: 'decide', title: decideTitle, round: '04', status: 'todo' },
    { id: 'verify', title: 'Check everyone gets the decision', round: '04', status: 'todo' },
    { id: 'swing', title: 'Swing back and forward with one flag edit', round: '01', status: 'todo' },
    { id: 'preview', title: i.next ? `Preview ${i.next} for your team only` : 'Preview the next release', round: null, status: 'todo' },
    { id: 'release', title: i.next ? `Release ${i.next} as the next experiment` : 'Release the next release', round: '01', status: 'todo' },
  ];
  const set = (id: StepId, status: StepStatus) => (steps.find((s) => s.id === id)!.status = status);

  if (!completed) {
    const visitors = i.visitorsSent > 0 || i.identities >= 100;
    // Kept running since the last visitors: send more visitors, then get the results again.
    const keptSince = Boolean(i.keptRunningAt) && (i.lastVisitorsAt === null || later(i.keptRunningAt ?? null, i.lastVisitorsAt));
    const scored = visitors && !keptSince && (i.lastVisitorsAt ? later(i.resultsAsOf, i.lastVisitorsAt) : i.resultsAsOf !== null && i.identities >= 100);
    set('visitors', visitors && !keptSince ? 'done' : 'current');
    // After Keep running, more visitors come first: the results step waits its turn (one current step, never two).
    if (visitors) set('score', scored ? 'done' : keptSince ? 'todo' : 'current');
    if (scored) set('decide', 'current');
  } else {
    set('visitors', 'done');
    set('score', 'done');
    set('decide', 'done');
    set('verify', i.verified ? 'done' : 'current');
    set('swing', i.decision === 'shipped' && i.swungBack && i.swungForward ? 'done' : 'optional');
    if (i.verified && i.next) {
      const previewed = i.previewServes === i.next;
      if (previewed) {
        set('preview', 'done');
        set('release', 'current');
      } else if (!i.previewAvailable) {
        set('preview', 'optional'); // skipped: release is next right after verify
        set('release', 'current');
      } else {
        set('preview', 'current'); // release is allowed too: the preview may be skipped
      }
    }
  }
  const current = steps.find((s) => s.status === 'current')?.id ?? 'reset';
  return { steps, current };
}

// One fresh visitor, no cookie reuse: loads / twice through the proxy (the second load is a returning visitor,
// as the proxy routes them) and reports the release the debug header names.
export async function freshVisitor(proxyUrl: string, debugToken: string | undefined): Promise<string | null> {
  const headers: Record<string, string> = {
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 TurnoutSimulatedVisitor/1.0',
    accept: 'text/html',
    'sec-fetch-dest': 'document',
    ...(debugToken ? { 'x-turnout-debug': debugToken } : {}),
  };
  const load = async (cookie: string) => {
    const res = await fetch(new URL('/', proxyUrl), {
      headers: cookie ? { ...headers, cookie } : headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    await res.arrayBuffer();
    return res;
  };
  const first = await load('');
  const cookie = first.headers.getSetCookie().map((c) => c.split(';')[0]!).join('; ');
  return (await load(cookie)).headers.get('x-turnout-release');
}

// A single debug-token request with no cookie: routed and reported, but the proxy never counts it (no exposure, no events).
export async function probeEnrolled(proxyUrl: string, debugToken: string | undefined): Promise<boolean> {
  const res = await fetch(new URL('/', proxyUrl), {
    headers: {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 TurnoutSimulatedVisitor/1.0',
      accept: 'text/html',
      ...(debugToken ? { 'x-turnout-debug': debugToken } : {}),
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
  });
  await res.arrayBuffer();
  return res.headers.get('x-turnout-enrolled') === 'true';
}

class JobFailure extends Error {
  readonly result: unknown;
  constructor(message: string, result: unknown) {
    super(message);
    this.result = result;
  }
}

// arms (action "start"): how many versions the new test compares, 1 for an A/A test (the live release on both arms).
type RunBody = { action: JudgeAction; experimentId?: number; visitors?: number; acceptLosingGuardrails?: boolean; arms?: number; by?: 'autopilot' };
/** Who asks for an action, set by the caller in code, never read from a request body: the autopilot says so. */
export type RunOrigin = { by?: 'autopilot' };
export type RunResponse = { status: number; body: unknown };

// What a running job may report besides log lines: which stage it is at, and how many visitors it has sent.
type JobTools = { log: (text: string) => void; stage: (index: number) => void; progress: (done: number, total: number) => void };

const hhmm = (ms: number) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

export function createJudge(opts: JudgeOptions, ctx: JudgeContext) {
  const deps: JudgeDeps = {
    simulate: runSimulation,
    preview: (label, envKey, log) =>
      runPreview({ apiUrl: opts.apiUrl, adminKey: opts.adminKey, envKey, flag: opts.flag, releases: new Set(opts.releases), newRelease: label, log }),
    release: (label, hypothesis, envKey, log, extra) =>
      runRelease({
        apiUrl: opts.apiUrl, adminKey: opts.adminKey, envKey, flag: opts.flag, releases: new Set(opts.releases), newRelease: label, hypothesis, log,
        ...(extra?.also?.length ? { also: extra.also } : {}),
        ...(extra?.aa ? { aa: true } : {}),
        ...(opts.metrics?.length ? { metrics: opts.metrics } : {}),
      }),
    check: opts.serverKey ? (log) => runCheck({ apiUrl: opts.apiUrl, serverKey: opts.serverKey!, log }) : null,
    visit: () => freshVisitor(opts.proxyUrl, opts.previewToken),
    // Tests that fake visits are taken as already enrolled unless they fake the probe too.
    probe: opts.deps?.visit ? async () => true : () => probeEnrolled(opts.proxyUrl, opts.previewToken),
    readEvents: ctx.readEvents,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    ...opts.deps,
  };

  // In-memory story progress, per experiment id. Flagsmith holds everything else.
  const visitorsSent = new Map<number, number>();
  const lastVisitorsAt = new Map<number, string>();
  const verified = new Set<number>();
  const swung = new Map<number, { back: boolean; forward: boolean }>();
  const refreshAllowed = new Map<number, number>();
  let projectId: number | undefined;
  // Flagsmith's own version (GET /version/), read once in the background for the page's "live" strip.
  let flagsmithVersion: string | null | undefined;
  const readVersion = (exps: Experiments) => {
    if (flagsmithVersion !== undefined) return;
    flagsmithVersion = null;
    exps.api.get<{ image_tag?: string }>('/version/').then(
      (v) => void (flagsmithVersion = v.image_tag ?? null),
      () => void (flagsmithVersion = undefined), // try again next time
    );
  };
  let previewSegmentId: number | undefined;
  let job: Job | null = null;
  let jobCount = 0;
  let lastRun: Promise<void> = Promise.resolve();

  const iso = () => new Date(deps.now()).toISOString();

  const project = async (exps: Experiments): Promise<number | undefined> => {
    if (projectId === undefined) {
      try {
        projectId = (await exps.api.get<{ project: number }>(`/api/v1/environments/${exps.ref.envKey}/`)).project;
      } catch {
        // links stay null; everything else works
      }
    }
    return projectId;
  };

  const previewSegment = async (exps: Experiments, pid: number | undefined): Promise<number | undefined> => {
    if (previewSegmentId === undefined && pid !== undefined) {
      try {
        const segments = await exps.api.list<{ id: number; name: string }>(`/api/v1/projects/${pid}/segments/`);
        previewSegmentId = segments.find((s) => s.name === PREVIEW_SEGMENT)?.id;
      } catch {
        // no segment list: no preview
      }
    }
    return previewSegmentId;
  };

  const previewState = (experiment: ExperimentDetail, flag: FlagState, segmentId: number | undefined) => {
    const override = flag.segment_overrides.find((o) => o.segment.id === segmentId) as
      | (FlagState['segment_overrides'][number] & { value?: { value?: string } })
      | undefined;
    if (!override || !override.enabled) return { active: false, release: null };
    const full = override.variants.find((v) => v.weight >= 100);
    const option = full && experiment.feature.multivariate_options.find((o) => o.id === full.id);
    return { active: true, release: option?.string_value ?? override.value?.value ?? null };
  };

  const shippedEntry = (experimentId: number, flag: string): LedgerEntry | null => {
    const mine = readLedger(ctx.ledgerDir).filter((e) => e.flag === flag && e.experimentId === experimentId);
    const last = mine.filter((e) => e.decision !== 'kept-running').pop();
    return last ?? null;
  };
  const keptRunningAt = (experimentId: number, flag: string): string | null =>
    readLedger(ctx.ledgerDir).filter((e) => e.flag === flag && e.experimentId === experimentId && e.decision === 'kept-running').pop()?.at ?? null;

  const refreshAllowedAt = (experimentId: number, results: Results | null): string | null => {
    const fromFlagsmith = results?.refresh_requested_at ? Date.parse(results.refresh_requested_at) + REFRESH_EVERY_MS : 0;
    const at = Math.max(fromFlagsmith || 0, refreshAllowed.get(experimentId) ?? 0);
    return at > deps.now() ? new Date(at).toISOString() : null;
  };

  // Everything the page and the action guards need, read fresh from Flagsmith. Calls that don't depend on each other
  // run together: the detail, the results and the project at once; the flag and the preview segment right after.
  async function snapshot() {
    const exps = await ctx.experiments();
    const detail = exps.detail();
    const pidRead = project(exps);
    readVersion(exps);
    const [experiment, results, flag, pid, segmentId] = await Promise.all([
      detail,
      exps.results(),
      detail.then((e) => exps.flagState(e.feature.id)),
      pidRead,
      pidRead.then((p) => previewSegment(exps, p)),
    ]);
    const options = experiment.feature.multivariate_options.map((o) => ({ ...o, default_percentage_allocation: 0 }));
    const tested = testedReleases(experiment, opts.releases);
    const arms = testedArms(experiment, opts.releases);
    const winner = pickWinner(experiment, results);
    const losing = winner ? losingGuardrails(experiment, results, winner.key) : [];
    const entry = shippedEntry(experiment.id, experiment.feature.name);
    const kept = keptRunningAt(experiment.id, experiment.feature.name);
    const recommendation = recommend(experiment, results);
    const preview = previewState(experiment, flag, segmentId);
    return {
      exps,
      experiment,
      results,
      flag,
      pid,
      tested,
      arms,
      winner,
      losing,
      entry,
      kept,
      recommendation,
      preview,
      live: currentRelease(flag, options),
      next: nextRelease(opts.releases, tested.v2),
    };
  }
  type Snapshot = Awaited<ReturnType<typeof snapshot>>;

  const stepsFor = (s: Snapshot) =>
    deriveSteps({
      status: s.experiment.status,
      visitorsSent: visitorsSent.get(s.experiment.id) ?? 0,
      identities: identitiesOf(s.experiment, s.results),
      resultsAsOf: s.results?.as_of ?? null,
      lastVisitorsAt: lastVisitorsAt.get(s.experiment.id) ?? null,
      losingGuardrails: s.losing.length > 0,
      decision: (s.entry?.decision as 'shipped' | 'reverted' | undefined) ?? null,
      keptRunningAt: s.kept,
      recommendation: s.recommendation.call,
      verified: verified.has(s.experiment.id),
      swungBack: swung.get(s.experiment.id)?.back ?? false,
      swungForward: swung.get(s.experiment.id)?.forward ?? false,
      previewServes: s.preview.release,
      previewAvailable: Boolean(opts.previewToken),
      next: s.next,
    });

  async function readState(): Promise<JudgeState> {
    const shop = opts.shopUrl.replace(/\/$/, '');
    const dash = opts.dashboardUrl.replace(/\/$/, '');
    const previewLink = opts.previewToken ? `${shop}/__turnout/preview?token=${encodeURIComponent(opts.previewToken)}` : null;
    // The job as it was before reading Flagsmith: a job shown as finished never comes with state from before its end.
    const jobNow = job && { ...job, log: [...job.log] };
    const [events, read] = await Promise.all([
      deps.readEvents(),
      snapshot().then(
        (s) => ({ s }),
        (error: unknown) => ({ error }),
      ),
    ]);
    let s: Snapshot;
    if ('s' in read) s = read.s;
    else {
      const error = read.error;
      if (!/No experiment on/.test((error as Error).message)) throw error;
      // Nothing to show until init has run; Reset explains why it can't start either.
      return {
        simulated: true,
        flag: opts.flag,
        simulator: opts.simulator !== false,
        dashboardUrl: dash,
        links: { experiment: null, flag: null, shop, preview: previewLink },
        releases: opts.releases,
        live: null,
        next: null,
        experiment: null,
        results: null,
        ledger: [],
        preview: { active: false, release: null },
        routing: null,
        steps: deriveSteps({
          status: 'created', visitorsSent: 0, identities: 0, resultsAsOf: null, lastVisitorsAt: null, losingGuardrails: false,
          decision: null, verified: false, swungBack: false, swungForward: false, previewServes: null, previewAvailable: false, next: null,
        }).steps.map((step) => ({ ...step, status: 'todo' as const })),
        current: 'reset',
        job: jobNow,
        totals: { visitorsSent: 0, eventsAccepted: events?.accepted ?? null, eventsRejected: events?.rejected ?? null },
      };
    }
    const { experiment, results, pid, tested, winner, losing } = s;
    const store = opts.blind?.store;
    if (store && results?.as_of && experiment.status !== 'created') {
      const rec = s.recommendation;
      store.notePoint(experiment.id, {
        asOf: results.as_of,
        chanceToWin: rec.chanceToWin,
        low: rec.interval?.low ?? null,
        high: rec.interval?.high ?? null,
        identities: identitiesOf(experiment, results),
      });
    }
    const decided = store?.round(experiment.id) ?? null;
    const blind: JudgeState['blind'] = store
      ? {
          enabled: !!opts.blind?.enabled,
          round: decided ? { hidden: false, truth: truthText(decided.truth), round: decided } : store.truth(experiment.id) ? { hidden: true } : null,
          score: store.score(),
          recent: store.rounds(8).map((r) => ({ experimentId: r.experimentId, v2: r.truth.v2, control: r.truth.control, outcome: r.outcome, call: r.call, expected: r.expected })),
          last24h: store.since(deps.now() - 24 * 3600_000),
          lastAt: store.rounds(1)[0]?.at ?? null,
        }
      : undefined;
    const base = pid !== undefined ? `${dash}/project/${pid}/environment/${s.exps.ref.envKey}` : null;
    const { steps, current } = stepsFor(s);
    return {
      simulated: true,
      flagsmithVersion: flagsmithVersion ?? null,
      flag: opts.flag,
      simulator: opts.simulator !== false,
      dashboardUrl: dash,
      links: {
        experiment: base && `${base}/experiments/${experiment.id}`,
        flag: base && `${base}/features?feature=${experiment.feature.id}`,
        shop,
        preview: previewLink,
      },
      releases: opts.releases,
      live: s.live,
      next: s.next,
      experiment: {
        id: experiment.id,
        name: experiment.name,
        hypothesis: experiment.hypothesis,
        status: experiment.status,
        control: tested.control,
        v2: tested.v2,
        arms: s.arms,
        startedAt: experiment.started_at,
        endedAt: experiment.ended_at,
      },
      results: results
        ? {
            asOf: results.as_of,
            refreshAllowedAt: refreshAllowedAt(experiment.id, results),
            metrics: summarizeResults(experiment, results),
            winner: winner ? { key: winner.key, release: winner.key === CONTROL ? tested.control : tested.v2, chanceToWin: winner.chanceToWin } : null,
            losingGuardrails: losing,
            losingByArm: Object.fromEntries(s.arms.slice(1).map((a) => [a.key, losingGuardrails(experiment, results, a.key)])),
            recommendation: s.recommendation,
          }
        : null,
      ledger: readLedger(ctx.ledgerDir).filter((e) => e.flag === experiment.feature.name),
      preview: s.preview,
      routing: routingFrom(experiment, tested, s.live, s.preview),
      variants: experiment.feature.multivariate_options.filter((o) => o.key).map((o) => ({ key: o.key!, release: o.string_value })),
      steps,
      current,
      job: jobNow,
      totals: {
        visitorsSent: visitorsSent.get(experiment.id) ?? 0,
        eventsAccepted: events?.accepted ?? null,
        eventsRejected: events?.rejected ?? null,
      },
      ...(blind ? { blind } : {}),
      ...(store ? { history: store.series(experiment.id) } : {}),
      ...(liveRead ? { visitors: await liveRead.get().catch(() => null) } : {}),
    };
  }

  // Every viewer polls the state. One read of Flagsmith answers all of them for a moment; a job starting or ending
  // drops it, so nobody sees a finished job next to the state from before it ended.
  // The live experiment changes slowly (Flagsmith refreshes results every 5 minutes at most): read it every 15 s.
  const liveRead = ctx.liveVisitors ? shared(ctx.liveVisitors, 15_000, () => deps.now()) : null;
  const stateCache = shared(readState, opts.stateCacheMs ?? STATE_CACHE_MS, () => deps.now());
  const state = (): Promise<JudgeState> => stateCache.get();

  // Why an action can't run now, in plain English; null when it can.
  function refusal(action: JudgeAction, s: Snapshot): string | null {
    const e = s.experiment;
    const finished = e.status === 'completed';
    const running = `Experiment ${e.id} ("${e.name}") is ${e.status}. Ship the winner or revert it first.`;
    switch (action) {
      case 'visitors':
        if (opts.simulator === false) return "This console is for your own app, so it sends no simulated shoppers: they would count in your real experiment. Open your site to be a visitor, or run turnout simulate (it uses a separate Flagsmith environment).";
        return e.status === 'running' ? null : finished ? 'This experiment is finished. Release the next version to send visitors to a new experiment.' : `The experiment is ${e.status}, so the proxy isn't enrolling visitors.`;
      case 'score':
        return finished ? "This experiment is finished; Flagsmith's results are final." : null;
      case 'ship':
        if (finished) return 'This experiment is already decided.';
        return s.winner ? null : 'Flagsmith has no winner yet. Send visitors, then get the results.';
      case 'revert':
      case 'keep-running':
        return finished ? 'This experiment is already decided.' : null;
      case 'verify':
        return finished ? null : 'Verify checks what everyone gets after the decision. Ship the winner or revert first.';
      case 'swing-back':
      case 'swing-forward': {
        if (!finished) return 'Swing back only applies after shipping. Decide the experiment first.';
        if (s.entry?.decision !== 'shipped' || s.entry.variant === CONTROL) return 'Swing back only applies after shipping a new release; this experiment was reverted.';
        const option = e.feature.multivariate_options.find((o) => o.key === s.entry!.variant);
        if (!option) return `The flag has no variant ${s.entry.variant} any more.`;
        if (option.string_value !== s.entry.release) {
          return `${s.entry.variant} now serves ${option.string_value} for the preview, so swinging forward would send everyone there. Release it as an experiment instead.`;
        }
        return null;
      }
      case 'preview':
      case 'release':
        if (!finished) return running;
        return s.next ? null : `${s.tested.v2 ?? 'This release'} is the last release in turnout.config.yml. Reset to start the story again.`;
      case 'reset':
      case 'abc':
      case 'start':
        return null;
    }
  }

  async function run(raw: unknown, origin: RunOrigin = {}): Promise<RunResponse> {
    const parsed = parseRunBody(raw);
    if ('error' in parsed) return { status: 400, body: { error: parsed.error } };
    const body: RunBody = { ...parsed, ...(origin.by ? { by: origin.by } : {}) };
    const needsId = ['score', 'ship', 'revert', 'keep-running', 'verify', 'swing-back', 'swing-forward'].includes(body.action);
    if (needsId && body.experimentId === undefined) return { status: 400, body: { error: 'experimentId is required' } };
    if (ctx.lock.busy) return { status: 409, body: { error: 'Another action is still running. Wait for it to finish.' } };
    ctx.lock.busy = true; // held through the checks so two clicks can't both pass them
    ctx.invalidate?.('experiment'); // the guards read which experiment is latest now, not a cached answer
    let s: Snapshot;
    try {
      s = await snapshot();
    } catch (error) {
      ctx.lock.busy = false;
      const message = (error as Error).message;
      return { status: /No experiment on/.test(message) ? 409 : 502, body: { error: message } };
    }
    if (body.experimentId !== undefined && body.experimentId !== s.experiment.id) {
      ctx.lock.busy = false;
      return {
        status: 409,
        body: { error: 'The experiment changed since this page loaded (a new release started). Reload and check again.', experimentId: s.experiment.id },
      };
    }
    const refused = refusal(body.action, s);
    if (refused) {
      ctx.lock.busy = false;
      return { status: 409, body: { error: refused } };
    }

    const current: Job = {
      id: `job-${++jobCount}-${randomBytes(3).toString('hex')}`,
      action: body.action,
      status: 'running',
      startedAt: iso(),
      finishedAt: null,
      log: [],
      error: null,
      result: null,
      stages: JOB_STAGES[body.action].map((title) => ({ title, status: 'todo' as const })),
      progress: null,
      changes: { before: routingFrom(s.experiment, s.tested, s.live, s.preview), after: null },
    };
    job = current;
    stateCache.clear(); // the next state read shows this job
    const log = (text: string) => {
      current.log.push({ at: iso(), text });
      if (current.log.length > MAX_LOG) current.log.splice(0, current.log.length - MAX_LOG);
    };
    // Marks every stage before `index` done and `index` running.
    const stage = (index: number) => {
      current.stages.forEach((st, i) => {
        if (i < index) st.status = 'done';
        else if (i === index) st.status = 'running';
      });
    };
    const tools: JobTools = { log, stage, progress: (done, total) => (current.progress = { done, total }) };
    const finished = (async () => {
      let outcome: Job['status'] = 'done';
      try {
        stage(0);
        current.result = (await ACTIONS[body.action](s, body, tools)) ?? null;
        stage(current.stages.length);
      } catch (error) {
        outcome = 'failed';
        current.error = (error as Error).message;
        if (error instanceof JobFailure) current.result = error.result;
        if (error instanceof LosingGuardrailsError) current.result = { guardrails: error.warnings };
        for (const st of current.stages) if (st.status === 'running') st.status = 'failed';
        log(`✗ ${current.error}`);
      } finally {
        // What the flag serves now, for the page's before/after card. Best effort: the job's outcome stands either way.
        ctx.invalidate?.('all'); // the job may have changed the flag or started a new experiment
        try {
          const after = await snapshot();
          current.changes.after = routingFrom(after.experiment, after.tested, after.live, after.preview);
        } catch {
          // the card shows "before" only
        }
        current.finishedAt = iso();
        current.status = outcome;
        ctx.invalidate?.('all'); // reads started during the job are not kept either
        stateCache.clear();
        ctx.lock.busy = false;
      }
    })();
    lastRun = finished;
    return { status: 202, body: { job: current } };
  }

  type Action = (s: Snapshot, body: RunBody, t: JobTools) => Promise<unknown>;

  const visitors: Action = async (s, body, { log, stage, progress }) => {
    if (!opts.previewToken) {
      throw new Error("TURNOUT_PREVIEW_TOKEN isn't set, so the simulator can't see which release each visitor got. Run init, then restart the console.");
    }
    const n = Math.min(5000, Math.max(50, Math.round(body.visitors ?? DEFAULT_VISITORS))); // 700 per version for A/B/C…
    const { control, v2 } = s.tested;
    const rateOf = (release: string | null) => (release ? (opts.rates[release] ?? 0.1) : 0.1);
    const truth = opts.blind?.enabled && control && v2 ? opts.blind.store.truthFor(s.experiment.id, control, v2) : null;
    // Every version's own rate; a blind round hides A's and B's (it draws only those two). Without the configured
    // rates underneath, C in an A/B/C blind round had no rate at all, and its shoppers never ordered.
    const configured = Object.fromEntries(s.arms.map((a) => [a.key, rateOf(a.key === 'v2' ? v2 : a.key === CONTROL ? control : a.release)]));
    const rates: Record<string, number> = truth ? { ...configured, [CONTROL]: truth.rates.control, v2: truth.rates.v2 } : configured;
    // Right after a release or reset the proxy may still hold the previous flag state for a few seconds; visitors
    // sent then would land outside the experiment and never be counted.
    for (let i = 0; i <= 20; i++) {
      if (await deps.probe().catch(() => false)) break;
      if (i === 0) log(`Waiting for the proxy to pick up experiment ${s.experiment.id} (it re-reads the flag every few seconds)…`);
      if (i === 20) log("The proxy still isn't enrolling visitors after 20 s; sending them anyway.");
      else await deps.sleep(1000);
    }
    stage(1);
    progress(0, n);
    log(`Sending ${n} simulated visitors (labelled simulation) through the Turnout proxy.`);
    log(
      truth
        ? 'Blind round: the true order rates were drawn at random and stay hidden until the round is decided. Flagsmith has to find the difference, if there is one.'
        : `True order rates, set as inputs (not evidence): ${s.arms.map((a) => `${a.key === 'v2' ? v2 : a.key === CONTROL ? control : a.release} ${pct(rates[a.key] ?? 0)}`).join(', ')}. Add-to-cart: 30% on each, so the difference is at checkout.`,
    );
    let bucket = 0;
    const report = await deps.simulate({
      target: opts.proxyUrl,
      visitors: n,
      rates,
      concurrency: opts.concurrency ?? 50, // 50 in flight: the hold-back queue keeps every event (spikes/RESULTS.md)
      seed: deps.now() >>> 0,
      debugToken: opts.previewToken,
      log: (line) => {
        const m = line.match(/(\d+)\/(\d+)/);
        if (!m) return;
        progress(Number(m[1]), Number(m[2]));
        const b = Math.floor(Number(m[1]) / 250);
        if (b > bucket || m[1] === m[2]) {
          bucket = b;
          log(`${m[1]} of ${m[2]} visitors done`);
        }
      },
    });
    stage(2);
    const sent = Object.values(report.byRelease).reduce((sum, t) => sum + t.visitors, 0);
    visitorsSent.set(s.experiment.id, (visitorsSent.get(s.experiment.id) ?? 0) + sent);
    lastVisitorsAt.set(s.experiment.id, iso());
    for (const [release, t] of Object.entries(report.byRelease)) {
      log(`${release}: ${t.visitors} visitors, ${t.carts ?? 0} added to cart, ${t.orders} orders (${pct(t.orders / Math.max(t.visitors, 1))})${t.pageErrors ? `, ${t.pageErrors} page errors` : ''}`);
    }
    if (report.failedOrders) log(`${report.failedOrders} orders failed`);
    log(`Done in ${(report.durationMs / 1000).toFixed(1)} s. The proxy sends their events to Flagsmith every 2 s.`);
    return { visitors: sent, byRelease: report.byRelease };
  };

  const QUIET_MS = 2_500;
  const score: Action = async (s, _body, { log, stage }) => {
    const id = s.experiment.id;
    const allowed = refreshAllowedAt(id, s.results);
    if (allowed) throw new Error(`Flagsmith allows one refresh per experiment every 5 minutes; next at ${hhmm(Date.parse(allowed))}.`);

    log("Waiting for the proxy's events to reach Flagsmith (the proxy sends them every second)…");
    const first = await deps.readEvents();
    if (!first) {
      await deps.sleep(6_000);
    } else {
      const started = deps.now();
      let last = first.accepted;
      let since = started;
      // The proxy flushes events every second (flag-source.ts flushInterval): 2.5 quiet seconds, two flushes and a
      // half with nothing new, means they've all reached Flagsmith.
      while (deps.now() - since < QUIET_MS && deps.now() - started < 45_000) {
        await deps.sleep(500);
        const now = (await deps.readEvents())?.accepted ?? last;
        if (now !== last) {
          last = now;
          since = deps.now();
        }
      }
      log(`Flagsmith has accepted ${last.toLocaleString('en-GB')} events in total (${(last - first.accepted).toLocaleString('en-GB')} while waiting).`);
    }

    stage(1);
    const before = (await s.exps.results())?.as_of ?? null;
    const refresh = await s.exps.refreshResults();
    if (!refresh.ok) {
      const seconds = Number(refresh.reason.match(/(\d+)\s*seconds?/)?.[1]);
      const at = deps.now() + (Number.isFinite(seconds) ? seconds * 1000 : REFRESH_EVERY_MS);
      refreshAllowed.set(id, at);
      throw new Error(`Flagsmith allows one refresh per experiment every 5 minutes; next at ${hhmm(at)}.`);
    }
    refreshAllowed.set(id, deps.now() + REFRESH_EVERY_MS);
    log('Asked Flagsmith to compute the results. It runs the Bayesian analysis in the background…');
    stage(2);
    const started = deps.now();
    let results: Results | null = null;
    while (deps.now() - started < 90_000) {
      await deps.sleep(400); // Flagsmith's task processor publishes them in a few seconds: look often
      results = await s.exps.results();
      if ((results?.as_of ?? null) !== before) break;
      results = null;
    }
    if (!results) throw new Error("Flagsmith accepted the refresh but hasn't published new results after 90 s. They'll appear here on their own.");
    log(`Flagsmith's results as of ${results.as_of}:`);
    for (const m of summarizeResults(s.experiment, results)) {
      log(
        m.v2
          ? `${m.name} (${m.role}): v2 lift ${pct(m.v2.lift)} (interval ${formatInterval({ low: m.v2.ciLow, high: m.v2.ciHigh })}), ${pct(m.v2.chanceToWin)} chance to win: ${m.verdict}`
          : `${m.name} (${m.role}): ${m.verdict === 'no-events' ? 'no events in either release' : 'collecting data'}`,
      );
    }
    const winner = pickWinner(s.experiment, results);
    if (winner) {
      log(`Flagsmith's results page shows ${winner.key} winning (${pct(winner.chanceToWin)} chance to be best).`);
      for (const g of losingGuardrails(s.experiment, results, winner.key)) {
        log(`! ${winner.key} is losing the ${g.metric} guardrail (${pct(g.chanceToWin)} chance to win).`);
      }
    }
    const rec = recommend(s.experiment, results);
    log(`Turnout recommends: ${rec.call === 'ship' ? 'ship' : rec.call === 'revert' ? 'revert' : 'keep running'} (${rec.reason}).`);
    if (rec.settle) log(`To settle it: ${rec.settle}.`);
    for (const n of rec.notes ?? []) log(`Note: ${n}.`);
    return { asOf: results.as_of };
  };

  const decideAction = (action: 'ship' | 'revert'): Action => async (s, body, { log, stage }) => {
    let done = 0;
    // Ship the version Turnout recommends (in an A/B/C test, the best one that is safe), else Flagsmith's leader.
    const rec = s.recommendation;
    const winner = action === 'ship' ? (rec.call === 'ship' && rec.variant ? rec.variant : s.winner?.key) : CONTROL;
    if (!winner) throw new Error('Flagsmith has no winner yet. Send visitors, then get the results.');
    const release = winner === CONTROL ? s.tested.control : winner === 'v2' ? s.tested.v2 : (s.arms.find((a) => a.key === winner)?.release ?? null);
    const chance = s.results?.payload?.metrics.find((m) => m.metric_id === s.experiment.metrics[0]?.metric)?.inference[winner]?.chance_to_win;
    log(
      action === 'ship'
        ? `Shipping ${winner} (${release})${chance !== undefined ? `, ${pct(chance)} chance to beat control on the goal` : ''}.`
        : `Reverting everyone to control (${s.tested.control}).`,
    );
    const decision = await decide({
      experiments: s.exps,
      action,
      ...(action === 'ship' ? { winner } : {}),
      acceptLosingGuardrails: action === 'revert' || body.acceptLosingGuardrails === true,
      snapshotDir: ctx.snapshotDir,
      ledgerDir: ctx.ledgerDir,
      ...(ctx.github ? { github: ctx.github } : {}),
      ...(body.by ? { by: body.by } : {}),
      onStep: (step) => {
        stage(++done);
        log(`${step.status === 'done' ? '✓' : '·'} ${step.title}${step.status === 'skipped' ? ' (already done)' : ''}`);
      },
    });
    stage(5);
    log(`Everyone now gets ${release} from the flag's environment default. Recorded in the release ledger.`);
    const round = opts.blind?.store.decide(s.experiment.id, s.recommendation, action);
    if (round) log(`Blind round revealed: ${truthText(round.truth)}. Flagsmith's call: ${round.call}; ${round.outcome === 'right' ? 'right' : round.outcome === 'no-call' ? 'no clear call yet' : 'wrong'}.`);
    if (decision.github && 'url' in decision.github) log(`Written to the GitHub Release: ${decision.github.url}`);
    if (decision.github && 'error' in decision.github) log(`Not written to GitHub: ${decision.github.error}`);
    return { entry: decision.entry, github: decision.github };
  };

  const keepRunningAction: Action = async (s, body, { log, stage }) => {
    const rec = s.recommendation;
    log(
      rec.interval
        ? `Flagsmith's credible interval for ${rec.variant} on the goal: ${formatInterval(rec.interval)}${rec.chanceToWin !== null ? `, ${pct(rec.chanceToWin)} chance to win` : ''}.`
        : 'Flagsmith has no interval on the goal yet.',
    );
    stage(1);
    const entry = await keepRunning({ experiments: s.exps, ledgerDir: ctx.ledgerDir, ...(body.by ? { by: body.by } : {}) });
    log(`Kept running: ${entry.reason}. Nothing changed in Flagsmith; send more visitors, then get the results again.`);
    return { entry };
  };

  const visitBatch = async (count: number) => {
    const byRelease: Record<string, number> = {};
    for (let i = 0; i < count; i += 25) {
      const batch = await Promise.all(Array.from({ length: Math.min(25, count - i) }, () => deps.visit().catch(() => null)));
      for (const r of batch) byRelease[r ?? 'no answer'] = (byRelease[r ?? 'no answer'] ?? 0) + 1;
    }
    return byRelease;
  };

  const verify: Action = async (s, _body, { log, stage }) => {
    // The proxy re-reads the flag every few seconds: right after a decision it may still split visitors the old way.
    // Wait until a fresh visitor gets what Flagsmith now serves, then count (up to 20 s, then count anyway).
    for (let i = 0; i <= 20; i++) {
      const served = await deps.visit().catch(() => null);
      if (served === s.live) break;
      if (i === 0) log(`Waiting for Turnout to pick up the flag change (a new visitor still gets ${served ?? 'no answer'})…`);
      if (i === 20) log("Turnout still hasn't picked up the change after 20 s; counting anyway.");
      else await deps.sleep(1000);
    }
    log(`Flagsmith's environment default serves ${s.live}. Sending ${VERIFY_VISITORS} new visitors (no cookies), each loading the shop twice…`);
    const byRelease = await visitBatch(VERIFY_VISITORS);
    stage(1);
    for (const [release, n] of Object.entries(byRelease).sort((a, b) => b[1] - a[1])) {
      log(`${n} of ${VERIFY_VISITORS} new visitors got ${release}`);
    }
    stage(2);
    let leftovers: number | null = null;
    if (deps.check) {
      log('Checking the environment for experiment splits left behind (read-only, server-side key)…');
      leftovers = await deps.check((line) => log(line));
      log(leftovers === 0 ? '✓ No splits left behind.' : `✗ ${leftovers} split(s) left behind.`);
    } else {
      log('Skipped the leftover-split check: TURNOUT_SERVER_KEY is not set for the console.');
    }
    verified.add(s.experiment.id);
    return { byRelease, expected: s.live, leftovers };
  };

  const swing = (direction: 'back' | 'forward'): Action => async (s, _body, { log, stage }) => {
    const entry = s.entry!;
    const option = s.experiment.feature.multivariate_options.find((o) => o.key === entry.variant)!;
    const expected = direction === 'back' ? (entry.replaced ?? s.tested.control) : entry.release;
    const weight = direction === 'back' ? 0 : 100;
    const flagPath = `/api/__future__/environments/${s.exps.ref.envKey}/features/${s.experiment.feature.id}/`;
    log(
      `Setting ${s.experiment.feature.name}'s environment default to ${entry.variant} at ${weight}% (${expected}). ` +
        "It's the same edit as changing the default in Flagsmith's flag editor; no deploy, no Turnout command.",
    );
    // Every variant (the others at 0): Flagsmith refuses a default that leaves one out once the flag has three.
    const variants = s.experiment.feature.multivariate_options.map((o) => ({ id: o.id, weight: o.id === option.id ? weight : 0 }));
    await s.exps.api.patch(flagPath, { environment_default: { enabled: true, variants } });
    stage(1);
    log('✓ Flagsmith saved the flag. Waiting for the proxy to pick it up (it re-reads the flag every few seconds)…');
    let served: string | null = null;
    for (let i = 1; i <= 10; i++) {
      served = await deps.visit().catch(() => null);
      if (served === expected) {
        log(`A new visitor now gets ${served} (after ${i} s).`);
        break;
      }
      log(`A new visitor still gets ${served ?? 'no answer'}…`);
      await deps.sleep(1000);
    }
    const mark = swung.get(s.experiment.id) ?? { back: false, forward: false };
    mark[direction] = true;
    swung.set(s.experiment.id, mark);
    if (served !== expected) log(`The proxy still served ${served ?? 'nothing'} after 10 s; it will follow the flag on its next refresh.`);
    return { expected, served, matched: served === expected };
  };

  const previewAction: Action = async (s, _body, { log, stage }) => {
    const next = s.next!;
    log(`Pointing ${s.experiment.feature.name}'s v2 at ${next} and giving it to the turnout-preview segment only…`);
    await deps.preview(next, s.exps.ref.envKey, (line) => {
      log(line);
      if (/segment/i.test(line)) stage(1);
    });
    stage(2);
    if (opts.previewToken) {
      log(`Open the preview link in this browser to see ${next}: ${opts.shopUrl.replace(/\/$/, '')}/__turnout/preview?token=${encodeURIComponent(opts.previewToken)}`);
    }
    return { release: next };
  };

  const releaseAction: Action = async (s, _body, { log, stage }) => {
    const next = s.next!;
    const hypothesis = defaultHypothesis(next, opts.goal);
    log(`Starting the next experiment on the same flag: ${next} against ${s.live}.`);
    const { experimentId } = await deps.release(next, hypothesis, s.exps.ref.envKey, (line) => {
      log(line);
      if (/start/i.test(line)) stage(1);
    });
    visitorsSent.delete(experimentId);
    lastVisitorsAt.delete(experimentId);
    log(`Experiment ${experimentId} is running. Send visitors to it next.`);
    return { experimentId, release: next };
  };

  // Start a new test, from the start: everyone back on the first release (A), then a fresh experiment.
  //   arms 1: A/A, the first release on both arms (a check that the split and the counting are fair)
  //   arms 2: A/B, the second release against the first ("reset")
  //   arms 3+: A/B/C…, the next releases at once against the first, split evenly ("abc": all of them)
  const startOver = (fixed: number | 'all' | null): Action => async (s, body, { log, stage }) => {
    const [first, ...others] = opts.releases;
    if (!first || !others.length) throw new Error('turnout.config.yml must list at least two releases.');
    const arms = fixed === 'all' ? opts.releases.length : (fixed ?? body.arms ?? opts.releases.length);
    if (arms > opts.releases.length) throw new Error(`turnout.config.yml lists ${opts.releases.length} releases, so a test can compare at most ${opts.releases.length}.`);
    if (fixed === 'all' && arms < 3) throw new Error('An A/B/C test needs at least three releases in turnout.config.yml.');
    const aa = arms === 1;
    const [second, ...also] = aa ? [first] : others.slice(0, arms - 1);
    log(aa ? `Starting over: everyone back on ${first}, then an A/A test: ${first} on both arms.` : `Starting over: everyone back on ${first}, then a fresh ${[second, ...also].join(' vs ')} vs ${first} experiment.`);
    if (s.experiment.status !== 'completed') {
      log(`Experiment ${s.experiment.id} is ${s.experiment.status}; reverting it first.`);
      await decide({
        experiments: s.exps,
        action: 'revert',
        acceptLosingGuardrails: true,
        snapshotDir: ctx.snapshotDir,
        ledgerDir: ctx.ledgerDir,
        onStep: (step) => log(`${step.status === 'done' ? '✓' : '·'} ${step.title}${step.status === 'skipped' ? ' (already done)' : ''}`),
      });
    }
    stage(1);
    const flagPath = `/api/__future__/environments/${s.exps.ref.envKey}/features/${s.experiment.feature.id}/`;
    await s.exps.api.patch(flagPath, {
      environment_default: {
        enabled: true,
        value: { type: 'string', value: first },
        variants: s.experiment.feature.multivariate_options.map((o) => ({ id: o.id, weight: 0 })),
      },
    });
    log(`✓ The flag's environment default serves ${first} to everyone.`);
    stage(2);
    const hypothesis = defaultHypothesis([second!, ...also].join(' or '), opts.goal);
    const { experimentId } = aa
      ? await deps.release(first, hypothesis, s.exps.ref.envKey, log, { aa: true })
      : also.length
        ? await deps.release(second!, hypothesis, s.exps.ref.envKey, log, { also })
        : await deps.release(second!, hypothesis, s.exps.ref.envKey, log);
    visitorsSent.clear();
    lastVisitorsAt.clear();
    verified.clear();
    swung.clear();
    log(`✓ Back at the start: experiment ${experimentId} (${aa ? `A/A, ${first} on both arms` : `${[second, ...also].join(' vs ')} vs ${first}`}) is running.`);
    return { experimentId };
  };

  const ACTIONS: Record<JudgeAction, Action> = {
    visitors,
    score,
    ship: decideAction('ship'),
    revert: decideAction('revert'),
    'keep-running': keepRunningAction,
    verify,
    'swing-back': swing('back'),
    'swing-forward': swing('forward'),
    preview: previewAction,
    release: releaseAction,
    reset: startOver(2),
    abc: startOver('all'),
    start: startOver(null),
  };

  return {
    state,
    run,
    // The running job, else the most recent one: cheap to poll while a job runs (no Flagsmith calls).
    job: (): Job | null => job && { ...job, log: [...job.log] },
    // Resolves when the most recent job has finished (tests and shutdown).
    idle: () => lastRun,
    // Drops the shared state read, after something outside a job (the console's Ship winner / Revert) changed Flagsmith.
    forget: () => stateCache.clear(),
  };
}

export type Judge = ReturnType<typeof createJudge>;

function parseRunBody(raw: unknown): RunBody | { error: string } {
  const b = (raw ?? {}) as Record<string, unknown>;
  if (typeof b.action !== 'string' || !(JUDGE_ACTIONS as readonly string[]).includes(b.action)) {
    return { error: `action must be one of ${JUDGE_ACTIONS.join(', ')}` };
  }
  if (b.experimentId !== undefined && (typeof b.experimentId !== 'number' || !Number.isInteger(b.experimentId))) {
    return { error: 'experimentId must be an integer' };
  }
  if (b.visitors !== undefined && (typeof b.visitors !== 'number' || !Number.isFinite(b.visitors))) return { error: 'visitors must be a number' };
  if (b.acceptLosingGuardrails !== undefined && typeof b.acceptLosingGuardrails !== 'boolean') return { error: 'acceptLosingGuardrails must be true or false' };
  if (b.arms !== undefined && !(typeof b.arms === 'number' && Number.isInteger(b.arms) && b.arms >= 1 && b.arms <= 26)) return { error: 'arms must be a whole number from 1 (A/A) to 26' };
  return {
    action: b.action as JudgeAction,
    ...(typeof b.experimentId === 'number' ? { experimentId: b.experimentId } : {}),
    ...(typeof b.visitors === 'number' ? { visitors: b.visitors } : {}),
    acceptLosingGuardrails: b.acceptLosingGuardrails === true,
    ...(typeof b.arms === 'number' ? { arms: b.arms } : {}),
  };
}
