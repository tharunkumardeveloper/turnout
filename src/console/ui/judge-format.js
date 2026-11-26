// Pure helpers for judge mode: step copy, which buttons a state allows, and wording for numbers. No DOM, no fetch,
// no statistics: every result number comes from Flagsmith as returned (through /api/judge/state); these functions
// only turn it into words.
import * as F from './format.js';

export const PALETTE = F.PALETTE;
export const VISITOR_CHOICES = [500, 1500, 3000];
export const DEFAULT_VISITORS = 1500;
// Judge mode sends more: with 1,500 visitors the first round lands below Flagsmith's 95% bar about one run in three.
export const JUDGE_VISITORS = 3000;

export const ROUNDS = {
  '01': 'Multivariate flag',
  '02': 'Metrics',
  '03': 'Split traffic',
  '04': 'Ship the winner',
};

/** "Round 03 · Split traffic", or '' for a step that isn't one of the hackathon's rounds. */
export function roundLabel(round) {
  return ROUNDS[round] ? `Round ${round} · ${ROUNDS[round]}` : '';
}

/**
 * What Flagsmith does and what Turnout does at each step. Copy follows the README; keep the two in step.
 * `{live}`, `{v2}`, `{next}` and `{control}` are filled from the state by stepCopy().
 */
const COPY = {
  visitors: {
    flagsmith: 'Buckets each visitor into control or v2 on the release flag and records an exposure for each one.',
    turnout:
      'Gives each simulated visitor a cookie, routes them to the release the flag names, and turns their HTTP into events: a successful POST /checkout becomes order_placed (the goal), POST /cart/add becomes add_to_cart (a funnel step, not a guardrail); every page load sends doc_latency_ms and server_error.',
  },
  score: {
    flagsmith:
      'Computes the Bayesian result for the goal and each guardrail: lift, credible interval and chance to win. It allows one refresh every 5 minutes per experiment.',
    turnout: 'Asks Flagsmith to recompute and shows the numbers as returned. It never computes statistics of its own.',
  },
  decide: {
    flagsmith: 'Serves the decision from the same flag: its environment default becomes the chosen release, and the experiment is completed.',
    turnout:
      'Pauses, snapshots the results, sets the default, drains the split to 0% and completes the experiment, reading each step back. If the winner is losing a guardrail, it says so in red and needs an explicit "ship anyway".',
  },
  verify: {
    flagsmith: 'Serves one release to everyone, from the flag’s environment default.',
    turnout:
      'Sends 50 new simulated visitors through the proxy, counts the release each one got, and checks that no experiment split is left on the flag.',
  },
  swing: {
    flagsmith: 'After a decision the flag is an ordinary flag again: one edit to its default in the flag editor moves everyone.',
    turnout: 'Makes that same edit through Flagsmith’s Admin API. The full console notices that the flag changed after the ship.',
  },
  preview: {
    flagsmith:
      'A segment override (turnout-preview: trait preview = true) serves {next} to browsers that opened the preview link. It ranks above the experiment’s rollout.',
    turnout: 'Sets up the override and a preview link. A preview browser sees {next} and stays out of the experiment’s data.',
  },
  release: {
    flagsmith:
      'The same multivariate flag gets its next experiment: what it serves today becomes control, {next} becomes v2, and the hypothesis goes in Flagsmith’s required field.',
    turnout: 'Adds {next} as the v2 variant’s value and starts the experiment. No app code: the shop never mentions Flagsmith.',
  },
  reset: {
    flagsmith: 'Keeps every experiment on the flag, with its results.',
    turnout: 'Puts the demo back to the start so the next judge can run it again.',
  },
};

export const STEP_IDS = ['visitors', 'score', 'decide', 'verify', 'swing', 'preview', 'release'];

export function stepCopy(id, state) {
  const c = COPY[id];
  if (!c) return { flagsmith: '', turnout: '' };
  const vars = {
    next: state?.next || 'the next release',
    live: state?.live || 'the live release',
    v2: state?.experiment?.v2 || 'v2',
    control: state?.experiment?.control || 'control',
  };
  const fill = (s) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? k);
  return { flagsmith: fill(c.flagsmith), turnout: fill(c.turnout) };
}

/** Ship winner and Revert, as the README's table describes them. */
export const PLAN_STEPS = [
  { title: 'Pause the experiment', why: 'No new exposures while traffic moves' },
  { title: "Save a decision snapshot of Flagsmith's results", why: 'The evidence, kept before anything moves' },
  { title: "Set the flag's environment default to the winner, enabled", why: 'Everyone outside the experiment gets the winner' },
  { title: "Set the rollout to 0%, with the winner's weights", why: "Drains the experiment's cohort onto the default" },
  { title: 'Complete the experiment', why: 'Results are final; the flag is an ordinary flag again' },
];

// ---- numbers -----------------------------------------------------------------------------------------------------

export const formatInt = F.formatInt;
export const formatChance = F.formatChance;
export const formatLift = F.formatLift;

export function parseTime(iso) {
  return F.parseTime(iso);
}

/** 4 s, 1 min 05 s. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0 s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

/** "Flagsmith allows the next refresh in 3:42", or '' once a refresh is allowed. */
export function countdownText(refreshAllowedAt, nowMs = Date.now()) {
  const until = parseTime(refreshAllowedAt);
  if (!Number.isFinite(until) || nowMs >= until) return '';
  const s = Math.ceil((until - nowMs) / 1000);
  return `Flagsmith allows the next refresh in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function refreshAllowed(results, nowMs = Date.now()) {
  return countdownText(results?.refreshAllowedAt, nowMs) === '';
}

/** Requests per second over the window, from arrival times in ms. */
export function perSecond(times, nowMs, windowMs = 5000) {
  if (!Array.isArray(times) || windowMs <= 0) return 0;
  const n = times.filter((t) => t > nowMs - windowMs && t <= nowMs).length;
  return n / (windowMs / 1000);
}

export function formatRate(r) {
  if (!Number.isFinite(r) || r <= 0) return '0 req/s';
  return `${r < 10 ? r.toFixed(1) : Math.round(r)} req/s`;
}

/** A stable colour per release: the order the server lists releases in (shop:1.4 blue, shop:1.5 green, …). */
export function releaseColor(releases, release) {
  const i = Array.isArray(releases) ? releases.indexOf(release) : -1;
  return PALETTE[(i < 0 ? PALETTE.length - 1 : i) % PALETTE.length];
}

// ---- results -----------------------------------------------------------------------------------------------------

const VERDICTS = {
  winning: { word: 'winning', tone: 'good' },
  losing: { word: 'losing', tone: 'bad' },
  inconclusive: { word: 'inconclusive', tone: 'neutral' },
  collecting: { word: 'collecting data', tone: 'neutral' },
  'no-events': { word: 'no events', tone: 'neutral' },
};

export function verdictChip(verdict) {
  return VERDICTS[verdict] ?? { word: String(verdict ?? 'unknown'), tone: 'neutral' };
}

function directionText(direction) {
  if (direction === 'up' || direction === 'down') return F.directionLabel(direction);
  return direction ? String(direction) : '';
}

/** Release label for a variant key, from the experiment. */
export function armRelease(state, key) {
  const e = state?.experiment;
  if (key === 'control') return e?.control ?? null;
  if (key === 'v2') return e?.v2 ?? null;
  return null;
}

/** The results panel, every number as returned by Flagsmith. Null when Flagsmith hasn't computed results. */
export function resultsView(state) {
  const r = state?.results;
  if (!r) return null;
  const metrics = (r.metrics ?? []).map((m) => {
    const keys = Object.keys(m.arms ?? {}).sort((a, b) => (a === 'control' ? -1 : b === 'control' ? 1 : a.localeCompare(b)));
    return {
      name: m.name,
      role: m.role,
      roleLabel: m.role === 'goal' ? 'Goal' : m.role === 'secondary' ? 'Funnel step (not a guardrail)' : 'Guardrail',
      meta: [m.aggregation, directionText(m.direction)].filter(Boolean).join(' · '),
      arms: keys.map((key) => {
        const a = m.arms[key];
        return {
          key,
          release: armRelease(state, key),
          n: formatInt(a?.n),
          value: F.formatMetricValue(a?.mean, m.aggregation, m.name),
          mean: Number.isFinite(a?.mean) ? a.mean : null,
        };
      }),
      v2: m.v2
        ? {
            lift: formatLift(m.v2.lift),
            chance: formatChance(m.v2.chanceToWin),
            chanceRatio: Math.max(0, Math.min(1, Number(m.v2.chanceToWin) || 0)),
            interval: F.formatInterval(m.v2.ciLow, m.v2.ciHigh),
          }
        : null,
      verdict: verdictChip(m.verdict),
    };
  });
  const at = parseTime(r.asOf);
  return {
    asOf: Number.isFinite(at) ? at : null,
    metrics,
    winner: winnerLine(state),
    losing: (r.losingGuardrails ?? []).map((g) => losingText(g)),
  };
}

export function losingText(g) {
  return `${g.metric} is losing: ${formatChance(g.chanceToWin)} chance to win, lift ${formatLift(g.lift)} (as returned)`;
}

/** One sentence on who leads, in Flagsmith's words. */
export function winnerLine(state) {
  const r = state?.results;
  const goal = r?.metrics?.find((m) => m.role === 'goal')?.name ?? 'the goal';
  const w = r?.winner;
  if (!w) return { tone: 'neutral', text: `No leader yet: Flagsmith is collecting data on ${goal}.` };
  const who = `${w.key}${w.release ? ` (${w.release})` : ''}`;
  const chance = formatChance(w.chanceToWin);
  const v = F.verdict(w.chanceToWin);
  if (v.word === 'winning') {
    // Winning the goal while losing a guardrail is not a green result.
    const tone = r.losingGuardrails?.length ? 'neutral' : 'good';
    // A high chance to win with an interval crossing zero is not a win either.
    if (w.key !== 'control' && r.recommendation?.call === 'keep-running') {
      return { tone: 'neutral', text: `${who} leads on ${goal} with ${chance} chance to win, but not a win yet: ${r.recommendation.reason}.` };
    }
    return { tone, text: `${who} is winning on ${goal}: ${chance} chance to win, above Flagsmith's 95% bar.` };
  }
  return { tone: 'neutral', text: `${who} leads on ${goal}, inconclusive: ${chance} chance to win. Flagsmith calls only >95% winning.` };
}

// ---- which buttons a state allows -----------------------------------------------------------------------------------

export function jobRunning(state) {
  return state?.job?.status === 'running';
}

/** The ledger's latest decision, for this experiment when there is one. */
export function latestDecision(state) {
  const ledger = Array.isArray(state?.ledger) ? state.ledger : [];
  const id = state?.experiment?.id;
  const mine = ledger.filter((e) => e.experimentId === id);
  const pool = mine.length ? mine : ledger;
  return [...pool].sort((a, b) => (parseTime(a.at) || 0) - (parseTime(b.at) || 0)).at(-1) ?? null;
}

/**
 * The controls for one step card: buttons (action, label, tone, payload), a note, and what the decide step's
 * "ship anyway" needs ticked. `opts.visitors` is the judge's choice of visitor count.
 */
export function stepControls(state, id, opts = {}) {
  const now = opts.now ?? Date.now();
  const busy = jobRunning(state);
  const out = { buttons: [], note: '', accept: null, countdown: null, links: [] };
  const btn = (action, label, tone = 'primary', payload = {}) => ({ action, label, tone, payload, disabled: busy });
  const e = state?.experiment;
  const control = e?.control ?? 'control';
  const v2 = e?.v2 ?? 'v2';

  switch (id) {
    case 'visitors': {
      const n = VISITOR_CHOICES.includes(opts.visitors) ? opts.visitors : DEFAULT_VISITORS;
      out.buttons.push(btn('visitors', `Send ${formatInt(n)} simulated visitors`, 'primary', { visitors: n }));
      out.note = 'Simulated, labelled visitors. Nothing here is evidence about real users.';
      out.links.push(['See them arrive in Flagsmith', state?.links?.experiment]);
      break;
    }
    case 'score': {
      const b = btn('score', 'Ask Flagsmith for results');
      const wait = countdownText(state?.results?.refreshAllowedAt, now);
      if (wait) {
        // The ticking text is countdownText(out.countdown), updated by the page every second.
        b.disabled = true;
        out.countdown = state.results.refreshAllowedAt;
        out.note = 'Flagsmith allows one refresh every 5 minutes per experiment.';
      } else {
        out.note = 'Flagsmith recomputes in the background; this step waits for the new numbers.';
      }
      out.buttons.push(b);
      out.links.push(["Flagsmith's results page", state?.links?.experiment]);
      break;
    }
    case 'decide': {
      const r = state?.results;
      const losing = r?.losingGuardrails ?? [];
      const w = r?.winner;
      const shipsV2 = w && w.key !== 'control';
      const target = shipsV2 ? `${w.key} → ${w.release ?? v2}` : `v2 → ${v2}`;
      // Turnout's call from Flagsmith's interval and chance to win: an interval crossing zero isn't a win.
      const rec = r?.recommendation;
      const interval = F.recommendationInterval(rec);
      const intervalNote = interval ? ` Credible interval ${interval}.` : '';
      if (losing.length) {
        out.buttons.push(btn('revert', 'Revert (guardrail losing)', 'primary'));
        out.buttons.push(btn('ship', 'Ship anyway…', 'danger', { acceptLosingGuardrails: true }));
        out.accept = {
          label: `I accept that ${losing.map((g) => g.metric).join(' and ')} ${losing.length > 1 ? 'are' : 'is'} losing`,
          confirmLabel: `Ship anyway (${target})`,
        };
        out.note = `Flagsmith shows ${shipsV2 ? w.key : 'v2'} losing a guardrail. Revert keeps everyone on ${control}.`;
      } else if (rec?.call === 'keep-running' && r) {
        const crosses = /crosses zero/.test(rec.reason ?? '');
        out.buttons.push(btn('keep-running', crosses ? 'Keep running (interval crosses zero)' : 'Keep running (not sure yet)', 'primary'));
        out.buttons.push(btn('ship', shipsV2 ? `Ship anyway (${target})` : `Ship v2 anyway (${v2})`, 'secondary'));
        const chance = rec.chanceToWin != null ? `${formatChance(rec.chanceToWin)} chance to win` : 'no chance to win yet';
        out.note = `Flagsmith: ${chance}.${intervalNote} Not a win yet (${rec.reason}). Keep running sends more visitors; nothing changes in Flagsmith.`;
      } else if (shipsV2) {
        const winning = F.verdict(w.chanceToWin).word === 'winning';
        // "Winner" only when Flagsmith calls it one (above its 95% bar).
        out.buttons.push(btn('ship', winning ? `Ship winner (${target})` : `Ship Flagsmith's pick (${target})`, 'primary'));
        out.buttons.push(btn('revert', `Revert to control (${control})`, 'secondary'));
        out.note = winning
          ? `Pre-selected by Flagsmith's results page: ${formatChance(w.chanceToWin)} chance to win.${intervalNote}`
          : `Flagsmith's pick, but inconclusive (${formatChance(w.chanceToWin)}, below 95%).${intervalNote} Shipping now is your call.`;
      } else {
        out.buttons.push(btn('revert', `Revert to control (${control})`, 'primary'));
        out.buttons.push(btn('ship', `Ship v2 anyway (${v2})`, 'secondary'));
        out.note = r ? `Flagsmith doesn't show v2 ahead. Reverting keeps everyone on ${control}.` : 'Ask Flagsmith for results first.';
      }
      out.links.push(["Flagsmith's results page", state?.links?.experiment]);
      break;
    }
    case 'verify':
      out.buttons.push(btn('verify', 'Check 50 new visitors'));
      out.links.push(['The flag in Flagsmith', state?.links?.flag]);
      break;
    case 'swing': {
      const last = latestDecision(state);
      if (!last || last.decision !== 'shipped') {
        out.note = 'Only after a ship: the swing moves everyone between the shipped release and the one it replaced.';
        break;
      }
      const back = !state?.live || state.live === last.release;
      out.buttons.push(
        back
          ? btn('swing-back', 'Swing everyone back (one flag edit)', 'secondary')
          : btn('swing-forward', 'Swing forward again', 'secondary'),
      );
      out.note = back
        ? `Sets the flag's default back to ${last.replaced ?? 'the previous release'}: the same edit as changing the default in Flagsmith's flag editor. Try it there yourself.`
        : `Everyone is on ${state.live}. Swing forward puts the default back on ${last.release}.`;
      out.links.push(['Edit the flag in Flagsmith', state?.links?.flag]);
      break;
    }
    case 'preview': {
      const next = state?.next ?? 'the next release';
      // A preview left from an earlier cycle serves an older release: previewing the next one is still to do.
      if (!state?.preview?.active || state.preview.release !== state?.next) out.buttons.push(btn('preview', `Preview ${next} for your team`));
      out.links.push(['The preview segment on the flag', state?.links?.flag]);
      break;
    }
    case 'release':
      out.buttons.push(btn('release', `Start the next experiment: ${state?.next ?? 'next release'}`));
      out.links.push(['The flag in Flagsmith', state?.links?.flag]);
      break;
    case 'reset':
      out.buttons.push(btn('reset', 'Start over', 'secondary'));
      break;
    default:
      break;
  }
  if (busy && out.buttons.length) out.note = 'Wait for the running step to finish.';
  out.links = out.links.filter(([, href]) => typeof href === 'string' && href);
  return out;
}

/** Whether a step card shows its controls: the current step, or the optional swing once a ship happened. */
export function showsControls(state, step) {
  if (!step) return false;
  if (step.id === state?.current) return true;
  if (step.status === 'optional' && step.id === 'swing') return latestDecision(state)?.decision === 'shipped';
  return false;
}

// ---- evidence after a step is done -------------------------------------------------------------------------------

// identities: what Flagsmith's results counted, for when the console restarted and forgot what it sent.
export function totalsText(totals, identities) {
  if (!totals) return '';
  const parts = [
    totals.visitorsSent > 0 || !identities
      ? `${formatInt(totals.visitorsSent)} simulated visitors sent`
      : `Flagsmith counted ${formatInt(identities)} visitors in this experiment`,
  ];
  if (Number.isFinite(totals.eventsAccepted)) {
    parts.push(`Flagsmith's event counter: ${formatInt(totals.eventsAccepted)} accepted · ${formatInt(totals.eventsRejected ?? 0)} rejected (as returned)`);
  }
  return parts.join('. ');
}

export function decisionText(entry) {
  if (!entry) return '';
  if (entry.decision === 'kept-running') return `Kept running${entry.reason ? `: ${entry.reason}` : ''}. Nothing changed in Flagsmith.`;
  if (entry.decision === 'reverted') {
    return `Reverted: everyone on ${entry.release ?? 'control'}${entry.by === 'guard' ? ` (automatically, by the guard: ${entry.guardReason ?? 'a guardrail was losing'})` : ''}`;
  }
  return `Shipped ${entry.variant}${entry.release ? ` → ${entry.release}` : ''}${entry.replaced ? ` (replaced ${entry.replaced})` : ''}`;
}

/** Evidence lines for a finished step. `extra.verify` is the last verify job's result, kept by the page. */
export function stepEvidence(state, id, extra = {}) {
  const lines = [];
  switch (id) {
    case 'visitors':
      if (state?.totals) {
        const goal = state.results?.metrics?.[0];
        const identities = goal ? Object.values(goal.arms ?? {}).reduce((sum, a) => sum + (a?.n ?? 0), 0) : 0;
        lines.push(totalsText(state.totals, identities));
      }
      break;
    case 'score': {
      const v = resultsView(state);
      if (v) lines.push(v.winner.text);
      break;
    }
    case 'decide': {
      const d = latestDecision(state);
      if (d) {
        lines.push(decisionText(d));
        for (const g of d.losingGuardrailsAccepted ?? []) lines.push(`Accepted a losing guardrail: ${losingText(g)}`);
      }
      break;
    }
    case 'verify': {
      const s = verifySummary(extra.verify);
      if (s) lines.push(s.text);
      if (s?.check) lines.push(s.check);
      break;
    }
    case 'swing':
      if (state?.live) lines.push(`Everyone is on ${state.live} now.`);
      break;
    case 'preview':
      if (state?.preview?.active) lines.push(`Preview on: browsers that open the link see ${state.preview.release ?? state.next}.`);
      break;
    case 'release':
      if (state?.experiment) lines.push(`Running: ${state.experiment.name}`);
      break;
    default:
      break;
  }
  return lines.filter(Boolean);
}

function checkText(check) {
  if (check == null) return '';
  if (typeof check === 'string') return check;
  if (Array.isArray(check)) {
    if (!check.length) return 'check: clean, no experiment split left on the flag';
    if (check.every((x) => typeof x === 'string')) return check.join(' ');
    return `check found ${check.length} experiment split${check.length > 1 ? 's' : ''} still on the flag`;
  }
  if (typeof check === 'object') {
    if (typeof check.text === 'string') return check.text;
    if (typeof check.message === 'string') return check.message;
    if (Array.isArray(check.findings)) return checkText(check.findings);
    if (Array.isArray(check.lines)) return checkText(check.lines);
    const ok = check.clean ?? check.ok;
    if (typeof ok === 'boolean') return ok ? 'check: clean, no experiment split left on the flag' : 'check found an experiment split still on the flag';
  }
  return '';
}

/** A verify job's result → bars per release, a sentence, and the check line. Null without counts. */
export function verifySummary(result) {
  const by = result?.byRelease;
  if (!by || typeof by !== 'object') return null;
  const rows = Object.entries(by)
    .map(([release, v]) => ({ release, count: typeof v === 'number' ? v : Number(v?.visitors ?? 0) }))
    .filter((r) => Number.isFinite(r.count));
  const total = rows.reduce((s, r) => s + r.count, 0);
  if (!total) return null;
  rows.sort((a, b) => b.count - a.count);
  const bars = rows.map((r) => ({ ...r, pct: (r.count / total) * 100 }));
  const text =
    bars.length === 1
      ? `${formatInt(bars[0].count)} of ${formatInt(total)} new visitors got ${bars[0].release}.`
      : bars.map((b) => `${b.release}: ${formatInt(b.count)}`).join(' · ') + ` (of ${formatInt(total)} new visitors)`;
  // The console's verify job reports `leftovers`: experiment splits check found (0 = clean, null = check skipped).
  let check = checkText(result.check ?? result.findings);
  if (!check && 'leftovers' in result) {
    const n = result.leftovers;
    check = n === 0 ? 'check: clean, no experiment split left on the flag'
      : Number.isFinite(n) ? `check found ${n} experiment split${n > 1 ? 's' : ''} still on the flag`
      : 'check skipped: the console has no server key';
  }
  return { bars, total, text, check };
}

// ---- jobs --------------------------------------------------------------------------------------------------------

const ACTION_TEXT = {
  visitors: 'Sending simulated visitors',
  score: 'Asking Flagsmith for results',
  ship: 'Shipping the winner',
  revert: 'Reverting to control',
  'keep-running': 'Keeping the experiment running',
  verify: 'Checking 50 new visitors',
  'swing-back': 'Swinging everyone back',
  'swing-forward': 'Swinging forward again',
  preview: 'Turning on the preview',
  release: 'Starting the next experiment',
  reset: 'Starting the next round',
};

export const JOB_STEP = {
  visitors: 'visitors',
  score: 'score',
  ship: 'decide',
  revert: 'decide',
  'keep-running': 'decide',
  verify: 'verify',
  'swing-back': 'swing',
  'swing-forward': 'swing',
  preview: 'preview',
  release: 'release',
  reset: 'reset',
};

export function actionText(action) {
  return ACTION_TEXT[action] ?? String(action ?? '');
}

/** The job panel: title, elapsed time, outcome and the log, from GET /api/judge/job. */
export function jobView(job, nowMs = Date.now(), fallbackGuardrails = []) {
  if (!job) return null;
  const start = parseTime(job.startedAt);
  const end = job.status === 'running' ? nowMs : parseTime(job.finishedAt);
  const elapsed = Number.isFinite(start) && Number.isFinite(end) ? formatDuration(end - start) : '';
  const fromResult = Array.isArray(job.result?.guardrails) ? job.result.guardrails : null;
  const guardrailFailure = job.status === 'failed' && (fromResult?.length || /guardrail/i.test(job.error ?? ''));
  const guardrails = guardrailFailure ? (fromResult?.length ? fromResult : fallbackGuardrails).map(losingText) : [];
  let outcome = '';
  if (job.status === 'done') outcome = `Done in ${elapsed}.`;
  else if (job.status === 'failed') outcome = `Stopped: ${job.error || 'the step failed'}`;
  return {
    id: job.id,
    action: job.action,
    step: JOB_STEP[job.action] ?? null,
    running: job.status === 'running',
    status: job.status,
    tone: job.status === 'done' ? 'good' : job.status === 'failed' ? 'bad' : 'neutral',
    title: actionText(job.action),
    elapsed,
    outcome,
    guardrails,
    log: (job.log ?? []).map((l) => ({ at: parseTime(l.at), text: l.text })),
    // The server ticks these off; an older server without them gets the stage names, unticked.
    stages: Array.isArray(job.stages) ? job.stages : (STAGES[job.action] ?? []).map((title) => ({ title, status: job.status === 'done' ? 'done' : 'todo' })),
    progress: job.progress && Number.isFinite(job.progress.total) ? job.progress : null,
    changes: job.changes?.before ? job.changes : null,
  };
}

// ---- progress and the finale ---------------------------------------------------------------------------------

/** "Step 3 of 7", counting optional steps only once they are reachable. */
export function progressText(state) {
  const steps = state?.steps ?? [];
  if (state?.current === 'reset') return 'All steps done';
  const i = steps.findIndex((s) => s.id === state?.current);
  if (i < 0) return '';
  return `Step ${i + 1} of ${steps.length}`;
}

export function stepStatusText(status, isCurrent) {
  if (isCurrent) return 'you are here';
  return { done: 'done', todo: 'to do', optional: 'optional', current: 'you are here' }[status] ?? String(status ?? '');
}

/** The ledger, newest first, in words. */
export function ledgerView(ledger) {
  return (Array.isArray(ledger) ? ledger : [])
    .map((e) => ({
      at: parseTime(e.at),
      experiment: e.experiment,
      decision: e.decision,
      tone: e.decision === 'shipped' ? 'good' : 'neutral',
      text: decisionText(e),
      results: Array.isArray(e.results) ? e.results : [],
      accepted: (e.losingGuardrailsAccepted ?? []).map(losingText),
    }))
    .sort((a, b) => (b.at || 0) - (a.at || 0));
}

/** The HTTP answer from POST /api/judge/run, in words. */
export function runErrorText(status, body) {
  if (status === 403) return "This page's session expired — reload";
  const msg = typeof body?.error === 'string' && body.error ? body.error : '';
  if (status === 409) return msg || 'Not allowed right now: another step is running or the experiment changed. The page has been refreshed.';
  if (status === 400) return msg || 'The console refused the request.';
  return msg || `The console answered HTTP ${status}.`;
}

// ---- the guide: what to click, what happens, where to look ---------------------------------------------------------

/** The stages each job goes through, as the server's JOB_STAGES lists them (test/judge-ui.test.ts keeps them equal). */
export const STAGES = {
  visitors: ['Wait for the proxy to enrol visitors', 'Send the visitors through Turnout', 'Hand their events to Flagsmith'],
  score: ['Wait for the events to reach Flagsmith', 'Ask Flagsmith to compute the results', 'Read the new results'],
  ship: ['Pause the experiment', "Save a snapshot of Flagsmith's results", "Set the flag's default to the winner", 'Drain the rollout to 0%', 'Complete the experiment', 'Write the release ledger'],
  revert: ['Pause the experiment', "Save a snapshot of Flagsmith's results", "Set the flag's default to control", 'Drain the rollout to 0%', 'Complete the experiment', 'Write the release ledger'],
  'keep-running': ["Read Flagsmith's credible interval", 'Write the release ledger (nothing changes in Flagsmith)'],
  verify: ['Send 50 brand-new visitors', 'Count the release each one got', 'Check no experiment split is left'],
  'swing-back': ["Edit the flag's default in Flagsmith", 'Wait for Turnout to follow the flag'],
  'swing-forward': ["Edit the flag's default in Flagsmith", 'Wait for Turnout to follow the flag'],
  preview: ['Point v2 at the next release', 'Give it to the preview segment only', 'Make the preview link'],
  release: ['Point v2 at the next release', 'Start the experiment in Flagsmith'],
  reset: ['Revert the running experiment', "Set the flag's default back to the first release", 'Start a fresh experiment'],
};

/**
 * One card of the guide per step, in plain words: what you do, where to look while it runs, and what it proves.
 * `where` names the place in Flagsmith's own dashboard that shows the same thing.
 */
const GUIDE = {
  visitors: {
    you: 'Send 3,000 simulated shoppers to the shop.',
    watch: 'The track diagram above: every dot is one page or order. Dots inside the experiment split between {control} and {v2}; Flagsmith decides which, not Turnout.',
    proves: "Flagsmith splits real HTTP traffic between two releases, and the shop's code never mentions Flagsmith.",
    where: 'Flagsmith → Experiments → this experiment: its visitor count rises',
  },
  score: {
    you: 'Ask Flagsmith which release did better.',
    watch: "The results panel that appears in this step: one row per metric, with Flagsmith's chance-to-win bar. The two marks on each bar are Flagsmith's 5% and 95% thresholds.",
    proves: "The verdict is Flagsmith's own Bayesian analysis, shown exactly as returned. Turnout computes no statistics.",
    where: 'Flagsmith → Experiments → this experiment → Results: the same numbers',
  },
  decide: {
    you: "Make the call Flagsmith's numbers point to. The highlighted button is the one they recommend.",
    watch: 'The checklist ticks off each change to the flag. When it finishes, the before → after card shows exactly what changed in Flagsmith.',
    proves: 'A release decision is a flag change, made in an order that reaches every visitor, with the evidence saved first.',
    where: 'Flagsmith → Features → the release flag: its default value and variations',
  },
  verify: {
    you: 'Send 50 brand-new visitors and count which release each one got.',
    watch: 'The bars: all 50 should land on one release, and the check should find no experiment split left on the flag.',
    proves: 'The decision really reached everyone, not just people who arrived after it.',
    where: 'Flagsmith → Features → the release flag: one value, no experiment override',
  },
  swing: {
    you: 'Optional: move everyone back to the old release, then forward again.',
    watch: 'The track diagram: the “everyone else” track switches release within a few seconds.',
    proves: 'After a decision the flag is an ordinary flag: one edit in Flagsmith moves all traffic, with no deploy.',
    where: 'Flagsmith → Features → the release flag: try changing its default yourself',
  },
  preview: {
    you: 'Let your team see {next} before anyone else.',
    watch: 'A “your team” track appears in the diagram. Then open the preview link to see {next} in this browser.',
    proves: "Flagsmith's segment override serves your team first and keeps them out of the experiment's data.",
    where: 'Flagsmith → Segments → turnout-preview, and its override on the flag',
  },
  release: {
    you: 'Start the next experiment: {next} against what everyone has now.',
    watch: 'The experiment track comes back in the diagram, now splitting {live} and {next}.',
    proves: 'Releasing is a new experiment on the same flag. No app code changes.',
    where: 'Flagsmith → Experiments: a new running experiment on the same flag',
  },
};

export function stepGuide(id, state) {
  const g = GUIDE[id];
  if (!g) return null;
  const vars = {
    next: state?.next || 'the next release',
    live: state?.live || 'the live release',
    v2: state?.experiment?.v2 || 'v2',
    control: state?.experiment?.control || 'control',
  };
  const fill = (s) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? k);
  return { you: fill(g.you), watch: fill(g.watch), proves: fill(g.proves), where: fill(g.where) };
}

/** The data-key of the button the guide points at: the first enabled primary one, else the first enabled one. */
export function coachButton(controls) {
  const usable = (controls?.buttons ?? []).filter((b) => !b.disabled);
  const b = usable.find((x) => x.tone === 'primary') ?? usable[0];
  return b ? `btn-${b.action}${controls.accept && b.payload?.acceptLosingGuardrails ? '-anyway' : ''}` : null;
}

/**
 * The sentence in the sticky guide bar: what to do now. `kind` drives its style: 'click' (a button waits for you),
 * 'working' (a job runs), 'wait' (nothing to click yet), 'done' (the loop is complete).
 */
export function coachLine(state, controls, nowMs = Date.now()) {
  if (!state) return { kind: 'wait', text: 'Loading the demo…' };
  const job = state.job;
  if (job?.status === 'running') {
    const stages = job.stages ?? [];
    const i = stages.findIndex((s) => s.status === 'running');
    const where = i >= 0 ? ` · ${i + 1} of ${stages.length}: ${stages[i].title}` : '';
    return { kind: 'working', text: `Working: ${actionText(job.action)}${where}. Nothing to click; watch the diagram.` };
  }
  if (state.current === 'reset') return { kind: 'done', text: 'That is the whole loop. Click “Start over” to run it again for the next judge.', label: 'Start over' };
  const step = state.steps?.find((s) => s.id === state.current);
  const progress = progressText(state);
  const wait = countdownText(state.results?.refreshAllowedAt, nowMs);
  const buttons = (controls?.buttons ?? []).filter((b) => !b.disabled);
  const usable = buttons.find((b) => b.tone === 'primary') ?? buttons[0];
  if (!usable && wait) return { kind: 'wait', text: `${progress} · ${wait}. The button unlocks on its own.` };
  if (!usable) return { kind: 'wait', text: `${progress} · ${step?.title ?? ''}` };
  return { kind: 'click', text: `${progress} · Click “${usable.label}”`, label: usable.label };
}

// ---- routing: who gets which release, drawn as tracks -------------------------------------------------------------

function formatPct(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return '?';
  return `${Math.round(n * 10) / 10}%`;
}

/**
 * The flag's routing as tracks, top to bottom: the preview segment (when on), the experiment's rollout (while it
 * runs) and the environment default for everyone else. Each track names its releases and their shares.
 */
export function trackRules(routing) {
  if (!routing) return [];
  const rules = [];
  if (routing.preview?.active && routing.preview.release) {
    rules.push({ id: 'preview', title: 'Your team', note: 'preview segment', targets: [{ release: routing.preview.release, pct: 100, key: 'preview' }] });
  }
  const e = routing.experiment;
  if (e) {
    rules.push({
      id: 'experiment',
      title: `Experiment ${e.id}`,
      note: `${formatPct(e.enrolledPct)} of visitors · ${e.status}`,
      targets: e.arms.map((a) => ({ release: a.release ?? a.key, pct: a.pct, key: a.key })),
    });
  }
  if (routing.defaultRelease) {
    rules.push({
      id: 'default',
      title: 'Everyone else',
      note: e && e.enrolledPct >= 100 ? 'bots, and anyone outside the rollout' : "the flag's default",
      targets: [{ release: routing.defaultRelease, pct: 100, key: 'default' }],
    });
  }
  return rules;
}

/** Which track a proxied request travelled: the experiment if it was enrolled, the preview if it got that release. */
export function routeOf(ev, rules) {
  if (ev?.enrolled && rules.some((r) => r.id === 'experiment')) return 'experiment';
  const preview = rules.find((r) => r.id === 'preview');
  const fallback = rules.find((r) => r.id === 'default');
  if (preview && ev?.release === preview.targets[0].release && ev?.release !== fallback?.targets[0].release) return 'preview';
  return fallback ? 'default' : (rules[0]?.id ?? null);
}

/** The tracks in one sentence, for screen readers. */
export function routingSummary(rules) {
  if (!rules.length) return 'No routing yet: run init.';
  return rules
    .map((r) => `${r.title}: ${r.targets.map((t) => (r.targets.length > 1 ? `${formatPct(t.pct)} ${t.release}` : t.release)).join(', ')}`)
    .join('. ');
}

function describeExperiment(e) {
  if (!e) return 'none running';
  return `#${e.id} ${e.status}: ${e.arms.map((a) => `${formatPct(a.pct)} ${a.release ?? a.key}`).join(' / ')}`;
}

/** Before → after, row by row, for the card a finished job shows. `changed` marks the rows that moved. */
export function routingDiff(before, after) {
  if (!before) return [];
  const preview = (r) => (r.preview?.active ? `serves ${r.preview.release}` : 'off');
  const rows = [
    ['Everyone else gets', before.defaultRelease ?? '—', after ? (after.defaultRelease ?? '—') : null],
    ['Experiment split', describeExperiment(before.experiment), after ? describeExperiment(after.experiment) : null],
    ['Preview for your team', preview(before), after ? preview(after) : null],
  ];
  return rows.map(([label, b, a]) => ({ label, before: b, after: a, changed: a !== null && a !== b }));
}

/**
 * Server mode's public view: what the autopilot is doing, for the stage (where the buttons would be) and the watch
 * tour. state.autopilot comes from the console (autopilot.ts); null or missing: the autopilot is off.
 */
export function autopilotLine(state, nowMs = Date.now()) {
  const job = state?.job;
  if (job?.status === 'running') return { kind: 'running', text: `Running automatically — now: ${actionText(job.action)}` };
  const ap = state?.autopilot;
  if (!ap) return { kind: 'off', text: 'Read-only: steps run from the console on the server.' };
  if (ap.phase === 'paused') return { kind: 'paused', text: 'Paused while someone uses the console on the server; it carries on by itself.' };
  const next = ap.next;
  if (!next) return { kind: 'starting', text: 'Running automatically — starting…' };
  const at = parseTime(next.at);
  const s = Number.isFinite(at) ? Math.ceil((at - nowMs) / 1000) : 0;
  const when = s > 90 ? `in ~${Math.round(s / 60)} min` : s > 0 ? `in ~${s} s` : 'any moment now';
  return { kind: 'waiting', text: `Running automatically — next: ${next.title} ${when}`, retrying: Boolean(ap.lastError) };
}

// ---- this round: Flagsmith's chance to win over time, the blind reveal, the scoreboard -------------------------
/**
 * SVG geometry for the chance-to-win line: one point per Flagsmith results refresh, x by order, y = chance to win
 * (0 at the bottom, 1 at the top). Also the 95% line and the credible-interval bars (lift, as whiskers around 0).
 * @param {{ asOf: string, chanceToWin: number|null, low: number|null, high: number|null, identities: number }[]} points
 */
export function chanceChart(points, width = 320, height = 120, pad = 14) {
  const usable = (points ?? []).filter((p) => typeof p.chanceToWin === 'number');
  const x = (i, n) => (n <= 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (n - 1));
  const y = (c) => pad + (1 - c) * (height - 2 * pad);
  const dots = usable.map((p, i) => ({ x: +x(i, usable.length).toFixed(1), y: +y(p.chanceToWin).toFixed(1), chance: p.chanceToWin, identities: p.identities, asOf: p.asOf }));
  return {
    width,
    height,
    dots,
    line: dots.map((d) => `${d.x},${d.y}`).join(' '),
    ship: +y(0.95).toFixed(1), // Turnout ships at 95% with an interval clear of zero
    half: +y(0.5).toFixed(1),
    empty: dots.length === 0,
  };
}

/** "Flagsmith picked the right release in 24 of 28 rounds" and the details line. */
export function scoreText(score) {
  if (!score || !score.rounds) return { head: 'No rounds decided yet', sub: 'Each round, the true rates are drawn at random and hidden. Flagsmith has to find the winner, or say there is none.' };
  return {
    head: `Flagsmith's call was right in ${score.right} of ${score.rounds} round${score.rounds === 1 ? '' : 's'}`,
    sub: `${score.noCall} no clear call yet (too little data, not a mistake) · ${score.wrong} wrong`,
  };
}

const CALL_TEXT = { ship: 'ship the new release', revert: 'keep the old release (revert)', 'keep-running': 'no clear winner yet (keep running)' };
/** The reveal for this round, or why it's still hidden. */
export function revealText(blind) {
  if (!blind?.enabled && !blind?.round) return null;
  const r = blind?.round;
  if (!r) return { kind: 'waiting', head: 'Blind round', text: 'The true rates are drawn when the first visitors arrive, and stay hidden.' };
  if (r.hidden) return { kind: 'hidden', head: 'Blind round: the truth is hidden', text: 'The true order rates were drawn at random. Only the traffic reaches Flagsmith; the answer is revealed when the round is decided.' };
  const verdict = r.round.outcome === 'right' ? '✓ right' : r.round.outcome === 'no-call' ? '… no clear call' : '✗ wrong';
  return {
    kind: r.round.outcome,
    head: `Revealed: ${verdict}`,
    text: `Truth: ${r.truth}. Flagsmith's numbers said: ${CALL_TEXT[r.round.call] ?? r.round.call}${typeof r.round.chanceToWin === 'number' ? ` (${(r.round.chanceToWin * 100).toFixed(1)}% chance to win)` : ''}. The right call was: ${CALL_TEXT[r.round.expected] ?? r.round.expected}.`,
  };
}

/** The headline over the chance chart: the latest chance, in words. */
export function chanceHeadline(points) {
  const last = [...(points ?? [])].reverse().find((p) => typeof p.chanceToWin === 'number');
  if (!last) return { pct: null, verdict: "Waiting for Flagsmith's first results", tone: 'wait', visitors: 0 };
  const c = last.chanceToWin;
  const verdict = c >= 0.95 ? 'clearly better: ship' : c <= 0.05 ? 'clearly worse: revert' : 'not sure yet: keep running';
  return { pct: Math.round(c * 100), verdict, tone: c >= 0.95 ? 'good' : c <= 0.05 ? 'bad' : 'wait', visitors: last.identities };
}

// ---- the showdown: the two versions under test, side by side, and which one won -----------------------------------
const NAMES = { 'shop:1.4': 'Classic', 'shop:1.5': 'Express', 'shop:1.6': 'Bold' };
/**
 * The two versions in the experiment and where the contest stands.
 * phase: 'testing' (Flagsmith splits visitors), 'shipped' (the new version won and everyone gets it),
 * 'kept' (the current version stays: reverted), or null with nothing to show.
 */
export function showdown(s) {
  const e = s?.experiment;
  if (!e?.control || !e?.v2) return null;
  const goal = (s.results?.metrics ?? []).find((m) => m.role === 'goal');
  const arm = (key) => (goal?.arms?.[key] ? { rate: goal.arms[key].mean, n: goal.arms[key].n } : null);
  const done = e.status === 'completed';
  const phase = !done ? 'testing' : s.live === e.v2 ? 'shipped' : 'kept';
  const side = (key, release) => ({
    key,
    release,
    name: NAMES[release] ?? '',
    flagsmith: arm(key),
    state: phase === 'testing' ? 'testing' : (phase === 'shipped') === (key === 'v2') ? 'winner' : 'retired',
  });
  // The round before this one, from the release history: shown under the headline once the next round has started.
  const prev = (s.ledger ?? []).filter((x) => x.experimentId !== e.id && (x.decision === 'shipped' || x.decision === 'reverted')).at(-1);
  const last = prev
    ? prev.decision === 'shipped'
      ? `Last round: ${prev.release} won and was shipped to everyone (replacing ${prev.replaced}).`
      : `Last round: ${prev.release} was kept; the new version was rolled back.`
    : null;
  return {
    phase,
    last,
    chance: goal?.v2?.chanceToWin ?? null,
    sides: [side('control', e.control), side('v2', e.v2)],
    headline:
      phase === 'testing'
        ? `Testing ${e.v2} against ${e.control}: Flagsmith gives each visitor one of them`
        : phase === 'shipped'
          ? `${e.v2} won: shipped to everyone`
          : `${e.control} stays: ${e.v2} was rolled back`,
  };
}

// ---- the round's confidence meter: one bar from 0 to 100% with Flagsmith's chance on it -----------------------------
/**
 * Where Flagsmith's chance sits on the meter: the zone (revert under 5%, keep running, ship from 95%), the marker's
 * position, earlier readings as faint ticks, and the reading in words. `points` is the round's history.
 */
export function meterModel(points) {
  const readings = (points ?? []).filter((p) => typeof p.chanceToWin === 'number');
  const last = readings.at(-1);
  if (!last) return { pct: null, zone: 'wait', ticks: [], label: "Waiting for Flagsmith's first results", sub: 'Flagsmith computes them after the first visitors (at most every 5 minutes).' };
  const pct = Math.round(last.chanceToWin * 1000) / 10;
  const zone = last.chanceToWin >= 0.95 ? 'ship' : last.chanceToWin <= 0.05 ? 'revert' : 'keep';
  const label = zone === 'ship' ? 'Clearly better: ship it' : zone === 'revert' ? 'Clearly worse: keep the current one' : 'Not sure yet: keep running';
  return {
    pct,
    zone,
    ticks: readings.slice(0, -1).map((p) => Math.round(p.chanceToWin * 1000) / 10),
    label,
    sub: `${pct}% chance the new version is better · Flagsmith, after ${Number(last.identities ?? 0).toLocaleString('en-GB')} visitors`,
  };
}

/** The round number while it runs (rounds decided so far + 1), or the decided round's number. */
export function roundNumber(blind) {
  const n = blind?.score?.rounds ?? 0;
  return blind?.round && !blind.round.hidden ? n : n + 1;
}
