// Try it from the terminal (docs/PLAN.md step 8): the same calls the console page makes, on a local Turnout.
//   turnout try <repo|folder|image> …   build them (one: A/A; two or three: A/B, A/B/C) and start the test
//   turnout goals                       what a visitor can do on every version, the goal first
//   turnout results [--full]            Flagsmith's verdict in one sentence; --full: every metric
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
// @ts-expect-error: a plain browser module with no types (the console page loads it as is)
import { SKIP, detect, tarParts } from '../console/ui/try-model.js';

export type TryClient = { call: <T = any>(path: string, init?: RequestInit) => Promise<T> };

const NEXT = {
  console: 'Start Turnout first: turnout.bat (Windows) or sh turnout.sh, then run this again.',
  build: 'Build something first: turnout try <repo|folder|image>.',
};

export async function connect(consoleUrl = process.env.TURNOUT_CONSOLE ?? 'http://127.0.0.1:8090'): Promise<TryClient> {
  const base = consoleUrl.replace(/\/$/, '');
  const page = await fetch(`${base}/app`).then((r) => r.text()).catch(() => '');
  const token = page.match(/name="turnout-console" content="([^"]+)"/)?.[1];
  if (!token) throw new Error(`No Turnout console with Try it at ${base}. ${NEXT.console}`);
  return {
    async call(path, init = {}) {
      const tar = path === '/try/upload';
      const res = await fetch(`${base}${tar ? '/api' : '/try/api'}${path}`, {
        ...init,
        headers: { 'x-turnout-console': token, 'content-type': tar ? 'application/x-tar' : 'application/json' },
      });
      const body = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new Error(`${body.error ?? `HTTP ${res.status}`}${res.status === 404 && path.startsWith('/judge') ? ` ${NEXT.build}` : ''}`);
      return body;
    },
  };
}

function folderTar(dir: string): Buffer {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const full = join(d, n);
      const rel = relative(dir, full).replaceAll('\\', '/');
      if (SKIP.test(rel)) continue;
      if (statSync(full).isDirectory()) walk(full);
      else files.push(rel);
    }
  };
  walk(dir);
  return Buffer.concat(tarParts(files.map((path) => {
    const data = new Uint8Array(readFileSync(join(dir, path)));
    return { path, size: data.length, data };
  })));
}

/** What one argument is: a folder on this machine, a git repository or an image. */
export async function sourceOf(c: TryClient, arg: string): Promise<{ kind: string; value: string }> {
  if (existsSync(arg) && statSync(arg).isDirectory()) {
    const { id } = await c.call<{ id: string }>('/try/upload', { method: 'POST', body: folderTar(resolve(arg)) });
    return { kind: 'folder', value: id };
  }
  const d = detect(arg);
  if (!d?.kind || d.kind === 'dockerfile') throw new Error(`"${arg}" isn't a folder, a git repository or an image name. Give one of those.`);
  return { kind: d.kind, value: d.value };
}

export async function tryCommand(c: TryClient, args: string[], o: { goal?: string; env?: string; log?: (l: string) => void } = {}): Promise<void> {
  const log = o.log ?? console.log;
  if (!args.length || args.length > 3) throw new Error('Give one, two or three versions: turnout try ./v1 ./v2 (folders, git repositories or images).');
  const versions = [];
  for (const a of args) versions.push(await sourceOf(c, a));
  await c.call('/try/build', { method: 'POST', body: JSON.stringify({ versions, goal: o.goal ?? '', env: o.env }) });
  let shown = 0;
  let st: any;
  do {
    await new Promise((r) => setTimeout(r, 2000));
    st = await c.call('/try/status');
    for (const l of (st.log ?? []).slice(shown)) if (l.level !== 'info') log(`${l.from}: ${l.text}`);
    shown = st.log?.length ?? 0;
  } while (st.status === 'building');
  if (st.status !== 'ready') {
    const needs = st.needs ? ` It needs${st.needs.settings.length ? ` settings ${st.needs.settings.join(', ')} (add --env "NAME=value")` : ''}${st.needs.database ? ` a database (open the console's Try it and press "Give it a throwaway ${st.needs.database}")` : ''}.` : '';
    throw new Error(`${st.error ?? 'the build stopped'}.${needs} Fix it, then run turnout try again.`);
  }
  log(`Ready: the ${st.kind} test is running. Your app's console: /app. Next: turnout goals, then turnout results.`);
}

export async function goalsCommand(c: TryClient, log = console.log): Promise<void> {
  const st = await c.call('/try/status');
  const actions = (st.actions ?? []) as { goal: string; label: string }[];
  if (!actions.length) return void log(st.status === 'ready' ? 'No action a visitor takes reaches the server on every version: the test compares page speed and errors.' : NEXT.build);
  for (const a of actions) log(`${a.goal === st.goal ? '→' : ' '} ${a.goal.padEnd(28)} a visitor who ${a.label}`);
  const w = await c.call('/try/actions').catch(() => null);
  if (w?.seen?.length) {
    log('\nSeen through the proxy (visitors, simulated ones included):');
    for (const s of w.seen.slice(0, 10)) log(`  ${s.action.padEnd(28)} ${String(s.count).padStart(5)}  ${Object.entries(s.statuses).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  }
  log(`\nThe goal is ${st.goal ?? 'page speed'}${st.goalSince ? `, counting from ${String(st.goalSince).slice(11, 16)} UTC` : ''}. To count another: turnout goal "<action>".`);
  if (w?.needed) {
    const counted = Object.entries(w.counted ?? {}).map(([k, n]) => `${k} ${n}`).join(', ');
    log(`Visitors needed: about ${w.needed.perVersion} per version to see a ${Math.round(w.needed.lift * 100)}% lift on a ${(w.needed.base * 100).toFixed(1)}% conversion rate (Flagsmith's minimum: 50 visitors and 5 conversions)${counted ? `. Counted so far: ${counted}` : ''}.`);
  }
}

/** The goal changes mid-test: a new experiment on the same versions, counted from now. */
export async function goalCommand(c: TryClient, goal: string, log = console.log): Promise<void> {
  const { goalSince } = await c.call<{ goalSince: string }>('/try/goal', { method: 'POST', body: JSON.stringify({ goal }) });
  let st: any;
  do {
    await new Promise((r) => setTimeout(r, 1500));
    st = await c.call('/try/status');
  } while (st.status === 'building');
  if (st.status !== 'ready') throw new Error(`${st.error ?? 'the goal change stopped'}. Run turnout goal again, or turnout try to rebuild.`);
  log(`The goal is now ${goal || 'page speed'}, counting from ${goalSince.slice(11, 16)} UTC. Next: send visitors, then turnout results.`);
}

/** Simulated visitors at a low, steady rate (0 stops them); results are fetched when Flagsmith allows. */
export async function steadyCommand(c: TryClient, perMinute: number, log = console.log): Promise<void> {
  const s = await c.call<{ on: boolean; perMinute: number }>('/try/steady', { method: 'POST', body: JSON.stringify({ perMinute }) });
  log(s.on ? `Simulated visitors: ${s.perMinute} a minute, labelled as simulated. Results refresh every 5 minutes. Stop: turnout steady 0.` : 'Simulated visitors stopped.');
}

/** Every decided test: when, the decision, the version everyone now gets, and Flagsmith's numbers. */
export async function historyCommand(c: TryClient, log = console.log): Promise<void> {
  const s = await c.call('/judge/state');
  const ledger = (s.ledger ?? []) as { at: string; decision: string; experiment: string; release: string | null; results: string[] }[];
  if (!ledger.length) return void log('No decisions yet. Ship or revert a test first (turnout results says which).');
  for (const e of [...ledger].reverse()) {
    log(`${e.at.slice(0, 16).replace('T', ' ')}  ${e.decision.padEnd(12)} ${e.release ?? '-'}  ${e.experiment}`);
    for (const r of e.results.slice(0, 3)) log(`    ${r}`);
  }
}

/** After Ship: the next step, make the winner the default deploy. */
export function afterShip(release: string, names: Record<string, string> = {}): string {
  const who = names[release] ?? release;
  return `Next: make ${who} the default deploy. The flag already sends everyone to it; point your deploy at ${who}'s commit or image, then remove the other version. Report: turnout results --report > report.md`;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** One sentence from Flagsmith's numbers: "B gets 18% more signup, 97% sure, no slowdown: ship B". */
export function verdict(state: any, names: Record<string, string> = {}): string {
  const r = state.results;
  if (!r?.metrics?.length) return 'Not sure yet: Flagsmith has no results for this test. Send visitors, then run turnout results again.';
  const goal = r.metrics.find((m: any) => m.role === 'goal') ?? r.metrics[0];
  const w = r.winner;
  const arms = Object.entries(goal.arms ?? {}) as [string, { n: number }][];
  const short = arms.filter(([, a]) => a.n < 50);
  if (short.length) return `Not sure yet: ${short.map(([k, a]) => `${k} has ${a.n} of 50 visitors`).join(', ')}.`;
  if (!w) return `Not sure yet: no version is ahead on ${goal.name}. Keep it running.`;
  const who = names[w.release ?? ''] ?? w.release ?? w.key;
  const lift = goal.byArm?.[w.key]?.lift ?? goal.v2?.lift;
  const losing = (r.losingGuardrails ?? []).map((g: any) => g.metric);
  const call = r.recommendation?.call;
  return `${who} ${lift != null && w.key !== 'control' ? `gets ${pct(Math.abs(lift))} ${lift >= 0 ? 'more' : 'fewer'} ${goal.name}` : `leads on ${goal.name}`}, ${pct(w.chanceToWin)} sure, ${losing.length ? `but worse on ${losing.join(', ')}` : 'no safety check losing'}: ${call === 'ship' ? `ship ${who}` : call === 'revert' ? 'revert' : 'keep it running'}.`;
}

/** Split check: visitors per arm vs an even split. A chi-square past 10.83 (p < 0.001) means the split is off. */
export function splitCheck(arms: Record<string, { n: number }>): { ok: boolean; text: string } {
  const entries = Object.entries(arms);
  const total = entries.reduce((n, [, a]) => n + a.n, 0);
  if (!total) return { ok: true, text: 'Split check: no visitors yet.' };
  const expected = total / entries.length;
  const chi = entries.reduce((x, [, a]) => x + (a.n - expected) ** 2 / expected, 0);
  const ok = chi < 10.83;
  return { ok, text: `Split check: ${entries.map(([k, a]) => `${k} ${a.n}`).join(', ')} for an even split: ${ok ? 'as expected' : 'off, so the results may be biased (check that every version answers)'}.` };
}

/** The report: the verdict, the split check and every metric as Flagsmith returned it, in Markdown. */
export function report(state: any, at = new Date()): string {
  const r = state.results;
  const lines = [`# Test report: ${state.experiment?.name ?? state.flag ?? 'Try it'}`, '', `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC. Flagsmith's results as of ${r?.asOf ?? 'never'}.`, '', `**${verdict(state, state.names)}**`, ''];
  if (!r) return lines.join('\n') + '\n';
  const goal = r.metrics.find((m: any) => m.role === 'goal') ?? r.metrics[0];
  lines.push(splitCheck(goal.arms).text, '', '| Metric | Role | Arm | Visitors | Mean | Lift | 95% interval | Chance to win |', '|---|---|---|---|---|---|---|---|');
  for (const m of r.metrics) {
    for (const [k, a] of Object.entries(m.arms) as [string, { n: number; mean: number }][]) {
      const vs = m.byArm?.[k] ?? (k === 'v2' ? m.v2 : null);
      lines.push(`| ${m.name} | ${m.role} | ${k} | ${a.n} | ${+a.mean.toFixed(4)} | ${vs ? pct(vs.lift) : ''} | ${vs ? `${pct(vs.ciLow)} to ${pct(vs.ciHigh)}` : ''} | ${vs ? pct(vs.chanceToWin) : ''} |`);
    }
  }
  return lines.join('\n') + '\n';
}

export async function resultsCommand(c: TryClient, full = false, log = console.log, asReport = false): Promise<void> {
  const state = await c.call('/judge/state');
  if (asReport) return void log(report(state));
  log(verdict(state, state.names));
  const goal = state.results?.metrics?.find((m: any) => m.role === 'goal');
  if (goal) log(splitCheck(goal.arms).text);
  const last = (state.ledger ?? []).at(-1);
  if (last?.decision === 'shipped' && last.experimentId === state.experiment?.id && last.release) log(afterShip(last.release, state.names));
  if (!full || !state.results) return;
  for (const m of state.results.metrics) {
    log(`\n${m.name} (${m.role}, ${m.aggregation}, ${m.direction})`);
    for (const [k, a] of Object.entries(m.arms) as [string, { n: number; mean: number }][]) {
      const vs = m.byArm?.[k] ?? (k === 'v2' ? m.v2 : null);
      log(`  ${k.padEnd(8)} n=${a.n}  mean=${a.mean}${vs ? `  lift ${pct(vs.lift)} [${pct(vs.ciLow)}, ${pct(vs.ciHigh)}], ${pct(vs.chanceToWin)} chance to win` : ''}`);
    }
  }
}
