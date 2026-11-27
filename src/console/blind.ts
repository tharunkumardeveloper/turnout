// Blind rounds for the demo (guided demo). Without them, the simulator's fixed rates decide the winner before Flagsmith
// looks. With them, each experiment's true order rates are drawn at random and kept hidden: the new release is
// better, worse, or identical (an A/A round). Flagsmith sees only the traffic. When the round is decided, the page
// reveals the truth next to Flagsmith's call, and a scoreboard counts how often the call was right.
//
// Scoring, from what Turnout recommended off Flagsmith's numbers at the moment of the decision:
//   - the expected call: new better → ship; old better → revert; identical → keep running (no clear winner);
//     a release carrying the demo's deliberate slowness → revert (its guardrail must catch it, whatever its orders);
//   - right: the call matches; no call: Flagsmith said keep running where there was a difference (too little data,
//     not a mistake); wrong: anything else (a winner declared where there was none, or the wrong one).
// Also kept here: Flagsmith's chance to win over time, one point per results refresh, for the page's line chart.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Recommendation } from '../flagsmith/experiments.ts';

export type Scenario = 'new-better' | 'old-better' | 'same';
export type Call = Recommendation['call'];
export type Truth = {
  experimentId: number;
  control: string;
  v2: string;
  scenario: Scenario;
  rates: { control: number; v2: number }; // true order rate per visitor, hidden until the round is decided
  slow: boolean; // v2 is the release with the demo's deliberate slowness
};
export type Round = {
  experimentId: number;
  at: string;
  truth: Truth;
  expected: Call;
  call: Call; // what Turnout recommended off Flagsmith's results when the round was decided
  chanceToWin: number | null; // Flagsmith's, for the recommended variant on the goal
  reason: string;
  decision: 'ship' | 'revert';
  outcome: 'right' | 'wrong' | 'no-call';
};
export type Point = { asOf: string; chanceToWin: number | null; low: number | null; high: number | null; identities: number };
export type Score = { rounds: number; right: number; wrong: number; noCall: number };

const LIFT = 1.6; // the better release converts 60% more: findable with a few hundred visitors per version

/** Draws a round's hidden truth. `rand` returns [0, 1). */
export function pickTruth(experimentId: number, control: string, v2: string, slowRelease: string | null, rand: () => number = Math.random): Truth {
  const scenario: Scenario = (['new-better', 'old-better', 'same'] as const)[Math.min(2, Math.floor(rand() * 3))]!;
  const base = round3(0.08 + rand() * 0.04); // 8–12%
  const better = round3(base * LIFT);
  const rates = scenario === 'new-better' ? { control: base, v2: better } : scenario === 'old-better' ? { control: better, v2: base } : { control: base, v2: base };
  return { experimentId, control, v2, scenario, rates, slow: !!slowRelease && v2 === slowRelease };
}

export function expectedCall(t: Truth): Call {
  if (t.slow) return 'revert';
  return t.scenario === 'new-better' ? 'ship' : t.scenario === 'old-better' ? 'revert' : 'keep-running';
}

export function scoreRound(t: Truth, call: Call): Round['outcome'] {
  const expected = expectedCall(t);
  if (call === expected) return 'right';
  // Flagsmith not (yet) sure, where there was a difference: not a mistake, just not enough data.
  if (call === 'keep-running') return 'no-call';
  return 'wrong';
}

/** One sentence for the reveal, e.g. "shop:1.5 was better (14.4% vs 9.0% of visitors ordered)". */
export function truthText(t: Truth): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const rates = `${t.v2} ${pct(t.rates.v2)}, ${t.control} ${pct(t.rates.control)} of visitors ordered`;
  const orders = t.scenario === 'same' ? `identical on orders (${pct(t.rates.v2)} each)` : t.scenario === 'new-better' ? `${t.v2} better on orders (${rates})` : `${t.control} better on orders (${rates})`;
  return t.slow ? `${orders}; ${t.v2} carries the deliberate slowness, so its speed guardrail must stop it` : orders;
}

type Saved = { truths: Record<string, Truth>; rounds: Round[]; series: Record<string, Point[]> };

/** The hidden truths, decided rounds and chance-to-win history, kept in one JSON file so a restart keeps them. */
export function createBlindStore(file: string, opts: { slowRelease?: string | null; rand?: () => number; now?: () => number } = {}) {
  let data: Saved = { truths: {}, rounds: [], series: {} };
  try {
    if (existsSync(file)) data = { truths: {}, rounds: [], series: {}, ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<Saved>) };
  } catch {
    // a damaged file starts a fresh scoreboard rather than stopping the console
  }
  const save = () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data));
  };
  const now = opts.now ?? Date.now;
  return {
    /** The experiment's hidden truth, drawn the first time it's asked for. */
    truthFor(experimentId: number, control: string, v2: string): Truth {
      const key = String(experimentId);
      if (!data.truths[key]) {
        data.truths[key] = pickTruth(experimentId, control, v2, opts.slowRelease ?? null, opts.rand);
        save();
      }
      return data.truths[key]!;
    },
    truth(experimentId: number): Truth | null {
      return data.truths[String(experimentId)] ?? null;
    },
    /** Records the round once, when it's decided (Ship or Revert). Returns it, or null when it had no hidden truth. */
    decide(experimentId: number, rec: Recommendation, decision: 'ship' | 'revert'): Round | null {
      const truth = data.truths[String(experimentId)];
      if (!truth) return null;
      const existing = data.rounds.find((r) => r.experimentId === experimentId);
      if (existing) return existing;
      const round: Round = {
        experimentId,
        at: new Date(now()).toISOString(),
        truth,
        expected: expectedCall(truth),
        call: rec.call,
        chanceToWin: rec.chanceToWin,
        reason: rec.reason,
        decision,
        outcome: scoreRound(truth, rec.call),
      };
      data.rounds.push(round);
      if (data.rounds.length > 500) data.rounds = data.rounds.slice(-500);
      save();
      return round;
    },
    round(experimentId: number): Round | null {
      return data.rounds.find((r) => r.experimentId === experimentId) ?? null;
    },
    /** Rounds decided at or after this time (ms since the epoch). */
    since(ms: number): number {
      return data.rounds.filter((r) => Date.parse(r.at) >= ms).length;
    },
    rounds(n = 10): Round[] {
      return data.rounds.slice(-n).reverse();
    },
    score(): Score {
      const s: Score = { rounds: data.rounds.length, right: 0, wrong: 0, noCall: 0 };
      for (const r of data.rounds) {
        if (r.outcome === 'right') s.right++;
        else if (r.outcome === 'wrong') s.wrong++;
        else s.noCall++;
      }
      return s;
    },
    /** Adds a point when Flagsmith's results are newer than the last one kept. */
    notePoint(experimentId: number, p: Point): void {
      const key = String(experimentId);
      const list = (data.series[key] ??= []);
      if (list.length && list[list.length - 1]!.asOf === p.asOf) return;
      list.push(p);
      const keys = Object.keys(data.series);
      if (keys.length > 50) for (const k of keys.slice(0, keys.length - 50)) delete data.series[k];
      save();
    },
    series(experimentId: number): Point[] {
      return data.series[String(experimentId)] ?? [];
    },
  };
}
export type BlindStore = ReturnType<typeof createBlindStore>;

const round3 = (x: number) => Math.round(x * 1000) / 1000;
