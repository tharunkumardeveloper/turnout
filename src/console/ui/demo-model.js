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
  order_placed: { name: 'Orders', hint: 'shoppers who placed an order' },
  add_to_cart: { name: 'Added to cart', hint: 'shoppers who added something' },
  doc_latency_ms: { name: 'Page load time', hint: 'average time to serve a page' },
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
export function findings(s) {
  const list = arms(s);
  return (s?.results?.metrics ?? []).map((m) => ({
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
  const orders = (key) => (goal?.arms?.[key] && goal?.arms?.control ? ` (${pct(goal.arms[key].mean)} vs ${pct(goal.arms.control.mean)})` : '');
  const others = (except) =>
    list.slice(1).filter((x) => x.key !== except).map((x) => {
      const failed = failedChecks(s, x.key);
      const g = goal && inferenceOf(goal, x.key);
      if (failed.length) return `${x.name}${g?.verdict === 'winning' ? ' sold more too, but' : ':'} ${failed.join(' and ')}, so it's out.`;
      if (g?.verdict === 'losing') return `${x.name} got fewer orders.`;
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
      ? 'Flagsmith has no result on orders yet.'
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
      text: [`${w.name} gets more orders than A${orders(w.key)}, Flagsmith is ${pct(rec.chanceToWin, 0)} sure, and every safety check is fine.`, ...others(w.key)].join(' '),
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
  const shippedArm = done && !isAA(s) ? list.slice(1).find((x) => x.release === s.live) ?? null : null;
  const armPct = (key) => s.routing?.experiment?.arms?.find((x) => x.key === key)?.pct;

  out.now = done
    ? `Everyone gets ${list.find((x) => x.release === s.live)?.name ?? label(s.live)}. No test is running.`
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
    detail: job.status === 'failed' ? (job.error ?? 'It failed.') : p && p.total ? `${int(p.done)} of ${int(p.total)} shoppers` : (stage?.title ?? ''),
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
