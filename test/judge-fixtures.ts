// JudgeState fixtures for the judge-mode UI tests (and for previewing the page against a fake API).
// Shapes follow the /api/judge/state contract; numbers are made up but shaped like Flagsmith's results.

type StepId = 'visitors' | 'score' | 'decide' | 'verify' | 'swing' | 'preview' | 'release';
type Status = 'done' | 'current' | 'todo' | 'optional';

const STEPS: { id: StepId; title: string; round: '01' | '02' | '03' | '04' | null }[] = [
  { id: 'visitors', title: 'Send simulated visitors', round: '03' },
  { id: 'score', title: 'Ask Flagsmith for results', round: '02' },
  { id: 'decide', title: 'Ship the winner, or revert', round: '04' },
  { id: 'verify', title: 'Check where new visitors go', round: '04' },
  { id: 'swing', title: 'Swing back with one flag edit', round: '04' },
  { id: 'preview', title: 'Preview the next release', round: null },
  { id: 'release', title: 'Start the next experiment', round: '01' },
];

function steps(current: StepId | 'reset', swing: Status = 'optional') {
  const at = current === 'reset' ? STEPS.length : STEPS.findIndex((s) => s.id === current);
  return STEPS.map((s, i) => ({
    ...s,
    status: (s.id === 'swing' && i !== at ? (i < at && swing === 'done' ? 'done' : 'optional') : i < at ? 'done' : i === at ? 'current' : 'todo') as Status,
  }));
}

const DASH = 'http://localhost:8000';
const links = (experimentId: number | null, preview: string | null = null) => ({
  experiment: experimentId == null ? null : `${DASH}/project/1/environment/env/experiments/${experimentId}`,
  flag: `${DASH}/project/1/environment/env/features?feature=3`,
  shop: 'http://localhost:8080/',
  preview,
});

const experiment7 = (status: 'running' | 'completed' = 'running') => ({
  id: 7,
  name: 'shop:1.5 vs shop:1.4',
  hypothesis: 'One-page checkout lifts orders without slowing pages',
  status,
  control: 'shop:1.4',
  v2: 'shop:1.5',
  startedAt: '2026-11-17T10:00:00Z',
  endedAt: status === 'completed' ? '2026-11-17T10:20:00Z' : null,
});

const experiment8 = () => ({
  id: 8,
  name: 'shop:1.6 vs shop:1.5',
  hypothesis: 'Recommendations on the cart page lift orders',
  status: 'running' as const,
  control: 'shop:1.5',
  v2: 'shop:1.6',
  startedAt: '2026-11-17T10:40:00Z',
  endedAt: null,
});

const winningResults = () => ({
  asOf: '2026-11-17T10:12:00Z',
  refreshAllowedAt: '2026-11-17T10:17:00Z',
  metrics: [
    {
      name: 'order_placed', role: 'goal' as const, aggregation: 'occurrence', direction: 'up',
      arms: { control: { n: 750, mean: 0.1 }, v2: { n: 750, mean: 0.13 } },
      v2: { lift: 0.3, chanceToWin: 0.967, ciLow: -0.02, ciHigh: 0.62 }, verdict: 'winning' as const,
    },
    {
      name: 'doc_latency_ms', role: 'guardrail' as const, aggregation: 'mean', direction: 'down',
      arms: { control: { n: 3100, mean: 26.4 }, v2: { n: 3050, mean: 26.9 } },
      v2: { lift: 0.019, chanceToWin: 0.41, ciLow: -0.03, ciHigh: 0.07 }, verdict: 'inconclusive' as const,
    },
    {
      name: 'server_error', role: 'guardrail' as const, aggregation: 'mean', direction: 'down',
      arms: { control: { n: 3100, mean: 0 }, v2: { n: 3050, mean: 0 } },
      v2: null, verdict: 'no-events' as const,
    },
  ],
  winner: { key: 'v2', release: 'shop:1.5', chanceToWin: 0.967 },
  losingGuardrails: [] as { metric: string; chanceToWin: number; lift: number }[],
});

const losingResults = () => ({
  asOf: '2026-11-17T10:52:00Z',
  refreshAllowedAt: '2026-11-17T10:57:00Z',
  metrics: [
    {
      name: 'order_placed', role: 'goal' as const, aggregation: 'occurrence', direction: 'up',
      arms: { control: { n: 1000, mean: 0.13 }, v2: { n: 1000, mean: 0.17 } },
      v2: { lift: 0.31, chanceToWin: 0.998, ciLow: 0.1, ciHigh: 0.55 }, verdict: 'winning' as const,
    },
    {
      name: 'doc_latency_ms', role: 'guardrail' as const, aggregation: 'mean', direction: 'down',
      arms: { control: { n: 4100, mean: 26.5 }, v2: { n: 4080, mean: 97.6 } },
      v2: { lift: 2.683, chanceToWin: 0.0001, ciLow: 2.5, ciHigh: 2.9 }, verdict: 'losing' as const,
    },
    {
      name: 'server_error', role: 'guardrail' as const, aggregation: 'mean', direction: 'down',
      arms: { control: { n: 4100, mean: 0 }, v2: { n: 4080, mean: 0 } },
      v2: null, verdict: 'no-events' as const,
    },
  ],
  winner: { key: 'v2', release: 'shop:1.6', chanceToWin: 0.998 },
  losingGuardrails: [{ metric: 'doc_latency_ms', chanceToWin: 0.0001, lift: 2.683 }],
});

const shipEntry = {
  at: '2026-11-17T10:20:00Z',
  experimentId: 7,
  experiment: 'shop:1.5 vs shop:1.4',
  decision: 'shipped' as const,
  variant: 'v2',
  release: 'shop:1.5',
  replaced: 'shop:1.4',
  results: ['order_placed: v2 +30.0% lift, 96.7% chance to win (as returned)', 'doc_latency_ms: v2 +1.9% lift, 41.0% chance to win (as returned)'],
  losingGuardrailsAccepted: [] as { metric: string; chanceToWin: number; lift: number }[],
};

const revertEntry = {
  at: '2026-11-17T11:05:00Z',
  experimentId: 8,
  experiment: 'shop:1.6 vs shop:1.5',
  decision: 'reverted' as const,
  variant: 'control',
  release: 'shop:1.5',
  replaced: 'shop:1.6',
  results: ['order_placed: v2 +31.0% lift, 99.8% chance to win (as returned)', 'doc_latency_ms: v2 +268.3% lift, 0.0% chance to win (as returned)'],
  losingGuardrailsAccepted: [] as { metric: string; chanceToWin: number; lift: number }[],
};

const base = () => ({
  simulated: true as const,
  dashboardUrl: DASH,
  releases: ['shop:1.4', 'shop:1.5', 'shop:1.6'],
  preview: { active: false, release: null as string | null },
  job: null as null | {
    id: string; action: string; status: 'running' | 'done' | 'failed'; startedAt: string; finishedAt: string | null;
    log: { at: string; text: string }[]; error: string | null; result: unknown;
  },
  totals: { visitorsSent: 0, eventsAccepted: 0 as number | null, eventsRejected: 0 as number | null },
});

export const fixtures = {
  /** A fresh experiment: nothing sent yet. */
  fresh: () => ({
    ...base(),
    links: links(7),
    live: 'shop:1.4',
    next: 'shop:1.6',
    experiment: experiment7(),
    results: null,
    ledger: [],
    steps: steps('visitors'),
    current: 'visitors' as const,
  }),

  /** Visitors sent; Flagsmith refreshed a minute ago, so the next refresh waits. */
  scoreWaiting: () => ({
    ...fixtures.fresh(),
    results: { ...winningResults(), winner: null, refreshAllowedAt: '2026-11-17T10:17:00Z' },
    steps: steps('score'),
    current: 'score' as const,
    totals: { visitorsSent: 1500, eventsAccepted: 9210, eventsRejected: 0 },
  }),

  /** Results in: v2 is winning, no guardrail losing. */
  v2Winner: () => ({
    ...fixtures.fresh(),
    results: winningResults(),
    steps: steps('decide'),
    current: 'decide' as const,
    totals: { visitorsSent: 1500, eventsAccepted: 9210, eventsRejected: 0 },
  }),

  /** shop:1.6 wins on orders but loses doc_latency_ms. */
  losingGuardrail: () => ({
    ...base(),
    links: links(8),
    live: 'shop:1.5',
    next: null,
    experiment: experiment8(),
    results: losingResults(),
    ledger: [shipEntry],
    steps: steps('decide'),
    current: 'decide' as const,
    totals: { visitorsSent: 3000, eventsAccepted: 17910, eventsRejected: 0 },
  }),

  /** Shipped: completed experiment, everyone on shop:1.5; verify is next and swing is available. */
  shipped: () => ({
    ...fixtures.v2Winner(),
    experiment: experiment7('completed'),
    live: 'shop:1.5',
    ledger: [shipEntry],
    steps: steps('verify'),
    current: 'verify' as const,
  }),

  /** After a swing back: everyone on shop:1.4 again. */
  swungBack: () => ({
    ...fixtures.shipped(),
    live: 'shop:1.4',
    steps: steps('preview', 'done'),
    current: 'preview' as const,
  }),

  /** Preview on for shop:1.6; the next experiment is the next step. */
  previewActive: () => ({
    ...fixtures.shipped(),
    preview: { active: true, release: 'shop:1.6' },
    links: links(7, 'http://localhost:8080/__switchyard/preview?token=abc'),
    steps: steps('release'),
    current: 'release' as const,
  }),

  /** Every step done: the finale. */
  finale: () => ({
    ...fixtures.losingGuardrail(),
    experiment: { ...experiment8(), status: 'completed' as const },
    ledger: [shipEntry, revertEntry],
    steps: steps('reset', 'done'),
    current: 'reset' as const,
  }),

  /** Sending visitors right now. */
  runningJob: () => ({
    ...fixtures.fresh(),
    job: {
      id: 'job-1',
      action: 'visitors',
      status: 'running' as const,
      startedAt: '2026-11-17T10:05:00Z',
      finishedAt: null,
      log: [
        { at: '2026-11-17T10:05:00Z', text: 'Sending 1,500 simulated visitors through the proxy' },
        { at: '2026-11-17T10:05:04Z', text: '500 of 1,500 visitors done' },
      ],
      error: null,
      result: null,
    },
  }),

  /** Ship refused: the winner is losing a guardrail. */
  failedJob: () => ({
    ...fixtures.losingGuardrail(),
    job: {
      id: 'job-9',
      action: 'ship',
      status: 'failed' as const,
      startedAt: '2026-11-17T10:55:00Z',
      finishedAt: '2026-11-17T10:55:02Z',
      log: [{ at: '2026-11-17T10:55:00Z', text: 'Reading Flagsmith results' }],
      error: 'v2 is losing a guardrail; ship needs acceptLosingGuardrails',
      result: null,
    },
  }),

  /** Verify finished. */
  verified: () => ({
    ...fixtures.shipped(),
    steps: steps('preview'),
    current: 'preview' as const,
    job: {
      id: 'job-4',
      action: 'verify',
      status: 'done' as const,
      startedAt: '2026-11-17T10:21:00Z',
      finishedAt: '2026-11-17T10:21:07Z',
      log: [{ at: '2026-11-17T10:21:00Z', text: 'Sending 50 new visitors' }],
      error: null,
      result: { byRelease: { 'shop:1.5': 50 }, expected: 'shop:1.5', leftovers: 0 },
    },
  }),
};

export type FixtureName = keyof typeof fixtures;
