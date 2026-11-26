// The simple judge page's wording and rules: what the page says and which one button it offers, read off the judge
// state (/api/judge/state). Pure functions, no DOM, so the tests can check every sentence. demo.js draws them.
//
// The page tells one story over and over, in four fixed steps per test:
//   1 Start a test   2 Send shoppers   3 Ask Flagsmith   4 Decide
// then one button for the next test. Step titles never change; only the button and the result lines do.

export const SHOPPERS = 1500; // per "Send shoppers": enough for Flagsmith to call the demo's releases on its first look

const NAMES = { 'shop:1.4': 'Classic', 'shop:1.5': 'Express', 'shop:1.6': 'Bold' };

/** "shop:1.5" → "1.5 Express"; an unknown label is shown as it is. */
export function label(release) {
  if (!release) return 'no release';
  const short = String(release).replace(/^[^:]*:/, '');
  return NAMES[release] ? `${short} ${NAMES[release]}` : short;
}

const int = (n) => Math.round(n).toLocaleString('en-GB');
const pct = (x, digits = 1) => `${(x * 100).toFixed(digits)}%`;

// Flagsmith's metric names, in words a judge reads without a glossary.
const METRICS = {
  order_placed: { name: 'Orders', hint: 'share of shoppers who placed an order' },
  add_to_cart: { name: 'Added to cart', hint: 'share of shoppers who added something' },
  doc_latency_ms: { name: 'Page load time', hint: 'average time to serve a page' },
  server_error: { name: 'Server errors', hint: 'pages that failed' },
};
export function metricName(name) {
  return METRICS[name]?.name ?? String(name).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
const ROLES = { goal: 'Goal', guardrail: 'Safety check', secondary: 'Also watched' };

function valueText(metric, arm) {
  if (!arm) return '—';
  if (metric.aggregation === 'occurrence') return pct(arm.mean);
  if (/_ms$/.test(metric.name)) return `${Math.round(arm.mean)} ms`;
  if (metric.name === 'server_error') return arm.mean === 0 ? 'none' : arm.mean.toFixed(3);
  return arm.mean.toFixed(2);
}

const lowerIsBetter = (m) => m.direction === 'down';

/** How much worse or better the new version is, in plain words: "2.4× slower", "+19% more". */
function changeText(m) {
  const a = m.arms?.control?.mean;
  const b = m.arms?.v2?.mean;
  if (typeof a !== 'number' || typeof b !== 'number' || a === 0) return '';
  if (/_ms$/.test(m.name)) {
    const r = b / a;
    if (r >= 1.15) return `${r.toFixed(1)}× slower`;
    if (r <= 1 / 1.15) return `${(1 / r).toFixed(1)}× faster`;
    return 'about the same';
  }
  const lift = b / a - 1;
  if (Math.abs(lift) < 0.02) return 'about the same';
  return `${lift > 0 ? '+' : '−'}${Math.round(Math.abs(lift) * 100)}%`;
}

/**
 * Flagsmith's results as rows: the metric in plain words, its value for each version, and Flagsmith's call on the
 * new version. Only Flagsmith's own numbers; nothing is computed here but the ratio shown next to them.
 */
export function findings(s) {
  const metrics = s?.results?.metrics ?? [];
  const v2 = s?.experiment?.v2;
  return metrics.map((m) => {
    const name = metricName(m.name);
    let word = 'No clear difference';
    let tone = 'neutral';
    if (m.verdict === 'winning') [word, tone] = ['Better', 'good'];
    else if (m.verdict === 'losing') [word, tone] = ['Worse', 'bad'];
    else if (m.verdict === 'collecting') word = 'Not enough data yet';
    else if (m.verdict === 'no-events') word = m.name === 'server_error' ? 'None on either' : 'No events yet';
    let note = '';
    if (m.v2 && m.verdict !== 'no-events') {
      const sure = m.v2.chanceToWin;
      note =
        m.role === 'goal'
          ? `Flagsmith: ${pct(sure, 0)} chance ${label(v2)} is better`
          : m.verdict === 'losing'
            ? `${changeText(m)} on ${label(v2)}`
            : changeText(m);
      if (m.role !== 'goal' && note === 'about the same') note = '';
    }
    return {
      key: m.name,
      name,
      technical: m.name,
      hint: METRICS[m.name]?.hint ?? '',
      role: m.role,
      roleText: ROLES[m.role] ?? m.role,
      current: valueText(m, m.arms?.control),
      next: valueText(m, m.arms?.v2),
      word,
      tone,
      note,
      lowerIsBetter: lowerIsBetter(m),
    };
  });
}

/** Flagsmith's verdict in one sentence, and what to do about it. Null before there are results. */
export function verdict(s) {
  const r = s?.results;
  const e = s?.experiment;
  if (!r || !e) return null;
  const rec = r.recommendation;
  const now = label(e.control);
  const next = label(e.v2);
  const goal = r.metrics.find((m) => m.role === 'goal');
  const orders = goal?.arms?.v2 && goal?.arms?.control ? ` (${pct(goal.arms.v2.mean)} vs ${pct(goal.arms.control.mean)})` : '';
  const sure = rec?.chanceToWin != null ? pct(rec.chanceToWin, 0) : null;
  if (!rec || rec.call === 'keep-running') {
    const why = sure ? `Flagsmith is only ${sure} sure ${next} is better; it calls a winner at 95%.` : 'Flagsmith has no result on orders yet.';
    return { call: 'keep-running', tone: 'wait', title: 'Not sure yet', text: `${why} Send more shoppers, then ask again.` };
  }
  if (rec.call === 'ship') {
    return {
      call: 'ship',
      tone: 'good',
      title: `${next} wins`,
      text: `${next} gets more orders${orders} and every safety check is fine. Flagsmith is ${sure} sure it's better.`,
    };
  }
  const losing = r.losingGuardrails ?? [];
  if (losing.length) {
    const parts = losing.map((g) => {
      const m = r.metrics.find((x) => x.name === g.metric);
      if (m && /_ms$/.test(m.name)) {
        return `its pages load ${changeText(m)} (${valueText(m, m.arms.v2)} vs ${valueText(m, m.arms.control)})`;
      }
      return `${metricName(g.metric).toLowerCase()} got worse`;
    });
    const sells = goal?.verdict === 'winning' ? `${next} gets more orders${orders}, but ` : `On ${next}, `;
    return {
      call: 'revert',
      tone: 'bad',
      title: 'A safety check failed',
      text: `${sells}${parts.join(' and ')}. Flagsmith marks the release unhealthy, so the safe call is to keep everyone on ${now}.`,
    };
  }
  return { call: 'revert', tone: 'bad', title: `${now} stays`, text: `${next} gets fewer orders${orders}. Keep everyone on ${now}.` };
}

// The four steps. Titles are fixed; the server's own step list (deriveSteps) says which are done.
export const STEPS = [
  { id: 'start', title: 'Start a test' },
  { id: 'visitors', title: 'Send shoppers' },
  { id: 'score', title: 'Ask Flagsmith' },
  { id: 'decide', title: 'Decide' },
];

/** The ledger entry that decided this experiment, if any (the ledger is oldest first). */
function decisionOf(s) {
  const id = s?.experiment?.id;
  return [...(s?.ledger ?? [])].reverse().find((e) => e.experimentId === id && e.decision !== 'kept-running') ?? null;
}

const serverStatus = (s, id) => s?.steps?.find((x) => x.id === id)?.status ?? 'todo';

/**
 * The whole page in one model.
 *   now       one sentence: who gets what right now
 *   versions  the two versions in this test, with their role and badge
 *   steps     the four steps with status 'done' | 'current' | 'todo', and a one-line result once done
 *   action    the one button for the current step (or the next test), with a sentence on what it does
 *   alt       a quieter second choice, when there is a sensible one
 */
export function model(s, opts = {}) {
  const shoppers = opts.shoppers ?? SHOPPERS;
  const e = s?.experiment ?? null;
  const out = { now: '', versions: [], steps: [], action: null, alt: null, verdict: null, findings: [], outcome: null, finished: false };

  const firstTest = (verb = 'Start a test') => {
    const [a, b] = s?.releases ?? [];
    return {
      action: 'reset',
      label: a && b ? `${verb}: ${label(b)} against ${label(a)}` : verb,
      explain: `Everyone goes back to ${label(a)}, then Flagsmith starts an experiment showing ${label(b)} to half the shoppers. No app code changes; it's all one flag in Flagsmith.`,
    };
  };

  if (!e) {
    out.now = 'No test has run yet.';
    out.steps = STEPS.map((st, i) => ({ ...st, n: i + 1, status: i === 0 ? 'current' : 'todo', result: '' }));
    out.action = firstTest();
    return out;
  }

  const done = e.status === 'completed';
  const decision = done ? decisionOf(s) : null;
  const shipped = done && s.live === e.v2;
  const armPct = (key) => s.routing?.experiment?.arms?.find((a) => a.key === key)?.pct;

  out.now = done
    ? `Everyone gets ${label(s.live)}. No test is running.`
    : `Flagsmith is testing ${label(e.v2)} against ${label(e.control)}. Each new shopper gets one of them.`;

  out.versions = [
    { key: 'control', release: e.control, role: 'Current version', badge: done ? (shipped ? 'Replaced' : 'Kept · everyone gets it') : `${armPct('control') ?? 50}% of shoppers`, state: done ? (shipped ? 'out' : 'winner') : 'testing' },
    { key: 'v2', release: e.v2, role: 'New version', badge: done ? (shipped ? 'Shipped · everyone gets it' : 'Rolled back') : `${armPct('v2') ?? 50}% of shoppers`, state: done ? (shipped ? 'winner' : 'out') : 'testing' },
  ];

  out.findings = findings(s);
  out.verdict = verdict(s);

  const goal = s.results?.metrics?.find((m) => m.role === 'goal');
  const counted = goal ? (goal.arms?.control?.n ?? 0) + (goal.arms?.v2?.n ?? 0) : 0;
  const status = {
    start: 'done',
    visitors: done ? 'done' : serverStatus(s, 'visitors') === 'done' ? 'done' : 'current',
    score: done ? 'done' : serverStatus(s, 'score'),
    decide: done ? 'done' : serverStatus(s, 'decide'),
  };
  if (status.score === 'optional') status.score = 'todo';
  if (status.decide === 'optional') status.decide = 'todo';
  const results = {
    start: `Experiment #${e.id} in Flagsmith: ${label(e.v2)} against ${label(e.control)}.`,
    visitors: counted ? `Flagsmith counted ${int(counted)} shoppers.` : s.totals?.visitorsSent ? `${int(s.totals.visitorsSent)} shoppers went through Turnout.` : '',
    score: out.verdict ? out.verdict.title : '',
    decide: decision
      ? decision.decision === 'shipped'
        ? `Shipped: everyone gets ${label(decision.release)}.`
        : `Rolled back: everyone stays on ${label(decision.release)}${decision.by === 'guard' ? ' (the guard did it automatically)' : ''}.`
      : done
        ? `Finished: everyone gets ${label(s.live)}.`
        : '',
  };
  out.steps = STEPS.map((st, i) => ({ ...st, n: i + 1, status: status[st.id], result: status[st.id] === 'done' ? results[st.id] : '' }));

  if (done) {
    out.finished = true;
    out.outcome = {
      shipped,
      title: shipped ? `${label(e.v2)} shipped to everyone` : `${label(e.v2)} rolled back`,
      text: shipped
        ? `One flag change: Flagsmith's default is now ${label(e.v2)}, so every shopper gets it. No deploy.`
        : `One flag change: Flagsmith's default stays ${label(e.control)}, so every shopper gets it. No deploy.`,
      verified: serverStatus(s, 'verify') === 'done',
    };
    out.action = s.next
      ? {
          action: 'release',
          label: `Test the next version: ${label(s.next)}`,
          explain: `Flagsmith starts a new experiment on the same flag: ${label(s.next)} against ${label(s.live)}. Still no app code.`,
        }
      : firstTest('Start over');
    return out;
  }

  const current = out.steps.find((st) => st.status === 'current')?.id ?? 'visitors';
  if (current === 'visitors') {
    const again = counted > 0;
    out.action = {
      action: 'visitors',
      label: `Send ${int(shoppers)} ${again ? 'more ' : ''}shoppers`,
      explain: `Simulated shoppers browse the shop through Turnout. Flagsmith picks a version for each one, and their page views and orders go to Flagsmith. About ${Math.round(shoppers / 60)} seconds.`,
    };
  } else if (current === 'score') {
    const wait = s.results?.refreshAllowedAt ? Date.parse(s.results.refreshAllowedAt) - (opts.now ?? Date.now()) : 0;
    out.action = {
      action: 'score',
      label: 'Ask Flagsmith for the results',
      explain: 'Flagsmith compares the two versions with its own statistics. Turnout does no maths of its own.',
      ...(wait > 0 ? { waitUntil: s.results.refreshAllowedAt } : {}),
    };
  } else {
    const v = out.verdict;
    if (v?.call === 'ship') {
      out.action = { action: 'ship', label: `Ship ${label(e.v2)} to everyone`, explain: `Flagsmith's flag default becomes ${label(e.v2)} and the experiment ends. Every shopper gets it from the next page.` };
      out.alt = { action: 'revert', label: `Keep ${label(e.control)} instead` };
    } else if (v?.call === 'revert') {
      out.action = { action: 'revert', label: `Roll back to ${label(e.control)}`, explain: `The experiment ends and Flagsmith's flag default stays ${label(e.control)}. Every shopper gets it from the next page.` };
    } else {
      out.action = { action: 'keep-running', label: 'Keep testing', explain: 'Nothing changes in Flagsmith: the test keeps running, and you send more shoppers.' };
      out.alt = { action: 'revert', label: `Stop and keep ${label(e.control)}` };
    }
  }
  return out;
}

const JOB_TITLES = {
  visitors: 'Sending shoppers',
  score: 'Flagsmith is computing the results',
  ship: 'Shipping',
  revert: 'Rolling back',
  'keep-running': 'Keeping the test running',
  verify: 'Checking new shoppers',
  release: 'Starting the test',
  reset: 'Starting the test',
  preview: 'Turning on the preview',
  'swing-back': 'Changing the flag',
  'swing-forward': 'Changing the flag',
};

/** A running or finished job in one line, with progress when there is any. */
export function jobView(job) {
  if (!job) return null;
  const stage = job.stages?.find((x) => x.status === 'running') ?? null;
  const p = job.progress;
  return {
    action: job.action,
    running: job.status === 'running',
    failed: job.status === 'failed',
    title: JOB_TITLES[job.action] ?? 'Working',
    detail: job.status === 'failed' ? (job.error ?? 'It failed.') : p && p.total ? `${int(p.done)} of ${int(p.total)} shoppers` : (stage?.title ?? ''),
    fraction: p && p.total ? p.done / p.total : null,
  };
}

/** Who gets what, from a routing snapshot: "half 1.5 Express, half 1.6 Bold" or "everyone: 1.5 Express". */
export function routingText(r) {
  if (!r) return '—';
  const x = r.experiment;
  if (x && x.enrolledPct > 0) {
    const arms = x.arms.filter((a) => a.pct > 0);
    return `${arms.map((a) => `${a.pct}% ${label(a.release)}`).join(', ')} (experiment #${x.id})`;
  }
  return `everyone: ${label(r.defaultRelease)}`;
}

/** What a decision changed in Flagsmith, before → after, from the job that made it. */
export function changes(job) {
  if (!job?.changes?.after || !['ship', 'revert', 'release', 'reset'].includes(job.action)) return null;
  return { before: routingText(job.changes.before), after: routingText(job.changes.after) };
}

/** The check after a decision: how many brand-new shoppers got the release everyone should get. */
export function verifyText(job) {
  const r = job?.action === 'verify' && job.status === 'done' ? job.result : null;
  if (!r?.byRelease) return null;
  const total = Object.values(r.byRelease).reduce((a, b) => a + b, 0);
  const right = r.byRelease[r.expected] ?? 0;
  return {
    ok: right === total && (r.leftovers === null || r.leftovers === 0),
    text: `${right} of ${total} brand-new shoppers got ${label(r.expected)}${r.leftovers === 0 ? ', and no experiment split is left on the flag' : ''}.`,
  };
}

/** Earlier decisions, newest first, one line each. */
export function history(ledger, limit = 6) {
  return [...(ledger ?? [])]
    .reverse()
    .filter((e) => e.decision !== 'kept-running')
    .slice(0, limit)
    .map((e) => {
      const tested = /: (\S+) vs (\S+)$/.exec(e.experiment ?? '');
      const v2 = tested?.[1] ?? e.release;
      return {
        at: e.at,
        tone: e.decision === 'shipped' ? 'good' : 'bad',
        text: e.decision === 'shipped' ? `${label(e.release)} shipped (replaced ${label(e.replaced)})` : `${label(v2)} rolled back, ${label(e.release)} kept`,
      };
    });
}
