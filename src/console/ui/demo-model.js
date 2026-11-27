// The simple judge page's wording and rules: what the page says and which one button it offers, read off the judge
// state (/api/judge/state). Pure functions, no DOM, so the tests can check every sentence. demo.js draws them.
//
// The page runs one test at a time, of the kind the judge picks: A/A (the same version on both sides, a fairness
// check), A/B, A/B/C… A is what everyone gets now; B, C… are new versions, each shown to an even share of shoppers.
// Four fixed steps per test (Start the test, Send shoppers, Ask Flagsmith, Decide), one button at a time.

export const SHOPPERS_PER_VERSION = 700; // enough for Flagsmith to call the demo's versions on its first look
/** Shoppers per "Send shoppers": 700 per version in the test (1,400 for A/B or A/A, 2,100 for A/B/C). */
export const shoppersFor = (versions) => Math.min(5000, SHOPPERS_PER_VERSION * Math.max(2, versions || 2));

const NAMES = { 'shop:1.4': 'Classic', 'shop:1.5': 'Express', 'shop:1.6': 'Bold' };
const LETTERS = 'ABCDEFGH';

// Display names for other apps' releases (Try it with your app: try:a → the image or repository name).
let EXTRA_NAMES = {};
export function setNames(map) {
  EXTRA_NAMES = map && typeof map === 'object' ? map : {};
}

/** "shop:1.5" → "1.5 Express"; an unknown label is shown as it is. */
export function label(release) {
  if (!release) return 'no release';
  if (EXTRA_NAMES[release]) return EXTRA_NAMES[release];
  const short = String(release).replace(/^[^:]*:/, '');
  return NAMES[release] ? `${short} ${NAMES[release]}` : short;
}

const int = (n) => Math.round(n).toLocaleString('en-GB');
const pct = (x, digits = 1) => `${(x * 100).toFixed(digits)}%`;

// Flagsmith's metric names, in words a judge reads without a glossary.
const METRICS = {
  order_placed: { name: 'Orders', hint: 'shoppers who placed an order' },
  add_to_cart: { name: 'Added to cart', hint: 'shoppers who added something' },
  doc_latency_ms: { name: 'Page load time', hint: 'average time to serve a page' },
  lcp_ms: { name: 'Largest paint (real browsers)', hint: "when a page's main content appeared, in visitors' own browsers" },
  cls: { name: 'Layout shift (real browsers)', hint: "how much a page jumped while loading, in visitors' own browsers" },
  vitals_reported: { name: 'Browsers that reported page speed', hint: 'page speed in browsers is compared only when this is about the same for each version' },
  server_error: { name: 'Server errors', hint: 'pages that failed' },
};
export function metricName(name) {
  return METRICS[name]?.name ?? String(name).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
const ROLES = { goal: 'Goal', guardrail: 'Safety check', secondary: 'Also watched' };

/**
 * The versions in the test, lettered: A is control (what everyone gets now), then B, C… for the new versions.
 * From the state's arms (an A/B/C test), else control and v2.
 */
export function arms(s) {
  const e = s?.experiment;
  if (!e) return [];
  const list = e.arms?.length ? e.arms : [{ key: 'control', release: e.control }, { key: 'v2', release: e.v2 }];
  // A/A: the same release on both arms. The copy is A′, never B: nothing new is being tested.
  const aa = list.length === 2 && list[0].release === list[1].release;
  return list.map((a, i) => {
    const letter = aa && i === 1 ? 'A′' : (LETTERS[i] ?? '?');
    return { key: a.key, release: a.release, letter, name: `${letter} · ${label(a.release)}` };
  });
}

/** Whether the test is an A/A test: one release on both arms. */
export const isAA = (s) => {
  const list = arms(s);
  return list.length === 2 && list[0].release === list[1].release;
};

/** "A/B/C" for 3 versions, "A/A" for an A/A test. */
export const kindLabel = (n) => (n === 1 ? 'A/A' : LETTERS.slice(0, n).split('').join('/'));

/** The kinds of test this setup can run: A/A, then A/B, A/B/C… up to the number of releases. */
export function kinds(releases) {
  const n = releases?.length ?? 0;
  if (n < 2) return [];
  const blurb = (k) =>
    k === 1
      ? 'The same version on both sides. Flagsmith should find no difference: a check that the split and the counting are fair.'
      : k === 2
        ? 'One new version against the one everyone gets now.'
        : `${k - 1} new versions at once, each against the one everyone gets now.`;
  return [1, ...Array.from({ length: n - 1 }, (_, i) => i + 2)].map((k) => ({ arms: k, label: kindLabel(k), blurb: blurb(k) }));
}

/** The kind of the test on the page: 1 for A/A, else the number of versions; null without one. */
export function kindOf(s) {
  if (!s?.experiment) return null;
  return isAA(s) ? 1 : arms(s).length;
}

function valueText(metric, arm) {
  if (!arm) return '—';
  if (metric.aggregation === 'occurrence') return pct(arm.mean);
  if (/_ms$/.test(metric.name)) return `${Math.round(arm.mean)} ms`;
  if (metric.name === 'server_error') return arm.mean === 0 ? 'none' : arm.mean.toFixed(3);
  if (metric.name === 'cls') return arm.mean.toFixed(3);
  return arm.mean.toFixed(2);
}

/** How a new version compares with A on one metric, in plain words: "2.4× slower", "+19%". */
function changeText(m, key) {
  const a = m.arms?.control?.mean;
  const b = m.arms?.[key]?.mean;
  if (typeof a !== 'number' || typeof b !== 'number' || a === 0) return '';
  if (/_ms$/.test(m.name)) {
    const r = b / a;
    if (r >= 1.15) return `${r.toFixed(1)}× slower`;
    if (r <= 1 / 1.15) return `${(1 / r).toFixed(1)}× faster`;
    return '';
  }
  const lift = b / a - 1;
  if (Math.abs(lift) < 0.02) return '';
  return `${lift > 0 ? '+' : '−'}${Math.round(Math.abs(lift) * 100)}%`;
}

const inferenceOf = (m, key) => m.byArm?.[key] ?? (key === 'v2' && m.v2 ? { ...m.v2, verdict: m.verdict } : null);

/**
 * Flagsmith's results as rows: the metric in plain words, then a cell per version. A's cell is the baseline; each
 * new version's cell carries Flagsmith's call against A. Only Flagsmith's numbers; the ratio is the only arithmetic.
 */
// Page speed from visitors' browsers: shown only when some browser reported it. Simulated shoppers never do, so on
// the demo those rows would read 0 ms, "None" everywhere and look broken.
const BROWSER_METRICS = new Set(['lcp_ms', 'cls', 'vitals_reported']);
const browserReported = (metrics) => metrics.some((m) => m.name === 'vitals_reported' && Object.values(m.arms ?? {}).some((a) => Number(a.mean) > 0));

export function findings(s) {
  const list = arms(s);
  const all = s?.results?.metrics ?? [];
  const shown = browserReported(all) ? all : all.filter((m) => !BROWSER_METRICS.has(m.name));
  return shown.map((m) => ({
    key: m.name,
    name: metricName(m.name),
    hint: METRICS[m.name]?.hint ?? '',
    role: m.role,
    roleText: ROLES[m.role] ?? m.role,
    cells: list.map((a) => {
      const value = valueText(m, m.arms?.[a.key]);
      if (a.key === 'control') return { key: a.key, value, word: '', tone: 'base', note: '' };
      const x = inferenceOf(m, a.key);
      const verdict = x?.verdict ?? (m.verdict === 'no-events' ? 'no-events' : 'collecting');
      let word = 'No clear difference';
      let tone = 'neutral';
      // A safety check Flagsmith calls losing but within Turnout's margin (more than 5% worse and, for page speed,
      // at least 20 ms) isn't a failure: the decision ignores it, so the table mustn't show it in red.
      const failsHere = m.role !== 'guardrail' || (s.results?.losingByArm?.[a.key] ?? (a.key === 'v2' ? s.results?.losingGuardrails : []) ?? []).some((g) => g.metric === m.name);
      if (verdict === 'winning') [word, tone] = ['Better', 'good'];
      else if (verdict === 'losing' && !failsHere) [word, tone] = ['Slightly worse', 'neutral'];
      else if (verdict === 'losing') [word, tone] = ['Worse', 'bad'];
      else if (verdict === 'collecting') word = m.verdict === 'no-events' ? 'None' : 'Not enough data';
      else if (verdict === 'no-events') word = 'None';
      if (m.verdict === 'no-events') [word, tone] = ['None', 'neutral'];
      const note = m.verdict === 'no-events'
        ? ''
        : m.role === 'goal' && x
          ? `${pct(x.chanceToWin, 0)} sure it beats A`
          : word === 'Slightly worse'
            ? 'within the safety margin'
            : changeText(m, a.key);
      return { key: a.key, value, word, tone, note };
    }),
  }));
}

/** Why a new version can't ship, in plain words: its losing safety checks. */
function failedChecks(s, key) {
  const losing = s.results?.losingByArm?.[key] ?? (key === 'v2' ? s.results?.losingGuardrails : []) ?? [];
  return losing.map((g) => {
    const m = s.results.metrics.find((x) => x.name === g.metric);
    if (m && /_ms$/.test(m.name)) return `its pages load ${changeText(m, key) || 'slower'} (${valueText(m, m.arms[key])} vs ${valueText(m, m.arms.control)})`;
    return `${metricName(g.metric).toLowerCase()} got worse`;
  });
}

/** Flagsmith's verdict in one sentence, and what to do about it. Null before there are results. */
export function verdict(s) {
  const r = s?.results;
  const e = s?.experiment;
  if (!r || !e) return null;
  const list = arms(s);
  const a = list[0];
  const rec = r.recommendation;
  const goal = r.metrics.find((m) => m.role === 'goal');
  // No goal given: the primary metric is page speed (lower is better), and the words follow it.
  const speed = /_ms$/.test(goal?.name ?? '');
  const fmt = (x) => (speed ? `${Math.round(x)} ms` : pct(x));
  const orders = (key) => (goal?.arms?.[key] && goal?.arms?.control ? ` (${fmt(goal.arms[key].mean)} vs ${fmt(goal.arms.control.mean)})` : '');
  const others = (except) =>
    list.slice(1).filter((x) => x.key !== except).map((x) => {
      const failed = failedChecks(s, x.key);
      const g = goal && inferenceOf(goal, x.key);
      if (failed.length) return `${x.name}${g?.verdict === 'winning' ? ' sold more too, but' : ':'} ${failed.join(' and ')}, so it's out.`;
      if (g?.verdict === 'losing') return speed ? `${x.name} loaded pages slower.` : `${x.name} got fewer orders.`;
      return `${x.name} wasn't clearly better.`;
    });
  if (isAA(s)) {
    const differs = rec?.call === 'ship' || (r.losingByArm?.v2?.length ?? 0) > 0 || goal?.byArm?.v2?.verdict === 'losing';
    return differs
      ? {
          call: 'aa',
          tone: 'wait',
          title: 'A difference between identical copies',
          text: `Flagsmith sees a difference between two copies of ${a.name}. By chance that happens about 1 time in 20; if it keeps happening, something in the setup favours one side.`,
        }
      : {
          call: 'aa',
          tone: 'good',
          title: 'No difference, as expected',
          text: `Both sides got ${a.name} and Flagsmith finds no real difference${orders('v2')}: the split and the counting are fair, so a real test can be trusted.`,
        };
  }
  if (!rec || rec.call === 'keep-running') {
    const best = list.find((x) => x.key === rec?.variant);
    const c = rec?.chanceToWin;
    const sure = c == null || !best
      ? `Flagsmith has no result on ${speed ? 'page speed' : 'orders'} yet.`
      : c >= 0.95
        ? `Flagsmith is ${pct(c, 0)} sure ${best.name} beats A, but its likely range still includes no gain at all, so it won't call it yet.`
        : `Flagsmith is only ${pct(c, 0)} sure ${best.name} beats A; it calls a winner at 95%.`;
    return { call: 'keep-running', tone: 'wait', title: 'Not sure yet', text: `${sure} Send more shoppers, then ask again.` };
  }
  if (rec.call === 'ship') {
    const w = list.find((x) => x.key === rec.variant) ?? list[1];
    return {
      call: 'ship',
      variant: w.key,
      tone: 'good',
      title: `${w.name} wins`,
      text: [`${w.name} ${speed ? 'loads pages faster than' : 'gets more orders than'} A${orders(w.key)}, Flagsmith is ${pct(rec.chanceToWin, 0)} sure, and every safety check is fine.`, ...others(w.key), ...watchedWorse(r, w)].join(' '),
    };
  }
  const failing = list.slice(1).filter((x) => failedChecks(s, x.key).length);
  return {
    call: 'revert',
    tone: 'bad',
    title: failing.length ? 'A safety check failed' : `${a.name} stays`,
    text: [...others(null), `Keep everyone on ${a.name}.`].join(' '),
  };
}

// The four steps. Titles are fixed; the server's own step list (deriveSteps) says which are done.
export const STEPS = [
  { id: 'start', title: 'Start the test' },
  { id: 'visitors', title: 'Send shoppers' },
  { id: 'score', title: 'Ask Flagsmith' },
  { id: 'decide', title: 'Decide' },
];

/** The ledger entry that decided this experiment, if any (the ledger is oldest first). */
function decisionOf(s) {
  const id = s?.experiment?.id;
  return [...(s?.ledger ?? [])].reverse().find((x) => x.experimentId === id && x.decision !== 'kept-running') ?? null;
}

const serverStatus = (s, id) => s?.steps?.find((x) => x.id === id)?.status ?? 'todo';

/** The button that starts a test of the chosen kind (1 = A/A, 2 = A/B, 3 = A/B/C…); the most versions by default. */
export function startAction(s, verb, kind) {
  const [a, ...rest] = s?.releases ?? [];
  const n = Math.min(Math.max(1, kind ?? (s?.releases?.length ?? 2)), s?.releases?.length ?? 2);
  const tested = rest.slice(0, n - 1);
  const names = tested.map((r, i) => `${LETTERS[i + 1]} · ${label(r)}`);
  const article = /^A/.test(kindLabel(n)) ? 'an' : 'a';
  const share = n === 2 ? 'half the shoppers' : n === 3 ? 'a third of the shoppers each' : `1/${n} of the shoppers each`;
  return {
    action: 'start',
    arms: n,
    label: `${verb} ${article} ${kindLabel(n)} test`,
    explain:
      n === 1
        ? `Everyone goes back to A · ${label(a)}, then Flagsmith splits shoppers between two identical copies of it. It should find no difference.`
        : `Everyone goes back to A · ${label(a)}, then Flagsmith shows ${names.join(' and ')} to ${share}.`,
  };
}

/**
 * The whole page in one model.
 *   now       one sentence: who gets what right now
 *   versions  the versions in this test (A, B, C), each with its role and badge
 *   steps     the four steps with status 'done' | 'current' | 'todo', and a one-line result once done
 *   action    the one button for the current step (or the next test), with a sentence on what it does
 *   alt       a quieter second choice, when there is a sensible one
 */
export function model(s, opts = {}) {
  const e = s?.experiment ?? null;
  const out = { now: '', versions: [], steps: [], action: null, alt: null, verdict: null, findings: [], outcome: null, finished: false, letters: '', aa: false };

  if (!e) {
    out.now = 'No test has run yet.';
    out.steps = STEPS.map((st, i) => ({ ...st, n: i + 1, status: i === 0 ? 'current' : 'todo', result: '' }));
    out.action = startAction(s, 'Start', opts.kind);
    return out;
  }

  const list = arms(s);
  const aa = isAA(s);
  out.aa = aa;
  const shoppers = opts.shoppers ?? shoppersFor(list.length);
  out.letters = aa ? 'A/A' : list.map((x) => x.letter).join('/');
  const done = e.status === 'completed';
  const decision = done ? decisionOf(s) : null;
  // The recorded decision first: while the next test starts, the flag is briefly back on A, and reading the live flag
  // turned a shipped B into "Rolled back". The live flag only for a decision with no record (made in Flagsmith).
  const recorded = decision?.decision === 'shipped' ? list.slice(1).find((x) => x.key === decision.variant || x.release === decision.release) ?? null : null;
  const shippedArm = done && !isAA(s) ? (decision ? recorded : list.slice(1).find((x) => x.release === s.live) ?? null) : null;
  const armPct = (key) => s.routing?.experiment?.arms?.find((x) => x.key === key)?.pct;

  out.now = done
    ? `Everyone gets ${(shippedArm ?? (decision ? list[0] : list.find((x) => x.release === s.live)))?.name ?? label(s.live)}. No test is running.`
    : aa
      ? `An A/A test: both sides get ${list[0].name}. Flagsmith counts each new shopper on one side.`
      : `Flagsmith is testing ${list.slice(1).map((x) => x.name).join(' and ')} against ${list[0].name}. Each new shopper gets one of them.`;

  out.versions = list.map((x) => {
    const isA = x.key === 'control';
    let badge = `${armPct(x.key) ?? Math.round(100 / list.length)}% of shoppers`;
    let state = 'testing';
    if (done) {
      if (aa) [badge, state] = isA ? ['Kept', 'winner'] : ['Copy', 'out'];
      else if (shippedArm) [badge, state] = x === shippedArm ? ['Shipped', 'winner'] : [isA ? 'Replaced' : 'Not shipped', 'out'];
      else [badge, state] = isA ? ['Kept', 'winner'] : ['Rolled back', 'out'];
    }
    return { ...x, role: isA ? 'Now' : aa ? 'Copy' : 'New', badge, state };
  });

  out.findings = findings(s);
  out.verdict = verdict(s);

  const goal = s.results?.metrics?.find((m) => m.role === 'goal');
  const counted = goal ? list.reduce((n, x) => n + (goal.arms?.[x.key]?.n ?? 0), 0) : 0;
  const status = {
    start: 'done',
    visitors: done ? 'done' : serverStatus(s, 'visitors') === 'done' ? 'done' : 'current',
    score: done ? 'done' : serverStatus(s, 'score'),
    decide: done ? 'done' : serverStatus(s, 'decide'),
  };
  if (status.score === 'optional') status.score = 'todo';
  if (status.decide === 'optional') status.decide = 'todo';
  const results = {
    start: `${out.letters} test, experiment #${e.id} in Flagsmith.`,
    visitors: counted ? `Flagsmith counted ${int(counted)} shoppers.` : s.totals?.visitorsSent ? `${int(s.totals.visitorsSent)} shoppers went through Turnout.` : '',
    score: out.verdict ? out.verdict.title : '',
    decide: decision && aa
      ? 'A/A check finished: everyone stays on A.'
      : decision
      ? decision.decision === 'shipped'
        ? `Shipped ${shippedArm?.name ?? label(decision.release)} to everyone.`
        : `Rolled back: everyone stays on ${list[0].name}${decision.by === 'guard' ? ' (the guard did it)' : ''}.`
      : done
        ? `Finished: everyone gets ${label(s.live)}.`
        : '',
  };
  out.steps = STEPS.map((st, i) => ({ ...st, n: i + 1, status: status[st.id], result: status[st.id] === 'done' ? results[st.id] : '' }));

  if (done) {
    out.finished = true;
    out.outcome = {
      shipped: Boolean(shippedArm),
      title: aa ? 'A/A check finished' : shippedArm ? `${shippedArm.name} shipped to everyone` : `Everyone stays on ${list[0].name}`,
      text: 'One flag change in Flagsmith, no deploy.',
      verified: serverStatus(s, 'verify') === 'done',
    };
    out.action = startAction(s, 'Run', opts.kind);
    return out;
  }

  const current = out.steps.find((st) => st.status === 'current')?.id ?? 'visitors';
  if (current === 'visitors') {
    const again = counted > 0;
    out.action = {
      action: 'visitors',
      label: `Send ${int(shoppers)} ${again ? 'more ' : ''}shoppers`,
      explain: `Simulated shoppers browse the shop through Turnout. Flagsmith picks ${list.map((x) => x.letter).join(', ').replace(/, (?=[^,]*$)/, ' or ')} for each one; their page views and orders go to Flagsmith. About ${Math.round(shoppers / 70)} seconds.`,
      shoppers,
    };
  } else if (current === 'score') {
    const wait = s.results?.refreshAllowedAt ? Date.parse(s.results.refreshAllowedAt) - (opts.now ?? Date.now()) : 0;
    out.action = {
      action: 'score',
      label: 'Ask Flagsmith for the results',
      explain: 'Flagsmith compares each new version with A using its own statistics. Turnout does no maths of its own.',
      ...(wait > 0 ? { waitUntil: s.results.refreshAllowedAt } : {}),
    };
  } else {
    const v = out.verdict;
    if (aa) {
      out.action = { action: 'revert', label: 'Finish the A/A check', explain: 'The test ends and everyone stays on A. Nothing changes for shoppers.' };
    } else if (v?.call === 'ship') {
      const w = list.find((x) => x.key === v.variant) ?? list[1];
      out.action = { action: 'ship', label: `Ship ${w.name} to everyone`, explain: `Flagsmith's flag default becomes ${w.name} and the test ends. Every shopper gets it from the next page.` };
      out.alt = { action: 'revert', label: `Keep ${list[0].name} instead` };
    } else if (v?.call === 'revert') {
      out.action = { action: 'revert', label: `Roll back to ${list[0].name}`, explain: `The test ends and Flagsmith's flag default stays ${list[0].name}. Every shopper gets it from the next page.` };
    } else {
      out.action = { action: 'keep-running', label: 'Keep testing', explain: 'Nothing changes in Flagsmith: the test keeps running, and you send more shoppers.' };
      out.alt = { action: 'revert', label: `Stop and keep ${list[0].name}` };
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
  abc: 'Starting the A/B/C test',
  start: 'Starting the test',
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
    detail: job.status === 'failed'
      ? (job.error ?? 'It failed.')
      : p && p.total
        ? `${int(p.done)} of ${int(p.total)} shoppers`
        : `${stage?.title ?? ''}${job.action === 'score' && job.status === 'running' ? ' (usually about 10 seconds: Flagsmith does the maths)' : ''}`,
    fraction: p && p.total ? p.done / p.total : null,
  };
}

/** Who gets what, from a routing snapshot: "34% 1.4 Classic, 33% 1.5 Express…" or "everyone: 1.5 Express". */
export function routingText(r) {
  if (!r) return '—';
  const x = r.experiment;
  if (x && x.enrolledPct > 0) {
    const split = x.arms.filter((a) => a.pct > 0);
    return `${split.map((a) => `${a.pct}% ${label(a.release)}`).join(', ')} (experiment #${x.id})`;
  }
  return `everyone: ${label(r.defaultRelease)}`;
}

/** What a decision changed in Flagsmith, before → after, from the job that made it. */
export function changes(job) {
  if (!job?.changes?.after || !['ship', 'revert', 'release', 'reset', 'abc', 'start'].includes(job.action)) return null;
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
    text: `${right} of ${total} brand-new shoppers got ${label(r.expected)}${r.leftovers === 0 ? '; no test split is left on the flag' : ''}.`,
  };
}

/** Earlier decisions, newest first, one line each. */
export function history(ledger, limit = 8) {
  return [...(ledger ?? [])]
    .reverse()
    .filter((x) => x.decision !== 'kept-running')
    .slice(0, limit)
    .map((x) => {
      const parts = String(x.experiment ?? '').replace(/^[^:]*:\s*/, '').split(/\s+vs\s+/);
      const tested = parts.length >= 2 ? parts.slice(0, -1) : [x.release];
      if (/: A\/A /.test(x.experiment ?? '')) return { at: x.at, tone: 'neutral', text: `A/A check on ${label(x.release)} finished` };
      return {
        at: x.at,
        tone: x.decision === 'shipped' ? 'good' : 'bad',
        text:
          x.decision === 'shipped'
            ? `${label(x.release)} shipped (replaced ${label(x.replaced)})`
            : `${tested.map(label).join(' and ')} rolled back, ${label(x.release)} kept`,
      };
    });
}

/** The versions a test of this kind will show, before it starts: A/A is A and A′, A/B is A and B, and so on. */
export function plannedVersions(releases, kind) {
  const list = releases ?? [];
  const n = Math.min(Math.max(1, kind), list.length);
  const picked = n === 1 ? [list[0], list[0]] : list.slice(0, n);
  return picked.map((release, i) => {
    const letter = n === 1 && i === 1 ? 'A′' : LETTERS[i];
    return { key: i === 0 ? 'control' : `v${i + 1}`, release, letter, name: `${letter} · ${label(release)}`, role: i === 0 ? 'Now' : 'New', badge: 'Starting…', state: 'testing' };
  });
}

/** Server mode's public page: what the autopilot does next, in one line. */
export function autopilotLine(s, nowMs = Date.now()) {
  const job = s?.job;
  if (job?.status === 'running') return `Running by itself: ${(JOB_TITLES[job.action] ?? 'working').toLowerCase()}…`;
  const ap = s?.autopilot;
  if (!ap) return 'Read-only: the steps run on the server.';
  if (ap.phase === 'paused') return 'Paused while someone uses the console on the server; it carries on by itself.';
  if (ap.phase === 'idle') return 'Waking up: the demo rests while nobody watches, and carries on now.';
  const next = ap.next;
  if (!next) return 'Running by itself: starting…';
  const at = Date.parse(next.at ?? '');
  const sec = Number.isFinite(at) ? Math.ceil((at - nowMs) / 1000) : 0;
  const when = sec > 90 ? `in about ${Math.round(sec / 60)} min` : sec > 0 ? `in ${sec} s` : 'any moment';
  return `Running by itself. Next: ${next.title.toLowerCase()}, ${when}.`;
}

/** Where this browser lands, from the proxy's receipt: { visited, variant, release, enrolled, viewing, receipt }. */
export function youText(you, s, live = false) {
  if (!you) return '';
  if (you.viewing) return `You're looking at ${label(you.release)} on its own (not counted).`;
  if (!you.visited && !you.release) return 'You: not in the shop yet (the Versions menu has its link).';
  // A browser that has a visitor cookie but never loaded a page (no event sent for it yet) isn't counted anywhere:
  // say which version it will get, never that Flagsmith counts it.
  const seen = Boolean(you.receipt);
  // Server mode: real visitors are counted in their own live experiment, never in the simulated test on this page.
  if (live) {
    if (!seen) return `You'll get ${label(you.release)} when you open the shop.`;
    return `You got ${label(you.release)}${you.enrolled ? ': Flagsmith counts you in the live test for real visitors' : ''}.`;
  }
  const list = arms(s);
  const mine = list.find((a) => a.key === you.variant);
  const running = s?.experiment?.status === 'running';
  if (mine && you.enrolled && running) return seen ? `You got ${mine.name}: Flagsmith counts you in this test.` : `You'll get ${mine.name} when you open the shop, and count in this test.`;
  return `You got ${label(you.release)}${running ? ', outside the test (not counted)' : ''}.`;
}

// ---- a picked test, before it starts: its versions and its Start button (nothing changes in Flagsmith yet) ----------
/**
 * The page while a kind of test is picked but not started: the versions it will compare, step 1 with its Start
 * button, and, when a test is running, a way back to it. `kind`: 1 = A/A, 2 = A/B, 3 = A/B/C…
 */
export function planModel(s, kind) {
  const running = s?.experiment && s.experiment.status !== 'completed' ? s.experiment : null;
  const versions = plannedVersions(s?.releases, kind).map((v) => ({ ...v, badge: 'Preview', state: 'planned' }));
  const n = versions.length;
  const aa = kind === 1;
  const letters = aa ? 'A/A' : versions.map((v) => v.letter).join('/');
  const start = startAction(s, 'Start', kind);
  return {
    plan: true,
    aa,
    letters,
    now: aa
      ? `Preview of an A/A test: both sides get ${versions[0]?.name}. Nothing has changed yet.`
      : `Preview of ${n === 2 ? 'an A/B' : `an ${letters}`} test: ${versions.slice(1).map((v) => v.name).join(' and ')} against ${versions[0]?.name}. Nothing has changed yet.`,
    versions,
    steps: STEPS.map((st, i) => ({ ...st, n: i + 1, status: i === 0 ? 'current' : 'todo', result: '' })),
    action: { ...start, explain: `${start.explain}${running ? ` The running ${kindLabel(kindOf(s) ?? 2)} test #${running.id} stops first.` : ''}` },
    alt: running ? { action: 'cancel-plan', label: `Keep test #${running.id}` } : { action: 'cancel-plan', label: 'Cancel' },
    verdict: null,
    findings: [],
    outcome: null,
    finished: false,
  };
}

// ---- in Flagsmith: the flag, its route for each shopper, the experiment, as Flagsmith holds them now -------------
/**
 * What the "In Flagsmith" tab shows. `you`: the proxy's receipt for this browser ({ variant, release, enrolled }).
 *   route  who gets which version right now: the experiment's split (with your arm marked), everyone else, preview
 */
export function flagsmithModel(s, you) {
  if (!s) return null;
  const e = s.experiment;
  const list = arms(s);
  const r = s.routing;
  // A drained split (Ship or Revert half way, or a finished test) routes nobody: everyone gets the flag's default.
  const running = e && e.status !== 'completed' && r?.experiment && r.experiment.enrolledPct > 0;
  const mine = you && !you.viewing && (you.visited || you.release) ? you : null;
  const route = running
    ? list.map((a) => {
        const pct = r.experiment.arms.find((x) => x.key === a.key)?.pct ?? 0;
        return { key: a.key, letter: a.letter, name: label(a.release), pct, you: Boolean(mine && mine.enrolled && mine.variant === a.key) };
      })
    : [{ key: 'default', letter: list.find((a) => a.release === s.live)?.letter ?? '', name: label(s.live), pct: 100, you: Boolean(mine) }];
  const outside = running && r.experiment.enrolledPct < 100 ? 100 - r.experiment.enrolledPct : 0;
  const goal = s.results?.metrics?.find((m) => m.role === 'goal');
  return {
    flag: s.flag ?? 'the release flag',
    everyone: label(s.live ?? r?.defaultRelease),
    route,
    outside, // % of shoppers outside the experiment (they get the flag's default)
    youOutside: Boolean(mine && running && !mine.enrolled),
    preview: s.preview?.active ? label(s.preview.release) : null,
    variants: [{ key: 'control', value: e?.control ?? s.live }, ...[...(s.variants ?? [])].sort((x, y) => Number(x.key.slice(1)) - Number(y.key.slice(1)))].map((v) => ({ key: v.key, value: v.value ?? v.release })),
    experiment: e
      ? {
          id: e.id,
          kind: isAA(s) ? 'A/A' : list.map((a) => a.letter).join('/'),
          status: e.status,
          hypothesis: e.hypothesis,
          started: e.startedAt,
          metrics: (s.results?.metrics ?? []).map((m) => ({ name: metricName(m.name), event: m.name, role: ROLES[m.role] ?? m.role })),
          counted: goal ? list.reduce((n, a) => n + (goal.arms?.[a.key]?.n ?? 0), 0) : 0,
        }
      : null,
    links: { flag: s.links?.flag ?? null, experiment: s.links?.experiment ?? null, dashboard: s.dashboardUrl ?? null },
  };
}

// ---- your visits: where this browser landed, before a test, during it and after the decision -------------------
/** One line for where this browser lands now, from the proxy's receipt and the page's state; null if it never visited. */
export function visitOf(you, s, pinned = null) {
  if (!you || you.viewing || !(you.visited || you.release) || !you.release) return null;
  if (pinned && pinned === you.release) return { release: you.release, name: label(you.release), where: 'pinned by an identity override (not counted)', key: `${you.release}|pinned` };
  const e = s?.experiment;
  const running = e && e.status === 'running';
  const mine = running ? arms(s).find((a) => a.key === you.variant) : null;
  const where = running && you.enrolled && mine
    ? `in ${isAA(s) ? 'A/A' : arms(s).map((a) => a.letter).join('/')} test #${e.id} as ${mine.letter}`
    : running
      ? `outside test #${e.id}`
      : e && e.status === 'completed'
        ? `after test #${e.id}: everyone's version`
        : "everyone's version";
  return { release: you.release, name: label(you.release), where, key: `${you.release}|${where}` };
}

/** Adds `visit` to `journey` (oldest first) when it differs from the last entry; keeps the latest `max`. */
export function addVisit(journey, visit, at = new Date().toISOString(), max = 4) {
  const list = Array.isArray(journey) ? journey : [];
  if (!visit || list.at(-1)?.key === visit.key) return list;
  return [...list, { ...visit, at }].slice(-max);
}

// ---- blind rounds (server mode's autopilot): the true rates hidden until the decision, then revealed -------------
/**
 * What the page says about a blind round: while it runs, that the truth is hidden; once decided, the truth next to
 * Flagsmith's call (right, wrong, or not sure yet), and the scoreboard over every round. Null when blind rounds are off.
 */
export function blindView(s) {
  const b = s?.blind;
  if (!b?.enabled) return null;
  const sc = b.score ?? { rounds: 0, right: 0, wrong: 0, noCall: 0 };
  const score = sc.rounds ? `Scoreboard: Flagsmith's call was right in ${sc.right} of ${sc.rounds} blind rounds${sc.noCall ? ` (${sc.noCall} where it wasn't sure yet)` : ''}${sc.wrong ? `, wrong in ${sc.wrong}` : ''}.` : 'Scoreboard: no blind round decided yet.';
  if (!b.round || b.round.hidden) return { tone: 'wait', title: 'Blind round', text: 'The true order rates were drawn at random and stay hidden until the decision: the new version may be better, worse or the same. Flagsmith has to find out.', score };
  const r = b.round.round;
  const verdict = r.outcome === 'right' ? 'Flagsmith got it right' : r.outcome === 'wrong' ? 'Flagsmith got it wrong' : "Flagsmith wasn't sure yet (no call)";
  return { tone: r.outcome === 'right' ? 'good' : r.outcome === 'wrong' ? 'bad' : 'wait', title: `Revealed: ${verdict}`, text: `The truth: ${b.round.truth}.`, score };
}

/**
 * The live demo's driver: the autopilot runs tests by itself until a visitor takes over, then waits until they hand
 * it back or stop clicking for a while. Null where there's no autopilot (on your machine).
 */
export function pilotView(s, nowMs = Date.now(), mineUntil = 0) {
  const ap = s?.autopilot;
  if (!ap?.enabled) return null;
  const until = Date.parse(ap.pausedUntil ?? '');
  if (ap.phase === 'paused' && Number.isFinite(until) && until > nowMs) {
    const mins = Math.max(1, Math.ceil((until - nowMs) / 60_000));
    // Someone else took over (this browser hasn't clicked a step lately): say so, and let this visitor take over too.
    if (!(mineUntil > nowMs)) {
      return {
        mode: 'other',
        text: `Someone else is running the steps. The autopilot carries on in up to ${mins} min, or take over and carry their test on.`,
        button: { action: 'take-over', label: 'Take over' },
      };
    }
    const finishing = s?.job?.status === 'running';
    return {
      mode: 'you',
      text: finishing ? 'You took over. The autopilot’s last step is finishing, then the buttons are yours.' : `You’re running the steps. The autopilot waits ${mins} more min, longer with each click.`,
      button: { action: 'hand-back', label: 'Let the autopilot carry on' },
    };
  }
  return {
    mode: 'autopilot',
    text: 'Your turn: run a test yourself, one button at a time. Until someone does, an autopilot keeps one going so there’s always something to watch.',
    button: { action: 'take-over', label: 'Run a test yourself' },
  };
}

/** How long ago, in words: "just now", "4 min ago", "2 h ago". */
export function agoText(iso, nowMs = Date.now()) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return null;
  const min = Math.max(0, Math.round((nowMs - t) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

/** Proof that this is running now, not a recording: Flagsmith's version, when it last computed results, recent rounds. */
export function liveLine(s, nowMs = Date.now()) {
  const parts = [];
  if (s?.flagsmithVersion) parts.push(`Flagsmith ${s.flagsmithVersion}, self-hosted`);
  const ago = agoText(s?.results?.asOf, nowMs);
  if (ago) parts.push(`results computed by Flagsmith ${ago}`);
  const n = s?.blind?.last24h;
  if (typeof n === 'number' && n > 0) parts.push(`${n} blind ${n === 1 ? 'round' : 'rounds'} decided in the last 24 h`);
  return parts.length ? `Live: ${parts.join(' · ')}` : null;
}

/** An also-watched metric that got worse for the winner: said, so the decision is made knowing it (it never blocks). */
function watchedWorse(r, w) {
  const worse = r.metrics.filter((m) => m.role === 'secondary' && (m.byArm?.[w.key]?.verdict ?? m[w.key]?.verdict) === 'losing');
  if (!worse.length) return [];
  const names = worse.map((m) => String(m.name).replace(/_/g, ' '));
  return [`Worth knowing: ${w.name} did worse on ${names.join(' and ')}, which is watched but doesn't decide.`];
}
