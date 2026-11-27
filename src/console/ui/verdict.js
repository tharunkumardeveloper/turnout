// Results in plain words, shared by the console page and the terminal (try-cli.ts):
// the one-sentence verdict, "not sure yet" with how far along, the split check and the Markdown report.

const pct = (x) => `${Math.round(x * 100)}%`;

/** One sentence from Flagsmith's numbers: "B gets 18% more signup, 97% sure, no safety check losing: ship B." */
export function verdict(state, names = {}, opts = {}) {
  const r = state?.results;
  if (!r?.metrics?.length) return 'Not sure yet: Flagsmith has no results for this test. Send visitors, then get the results.';
  const goal = r.metrics.find((m) => m.role === 'goal') ?? r.metrics[0];
  const w = r.winner;
  const arms = Object.entries(goal.arms ?? {});
  const short = arms.filter(([, a]) => a.n < 50);
  if (short.length) return `Not sure yet: ${short.map(([k, a]) => `${k} has ${a.n} of 50 visitors`).join(', ')}.`;
  const goalName = opts.goalLabel ?? goal.name;
  if (!w) return `Not sure yet: no version is ahead on ${goalName}. Keep it running.`;
  const who = names[w.release ?? ''] ?? w.release ?? w.key;
  const lift = goal.byArm?.[w.key]?.lift ?? goal.v2?.lift;
  const losing = (r.losingGuardrails ?? []).map((g) => g.metric);
  const call = r.recommendation?.call;
  const settle = call === 'keep-running' ? r.recommendation?.settle : null; // experiments.ts settleText
  const notes = (r.recommendation?.notes ?? []).map((n) => ` Note: ${n}.`).join('');
  return sentence(who, lift, w, goalName, losing, call, settle) + notes;
}

function sentence(who, lift, w, goalName, losing, call, settle) {
  return `${who} ${lift != null && w.key !== 'control' ? `gets ${pct(Math.abs(lift))} ${lift >= 0 ? 'more' : 'fewer'} ${goalName}` : `leads on ${goalName}`}, ${pct(w.chanceToWin)} sure, ${losing.length ? `but worse on ${losing.join(', ')}` : 'no safety check losing'}: ${call === 'ship' ? `ship ${who}` : call === 'revert' ? 'revert' : `keep it running${settle ? ` (to settle it, ${settle})` : ''}`}.`;
}

// Chi-square critical values at p = 0.001, by degrees of freedom (versions − 1).
const CHI_001 = [0, 10.83, 13.82, 16.27, 18.47, 20.52];

/**
 * Split check: visitors per arm against the split the flag asks for (`weights`: { control: 80, v2: 20 }, from the judge
 * state's routing; an even split when not given). A chi-square past the p < 0.001 line means the split is off.
 */
export function splitCheck(arms, weights = null) {
  const entries = Object.entries(arms ?? {});
  const total = entries.reduce((n, [, a]) => n + a.n, 0);
  if (!total) return { ok: true, text: 'Split check: no visitors yet.' };
  const given = weights && entries.every(([k]) => Number(weights[k]) > 0) ? entries.map(([k]) => Number(weights[k])) : null;
  const sum = given ? given.reduce((a, b) => a + b, 0) : entries.length;
  const share = (i) => (given ? given[i] / sum : 1 / entries.length);
  const chi = entries.reduce((x, [, a], i) => x + (a.n - total * share(i)) ** 2 / (total * share(i)), 0);
  const ok = chi < (CHI_001[entries.length - 1] ?? 20.52);
  const even = !given || given.every((w) => w === given[0]);
  const target = even ? 'an even split' : `a ${given.map((w) => Math.round((w / sum) * 100)).join('/')} split`;
  return { ok, text: `Split check: ${entries.map(([k, a]) => `${k} ${a.n}`).join(', ')} for ${target}: ${ok ? 'as expected' : 'off, so the results may be biased (check that every version answers)'}.` };
}

/** The split the flag asks for, by arm ({ control: 50, v2: 50 }), from the judge state's routing; null when unknown. */
export function splitWeights(state) {
  const arms = state?.routing?.experiment?.arms;
  return arms?.length ? Object.fromEntries(arms.map((a) => [a.key, a.pct])) : null;
}

/** Every metric, one row per arm, exactly as Flagsmith returned it. */
export function metricRows(results) {
  const rows = [];
  for (const m of results?.metrics ?? []) {
    for (const [k, a] of Object.entries(m.arms ?? {})) {
      const vs = m.byArm?.[k] ?? (k === 'v2' ? m.v2 : null);
      rows.push({ metric: m.name, role: m.role, arm: k, n: a.n, mean: +Number(a.mean).toFixed(4), lift: vs ? pct(vs.lift) : '', interval: vs ? `${pct(vs.ciLow)} to ${pct(vs.ciHigh)}` : '', chance: vs ? pct(vs.chanceToWin) : '' });
    }
  }
  return rows;
}

/** The report: the verdict, the split check and every metric as Flagsmith returned it, in Markdown. */
export function report(state, at = new Date()) {
  const r = state?.results;
  const lines = [`# Test report: ${state?.experiment?.name ?? state?.flag ?? 'Try it'}`, '', `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC. Flagsmith's results as of ${r?.asOf ?? 'never'}.`, '', `**${verdict(state, state?.names)}**`, ''];
  if (!r) return lines.join('\n') + '\n';
  const goal = r.metrics.find((m) => m.role === 'goal') ?? r.metrics[0];
  lines.push(splitCheck(goal.arms, splitWeights(state)).text, '', '| Metric | Role | Arm | Visitors | Mean | Lift | 95% interval | Chance to win |', '|---|---|---|---|---|---|---|---|');
  for (const x of metricRows(r)) lines.push(`| ${x.metric} | ${x.role} | ${x.arm} | ${x.n} | ${x.mean} | ${x.lift} | ${x.interval} | ${x.chance} |`);
  return lines.join('\n') + '\n';
}

// ---- Plain words for people (UI review, 26 Nov): no try:a, no docs_x_pdf, no 0.1056 ----

/** How a goal reads: "POST /signup" → "sends the form to /signup"; "GET /cv.pdf" → "downloads cv.pdf". */
export function goalWords(goal) {
  if (!goal) return 'page speed';
  const [method, path = ''] = String(goal).split(' ');
  if (method === 'POST') return `sends the form to ${path}`;
  if (/\.(pdf|docx?|zip|pptx?|xlsx?)$/i.test(path)) return `downloads ${path.split('/').pop()}`;
  return `opens ${path.replace(/\*$/, '')}`;
}

/** A version's name for people: "B · Folder 2" (its letter, then the name it was given). */
export function versionName(release, names = {}) {
  if (!release) return '?';
  const letter = (String(release).match(/(?:^|:)([a-c])$/i)?.[1] ?? '').toUpperCase();
  const name = names[release];
  return letter ? (name ? `${letter} · ${name}` : letter) : (name ?? String(release));
}

/** The release each arm of the experiment serves: control → try:a, v2 → try:b… */
export function armReleases(state) {
  const e = state?.experiment;
  const out = {};
  for (const a of e?.arms ?? []) out[a.key] = a.release;
  if (e?.control && !out.control) out.control = e.control;
  if (e?.v2 && !out.v2) out.v2 = e.v2;
  return out;
}

const KNOWN = { doc_latency_ms: 'Page load time', lcp_ms: 'Largest paint (real browsers)', cls: 'Layout shift (real browsers)', vitals_reported: 'Browsers that reported page speed', server_error: 'Server errors' };
/** A metric's name for people. */
export function metricLabel(m, goal) {
  if (m.role === 'goal') return goal ? `Goal: a visitor who ${goalWords(goal)}` : 'Goal';
  return KNOWN[m.name] ?? m.name.replace(/_/g, ' ');
}

/** A metric's value as people read it: a rate in %, a time in ms. */
export function metricValue(m, mean) {
  if (mean == null || Number.isNaN(Number(mean))) return '–';
  if (m.name === 'doc_latency_ms' || /_ms$/.test(m.name)) return `${Math.round(mean)} ms`;
  if (m.aggregation === 'occurrence' || m.role === 'goal' || m.name === 'server_error') return `${(mean * 100).toFixed(1)}%`;
  return String(+Number(mean).toFixed(3));
}

/**
 * Is the test fair? A version whose goal request mostly fails (404 on that version only), or that converts nobody
 * while another does, can't win: say so plainly, with the numbers. null: nothing wrong seen.
 */
export function fairness(state, seen = [], goal, names = {}) {
  const r = state?.results;
  const releases = armReleases(state);
  if (goal) {
    const [method, path = ''] = String(goal).split(' ');
    const want = path.replace(/\*$/, '');
    const hit = seen.find((s) => s.action.startsWith(`${method} `) && s.action.slice(method.length + 1).startsWith(want));
    for (const [release, failed] of Object.entries(hit?.failedByRelease ?? {})) {
      const total = hit.byRelease?.[release] ?? 0;
      if (total >= 10 && failed / total > 0.5) return `${versionName(release, names)} never reaches the goal: ${hit.action} fails there (${failed} of ${total} answers were errors). This test isn't fair until ${versionName(release, names)} has that page too.`;
    }
  }
  const g = r?.metrics?.find((m) => m.role === 'goal');
  if (g) {
    const arms = Object.entries(g.arms ?? {});
    const zero = arms.filter(([, a]) => a.n >= 50 && Number(a.mean) === 0);
    const some = arms.filter(([, a]) => Number(a.mean) > 0);
    if (zero.length && some.length) return `${zero.map(([k]) => versionName(releases[k], names)).join(', ')} converted nobody in ${zero.map(([, a]) => a.n).join(', ')} visitors while ${some.map(([k]) => versionName(releases[k], names)).join(', ')} did: check that the goal exists on every version.`;
    // Visitors climbing while the goal stays at zero everywhere: the goal event isn't firing (the wrong path or method,
    // or a form that posts somewhere else), so this test can't find a winner however long it runs.
    if (goal && arms.length && arms.every(([, a]) => a.n >= 100 && Number(a.mean) === 0)) return `Nobody reached the goal in any version (${arms.map(([, a]) => a.n).join(' and ')} visitors): the goal isn't being counted. Check that your site really sends ${goal}, or change the goal.`;
  }
  return null;
}
