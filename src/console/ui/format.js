// Pure helpers for the console: wording and number formatting only. No DOM, no fetch, no statistics:
// every number shown comes from Flagsmith as returned; these functions only turn it into words.

export const CONTROL = 'control';

// Track colours: control is shop:1.4's blue, the first treatment shop:1.5's green (the demo shop's themes).
export const PALETTE = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#db2777', '#0891b2'];

// Flagsmith's results page calls >95% chance to win "winning" and <5% "losing"; everything between is inconclusive.
export const WINNING = 0.95;
export const LOSING = 0.05;

const num = (digits) => new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const MINUS = '−';

/** Every variant of the experiment's flag: control first, then the multivariate options. */
export function variantList(experiment) {
  const feature = experiment?.feature;
  if (!feature) return [];
  // Control serves what the rollout says, not the flag's first value: each release moves control on. A later
  // preview re-points the v2 option at the next release, so the experiment's own name ("flag: v2 vs control") wins.
  const named = String(experiment.name ?? '').match(/: (.+) vs (.+)$/);
  const options = (feature.multivariate_options ?? []).filter((o) => o?.key);
  const controlLabel = experiment.experiment_rollout?.feature_state_value?.value || named?.[2] || feature.initial_value || CONTROL;
  const list = [{ key: CONTROL, label: controlLabel, id: null, isControl: true }];
  for (const o of options) {
    const label = options.length === 1 && named ? named[1] : o.string_value || o.key;
    list.push({ key: o.key, label, id: o.id, isControl: false });
  }
  return list.map((v, i) => ({ ...v, color: PALETTE[i % PALETTE.length] }));
}

export function releaseLabel(experiment, key) {
  return variantList(experiment).find((v) => v.key === key)?.label ?? key;
}

const clampPct = (p) => Math.min(100, Math.max(0, Number(p) || 0));

// Option weights → { key: percent }, control taking whatever is left.
function distribution(variants, weightOf) {
  const out = {};
  let rest = 100;
  for (const v of variants) {
    if (v.isControl) continue;
    out[v.key] = clampPct(weightOf(v.id));
    rest -= out[v.key];
  }
  out[CONTROL] = Math.max(0, rest);
  return out;
}

/**
 * How the flag routes visitors right now, from Flagsmith's own state: the experiment rollout (a segment override
 * covering rollout_percentage of identities) on top of the flag's environment default. Flag off → control,
 * as the proxy does.
 */
export function routing(experiment, flag) {
  const variants = variantList(experiment);
  const def = flag?.environment_default;
  const defaultDist =
    def && def.enabled === false
      ? distribution(variants, () => 0)
      : distribution(variants, (id) => def?.variants?.find((w) => w.id === id)?.weight ?? 0);
  const ro = experiment?.experiment_rollout;
  const rolloutPct = ro && ro.enabled ? clampPct(ro.rollout_percentage) : 0;
  const rolloutDist = distribution(
    variants,
    (id) => ro?.multivariate_feature_state_values?.find((m) => m.multivariate_feature_option === id)?.percentage_allocation ?? 0,
  );

  const shares = {};
  for (const v of variants) {
    const share = (rolloutPct / 100) * (rolloutDist[v.key] ?? 0) + (1 - rolloutPct / 100) * (defaultDist[v.key] ?? 0);
    shares[v.key] = Math.round(share * 100) / 100;
  }
  const only = variants.find((v) => shares[v.key] >= 100);
  const label = (key) => variants.find((v) => v.key === key)?.label ?? key;
  const defaultOnly = variants.find((v) => defaultDist[v.key] >= 100);
  const defaultText = defaultOnly
    ? label(defaultOnly.key)
    : variants.map((v) => `${v.key} ${fmtPct0(defaultDist[v.key])}`).join(' · ');

  let summary;
  if (rolloutPct > 0) {
    const parts = variants.filter((v) => !v.isControl).map((v) => `${v.key} ${fmtPct0(rolloutDist[v.key])}`);
    summary = [`rollout ${fmtPct0(rolloutPct)}`, ...parts].join(' · ');
    if (rolloutPct < 100) summary += ` · others → ${defaultText}`;
    if (only) summary += ` → everyone on ${only.label}`;
  } else {
    summary = `environment default → ${defaultText}`;
  }
  return {
    summary,
    shares,
    rolloutPct,
    mode: rolloutPct > 0 ? 'rollout' : 'default',
    soleKey: only ? only.key : null,
    flagEnabled: def ? def.enabled !== false : null,
  };
}

function fmtPct0(p) {
  return `${Number.isInteger(p) ? p : num(1).format(p)}%`;
}

// ---- numbers -------------------------------------------------------------------------------------------------

export function formatInt(n) {
  return Number.isFinite(n) ? num(0).format(n) : '—';
}

/** 0.1234 → "12.3%"; minus sign is the typographic one. */
export function formatPercent(ratio, digits = 1) {
  if (ratio == null || !Number.isFinite(ratio)) return '—';
  const s = num(digits).format(Math.abs(ratio * 100));
  return `${ratio < 0 && s !== num(digits).format(0) ? MINUS : ''}${s}%`;
}

/** Lift as Flagsmith returned it, a ratio: 0.3 → "+30.0%", -0.02 → "−2.0%". */
export function formatLift(lift) {
  if (lift == null || !Number.isFinite(lift)) return '—';
  const s = formatPercent(lift);
  return lift > 0 && s !== formatPercent(0) ? `+${s}` : s;
}

export function formatInterval(low, high) {
  if (!Number.isFinite(low) || !Number.isFinite(high)) return '—';
  return `${formatLift(low)} to ${formatLift(high)}`;
}

/** Chance to win: 0.967 → "96.7%", never claiming certainty. */
export function formatChance(p) {
  if (p == null || !Number.isFinite(p)) return '—';
  if (p > 0.999) return '>99.9%';
  if (p < 0.001) return '<0.1%';
  return formatPercent(p);
}

/** Per-variant value of a metric: sum / n (occurrence: conversion rate; mean: average value). */
export function metricValue(v) {
  if (!v || !Number.isFinite(v.n) || v.n <= 0 || !Number.isFinite(v.sum)) return null;
  return v.sum / v.n;
}

export function formatMetricValue(value, aggregation, name = '') {
  if (value == null || !Number.isFinite(value)) return '—';
  if (aggregation === 'occurrence') return formatPercent(value);
  if (/(_ms$|latency)/i.test(name)) return `${num(value < 10 ? 1 : 0).format(value)} ms`;
  if (/error/i.test(name) && value >= 0 && value <= 1) return formatPercent(value, 2); // mean of a 0/1 event: a rate
  return num(Math.abs(value) < 10 ? 2 : 1).format(value);
}

// A mean is Flagsmith's per exposed identity: an identity with no event counts as 0 (see docs/FLAGSMITH.md).
export function aggregationLabel(aggregation) {
  return { occurrence: 'occurrence', count: 'count', sum: 'sum', mean: 'mean per exposed identity' }[aggregation] ?? String(aggregation ?? '');
}

export function directionLabel(direction) {
  if (direction === 'up') return 'higher is better';
  if (direction === 'down') return 'lower is better';
  return 'no preferred direction';
}

// ---- wording ---------------------------------------------------------------------------------------------------

/** Flagsmith's own words for a chance to win. */
export function verdict(chance) {
  if (chance == null || !Number.isFinite(chance)) return { word: 'collecting data', tone: 'neutral' };
  if (chance > WINNING) return { word: 'winning', tone: 'good' };
  if (chance < LOSING) return { word: 'losing', tone: 'bad' };
  return { word: 'inconclusive', tone: 'neutral' };
}

/**
 * A mean metric that is 0 in every variant (each release reported, even with no events at all): nothing happened,
 * so nothing to compare. Flagsmith shows these as collecting data; the console says what it means.
 */
export function isAllZero(metricDef, metricResult, keys) {
  if (!metricDef || metricDef.aggregation !== 'mean' || !metricResult?.variants) return false;
  const variants = keys.map((k) => metricResult.variants[k]);
  return variants.length > 0 && variants.every((v) => v && Number.isFinite(v.n) && v.n >= 0 && v.sum === 0);
}

export function noEventsText(metricName, variantCount) {
  const scope = variantCount > 2 ? 'any release' : 'either release';
  if (/error/i.test(metricName ?? '')) return `No errors in ${scope}`;
  return `No ${metricName} recorded in ${scope}`;
}

/**
 * One metric's card, assembled from Flagsmith's payload:
 * state 'collecting' (missing metric or no inference), 'no-events' (all zero) or 'ready'.
 */
export function assessMetric(experiment, metricDef, results, index) {
  const variants = variantList(experiment);
  const keys = variants.map((v) => v.key);
  const result = results?.payload?.metrics?.find((m) => m.metric_id === metricDef.metric) ?? null;
  const rows = variants.map((v) => {
    const raw = result?.variants?.[v.key] ?? null;
    const value = metricValue(raw);
    return {
      key: v.key,
      label: v.label,
      color: v.color,
      n: raw ? raw.n : null,
      value,
      display: formatMetricValue(value, metricDef.aggregation, metricDef.metric_name),
    };
  });
  const treatments = variants
    .filter((v) => !v.isControl)
    .map((v) => {
      const inf = result?.inference?.[v.key] ?? null;
      if (!inf) return { key: v.key, label: v.label, color: v.color, collecting: true, verdict: verdict(null) };
      return {
        key: v.key,
        label: v.label,
        color: v.color,
        collecting: false,
        lift: inf.lift,
        ciLow: inf.ci_low,
        ciHigh: inf.ci_high,
        chance: inf.chance_to_win,
        verdict: verdict(inf.chance_to_win),
      };
    });
  let state = 'ready';
  if (isAllZero(metricDef, result, keys)) state = 'no-events';
  else if (!result || treatments.every((t) => t.collecting)) state = 'collecting';
  return {
    id: metricDef.metric,
    name: metricDef.metric_name,
    role: index === 0 ? 'goal' : 'guardrail',
    aggregation: aggregationLabel(metricDef.aggregation),
    direction: directionLabel(metricDef.direction),
    state,
    note: state === 'no-events' ? noEventsText(metricDef.metric_name, variants.length) : state === 'collecting' ? 'Collecting data' : '',
    rows,
    treatments,
  };
}

/** The headline under Flagsmith's results: who the results page shows ahead, and Flagsmith's word for it. */
export function winnerText(experiment, winner) {
  const primary = experiment?.metrics?.[0]?.metric_name ?? 'the goal metric';
  if (!winner) {
    return {
      tone: 'neutral',
      headline: 'No leader yet',
      detail: `Flagsmith is collecting data on ${primary}.`,
    };
  }
  const label = releaseLabel(experiment, winner.key);
  const v = verdict(winner.chanceToWin);
  const chance = formatChance(winner.chanceToWin);
  if (v.word === 'winning') {
    return {
      tone: 'good',
      headline: `${winner.key} (${label}) is winning`,
      detail: `${chance} chance to win on ${primary}, above Flagsmith's 95% bar.`,
    };
  }
  return {
    tone: 'neutral',
    headline: `${winner.key} (${label}) leads, inconclusive`,
    detail: `${chance} chance to win on ${primary}. Flagsmith calls only >95% winning; shipping now is a human call.`,
  };
}

export function srmText(results) {
  const p = results?.payload?.srm_p_value;
  if (p == null || !Number.isFinite(p)) return 'Sample-ratio check: not computed';
  return `Sample-ratio check: p = ${p < 0.001 ? '<0.001' : num(3).format(p)}, as returned`;
}

export function eventsText(events) {
  if (!events) return 'Flagsmith event counter unavailable (no Prometheus endpoint configured or reachable)';
  return `${formatInt(events.accepted)} accepted · ${formatInt(events.rejected)} rejected`;
}

/** Flagsmith's refusal body (a JSON string from the server) → one readable sentence. */
export function refreshReason(reason) {
  if (reason == null || reason === '') return 'Flagsmith refused the refresh.';
  let body = reason;
  if (typeof reason === 'string') {
    try {
      body = JSON.parse(reason);
    } catch {
      return reason;
    }
  }
  const flat = (x) =>
    x == null ? [] : typeof x === 'string' || typeof x === 'number' ? [String(x)] : Array.isArray(x) ? x.flatMap(flat) : Object.values(x).flatMap(flat);
  const text = flat(body).join(' ').trim();
  return text || 'Flagsmith refused the refresh.';
}

export function statusLabel(status) {
  return { created: 'Created', running: 'Running', paused: 'Paused', completed: 'Completed' }[status] ?? String(status ?? 'Unknown');
}

export function stepMark(status) {
  return status === 'done' ? '✓' : '·';
}

export function stepStatusText(status) {
  return status === 'done' ? 'done' : 'skipped, already done';
}

/** "1 dot ≈ N requests" when dots were dropped to keep the map smooth; '' when every request got a dot. */
export function samplingLabel(received, drawn) {
  if (!received || !drawn || received <= drawn * 1.05) return '';
  return `1 dot ≈ ${Math.max(2, Math.round(received / drawn))} requests`;
}

/** Elapsed time in words: 12 s ago, 4 min ago, 1 h 5 min ago, 3 d ago. */
export function formatAgo(thenMs, nowMs = Date.now()) {
  if (!Number.isFinite(thenMs)) return '';
  const s = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min ago` : `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export function parseTime(iso) {
  if (!iso) return NaN;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : NaN;
}

/** experiment-7-2026-11-17T02-00-00-000Z.json → the ISO time it was saved, or null. */
export function snapshotTime(filename) {
  const m = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(filename ?? '');
  if (!m) return null;
  return `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
}

// ---- guardrails, ledger and history ----------------------------------------------------------------------------

/** One losing guardrail from /api/plan or a refused Ship: "v2 is losing on doc_latency_ms: 0.0% chance to win". */
export function guardrailWarningText(variantKey, warning) {
  return `${variantKey} is losing on ${warning.metric}: ${formatPercent(warning.chanceToWin)} chance to win`;
}

/**
 * Switchyard's recommendation (recommend() on the server, read off Flagsmith's interval and chance to win) in one
 * line: "Keep running: interval −14% to +44% crosses zero". Empty when there is none.
 */
export function recommendationText(rec) {
  if (!rec || typeof rec.reason !== 'string') return '';
  const call = rec.call === 'ship' ? 'Ship' : rec.call === 'revert' ? 'Revert' : 'Keep running';
  return `${call}: ${rec.reason}`;
}

/** The goal's credible interval from a recommendation, "−14.0% to +44.0%", or '' when Flagsmith has none. */
export function recommendationInterval(rec) {
  return rec?.interval ? formatInterval(rec.interval.low, rec.interval.high) : '';
}

/** The most recent ledger entry for an experiment, or null. */
export function latestEntryFor(ledger, experimentId) {
  const entries = (Array.isArray(ledger) ? ledger : []).filter((e) => e && e.experimentId === experimentId);
  entries.sort((a, b) => (parseTime(a.at) || 0) - (parseTime(b.at) || 0));
  return entries.at(-1) ?? null;
}

/** A ledger decision in a few words: "shipped v2 (shop:1.5)" or "reverted". */
export function ledgerDecisionText(entry) {
  if (!entry) return '';
  if (entry.decision === 'reverted') return 'reverted';
  if (entry.decision === 'kept-running') return 'kept running';
  return `shipped ${entry.variant}${entry.release ? ` (${entry.release})` : ''}`;
}

/**
 * After a Ship (or Revert) the flag is a plain flag again, so someone can change it in Flagsmith. When the release the
 * environment default serves now (`serving`, computed by the server like `release` does) isn't the one the ledger
 * recorded, say so. Null when nothing swung back.
 */
export function swingBackText(experiment, ledger, serving) {
  if (experiment?.status !== 'completed' || !serving) return null;
  const entry = latestEntryFor(ledger, experiment.id);
  if (!entry?.release || entry.release === serving) return null;
  const what = entry.decision === 'reverted' ? 'revert' : 'ship';
  return `Changed in Flagsmith after the ${what}: everyone now gets ${serving}`;
}

// ---- demo controls: simulated visitors and the swing (the console's judge jobs) ---------------------------------

// The console clamps a visitors job to 50..3000 (judge.ts); the page says so before sending.
export const VISITORS_MIN = 50;
export const VISITORS_MAX = 3000;
export const VISITORS_DEFAULT = 1500;

/** The visitor count to send, from what the person typed: a whole number in 50..3000, else the default. */
export function visitorCount(raw) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || String(raw ?? '').trim() === '') return VISITORS_DEFAULT;
  return Math.min(VISITORS_MAX, Math.max(VISITORS_MIN, n));
}

/** Whether "Send visitors" applies: only a running experiment enrols visitors. */
export function visitorsView(experiment) {
  if (experiment?.status === 'running') {
    return { enabled: true, note: "Simulated, labelled visitors go through the Switchyard proxy, which reports their pages and orders to Flagsmith as events." };
  }
  if (experiment?.status === 'completed') return { enabled: false, note: 'This experiment is finished. Release the next version to send visitors to a new experiment.' };
  return { enabled: false, note: `The experiment is ${experiment?.status ?? 'not loaded'}, so the proxy isn't enrolling visitors.` };
}

/**
 * Swing back / forward after a ship: one edit to the flag's environment default, between the release that was
 * shipped and the one it replaced. Mirrors the console's own checks (judge.ts refusal()), so the buttons are only
 * enabled when the console would accept them. `serving` is what the environment default serves now.
 */
export function swingView(experiment, ledger, serving) {
  const off = (note) => ({ enabled: false, back: null, forward: null, suggested: null, note });
  if (!experiment) return off('Waiting for the experiment.');
  if (experiment.status !== 'completed') return off('Swing applies after Ship winner: it moves everyone between the shipped release and the one it replaced.');
  const entry = latestEntryFor(ledger, experiment.id);
  if (!entry) return off("There's no Switchyard decision for this experiment in the release ledger, so there is nothing to swing.");
  if (entry.decision !== 'shipped' || entry.variant === CONTROL || !entry.release) return off('Swing applies after shipping a new release; this experiment was reverted.');
  const option = (experiment.feature?.multivariate_options ?? []).find((o) => o?.key === entry.variant);
  if (!option) return off(`The flag has no variant ${entry.variant} any more.`);
  if (option.string_value !== entry.release) {
    return off(`${entry.variant} now serves ${option.string_value} for the preview, so swinging forward would send everyone there. Release it as an experiment instead.`);
  }
  const back = entry.replaced ?? releaseLabel(experiment, CONTROL);
  const forward = entry.release;
  const suggested = serving === forward ? 'back' : 'forward';
  return {
    enabled: true,
    back,
    forward,
    suggested,
    note: `Each is one edit to the flag's environment default in Flagsmith, the same as changing it in Flagsmith's flag editor. Everyone gets ${serving ?? 'the default'} now.`,
  };
}

/**
 * Judge mode: the optional swing step, offered beside the stage's one button once this experiment shipped a new
 * release: back to the release it replaced, then forward again. null when it doesn't apply: not decided, reverted,
 * both swings done, or a preview has since re-pointed the shipped variant (the console refuses to swing then).
 * `s` is GET /api/judge/state.
 */
export function judgeSwingOffer(s) {
  const e = s?.experiment;
  if (e?.status !== 'completed') return null;
  const step = (Array.isArray(s.steps) ? s.steps : []).find((x) => x?.id === 'swing');
  if (!step || step.status !== 'optional') return null;
  const last = latestEntryFor(s.ledger, e.id);
  if (!last || last.decision !== 'shipped' || last.variant === CONTROL || !last.release) return null;
  const variant = (Array.isArray(s.variants) ? s.variants : []).find((v) => v?.key === last.variant);
  if (variant && variant.release !== last.release) return null;
  const back = last.replaced ?? e.control ?? CONTROL;
  if (!s.live || s.live === last.release) return { action: 'swing-back', label: `Optional: swing everyone back to ${back}`, release: back };
  return { action: 'swing-forward', label: `Optional: swing forward to ${last.release}`, release: last.release };
}

/** What a finished demo job did, in one line, from GET /api/judge/job. */
export function demoJobText(job) {
  if (!job) return '';
  if (job.status === 'running') {
    const p = job.progress;
    const stage = (job.stages ?? []).find((s) => s.status === 'running')?.title;
    if (job.action === 'visitors' && p && p.total) return `Sending simulated visitors: ${formatInt(p.done)} of ${formatInt(p.total)}…`;
    return `${stage ?? 'Working'}…`;
  }
  if (job.status === 'failed') return `Stopped: ${job.error ?? 'the job failed'}.`;
  const r = job.result ?? {};
  if (job.action === 'visitors') {
    return `Sent ${formatInt(r.visitors)} simulated visitors. The proxy sends their events to Flagsmith every 2 s; Refresh on the results card asks Flagsmith to recompute.`;
  }
  if (job.action === 'swing-back' || job.action === 'swing-forward') {
    const where = job.action === 'swing-back' ? 'back' : 'forward';
    return r.matched
      ? `Swung ${where}: Flagsmith saved the flag and a new visitor now gets ${r.served}.`
      : `Swung ${where}: Flagsmith saved the flag. The proxy still served ${r.served ?? 'nothing'} after 10 s; it follows on its next refresh.`;
  }
  return 'Done.';
}

/** Past experiments on the flag (newest first), each with the ledger's decision for it when there is one. */
export function sidings(history, currentId, ledger) {
  return (Array.isArray(history) ? history : [])
    .filter((e) => e && e.id !== currentId)
    .map((e) => ({
      id: e.id,
      name: e.name,
      status: e.status,
      statusLabel: statusLabel(e.status),
      startedAt: parseTime(e.started_at),
      endedAt: parseTime(e.ended_at),
      decision: ledgerDecisionText(latestEntryFor(ledger, e.id)),
    }));
}
