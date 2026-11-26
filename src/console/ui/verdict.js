// Results in plain words (docs/PLAN.md steps 6 and 7), shared by the console page and the terminal (try-cli.ts):
// the one-sentence verdict, "not sure yet" with how far along, the split check and the Markdown report.

const pct = (x) => `${Math.round(x * 100)}%`;

/** One sentence from Flagsmith's numbers: "B gets 18% more signup, 97% sure, no safety check losing: ship B." */
export function verdict(state, names = {}) {
  const r = state?.results;
  if (!r?.metrics?.length) return 'Not sure yet: Flagsmith has no results for this test. Send visitors, then get the results.';
  const goal = r.metrics.find((m) => m.role === 'goal') ?? r.metrics[0];
  const w = r.winner;
  const arms = Object.entries(goal.arms ?? {});
  const short = arms.filter(([, a]) => a.n < 50);
  if (short.length) return `Not sure yet: ${short.map(([k, a]) => `${k} has ${a.n} of 50 visitors`).join(', ')}.`;
  if (!w) return `Not sure yet: no version is ahead on ${goal.name}. Keep it running.`;
  const who = names[w.release ?? ''] ?? w.release ?? w.key;
  const lift = goal.byArm?.[w.key]?.lift ?? goal.v2?.lift;
  const losing = (r.losingGuardrails ?? []).map((g) => g.metric);
  const call = r.recommendation?.call;
  return `${who} ${lift != null && w.key !== 'control' ? `gets ${pct(Math.abs(lift))} ${lift >= 0 ? 'more' : 'fewer'} ${goal.name}` : `leads on ${goal.name}`}, ${pct(w.chanceToWin)} sure, ${losing.length ? `but worse on ${losing.join(', ')}` : 'no safety check losing'}: ${call === 'ship' ? `ship ${who}` : call === 'revert' ? 'revert' : 'keep it running'}.`;
}

/** Split check: visitors per arm vs an even split. A chi-square past 10.83 (p < 0.001) means the split is off. */
export function splitCheck(arms) {
  const entries = Object.entries(arms ?? {});
  const total = entries.reduce((n, [, a]) => n + a.n, 0);
  if (!total) return { ok: true, text: 'Split check: no visitors yet.' };
  const expected = total / entries.length;
  const chi = entries.reduce((x, [, a]) => x + (a.n - expected) ** 2 / expected, 0);
  const ok = chi < 10.83;
  return { ok, text: `Split check: ${entries.map(([k, a]) => `${k} ${a.n}`).join(', ')} for an even split: ${ok ? 'as expected' : 'off, so the results may be biased (check that every version answers)'}.` };
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
  lines.push(splitCheck(goal.arms).text, '', '| Metric | Role | Arm | Visitors | Mean | Lift | 95% interval | Chance to win |', '|---|---|---|---|---|---|---|---|');
  for (const x of metricRows(r)) lines.push(`| ${x.metric} | ${x.role} | ${x.arm} | ${x.n} | ${x.mean} | ${x.lift} | ${x.interval} | ${x.chance} |`);
  return lines.join('\n') + '\n';
}
