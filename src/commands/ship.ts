import { createInterface } from 'node:readline/promises';
import { decide, describeResults, plan, type DecideOptions } from '../decide.ts';
import { formatInterval, losingGuardrails, pickWinner, recommend, type Experiments, type Recommendation } from '../flagsmith/experiments.ts';

export { describeResults };

type Common = {
  experiments: Experiments;
  log?: (line: string) => void;
};

type DecisionOptions = Common & {
  yes?: boolean;
  acceptLosingGuardrails?: boolean;
  snapshotDir: string;
  ledgerDir: string;
  github?: DecideOptions['github'];
  confirm?: (question: string) => Promise<boolean>;
};

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const RED = (s: string) => (process.stdout.isTTY ? `\x1b[31m${s}\x1b[0m` : s);

export async function status(opts: Common & { refresh?: boolean }): Promise<void> {
  const log = opts.log ?? console.log;
  const exp = opts.experiments;
  if (opts.refresh) {
    const r = await exp.refreshResults();
    log(r.ok ? 'Requested a results refresh (computed in the background).' : `Refresh not allowed yet: ${r.reason}`);
  }
  const experiment = await exp.detail();
  const results = await exp.results();
  for (const line of describeResults(experiment, results)) log(line);
  const winner = pickWinner(experiment, results);
  if (winner) log(`Flagsmith's results page would show: winning variation ${winner.key} (${pct(winner.chanceToWin)} chance to be best)`);
  for (const w of winner ? losingGuardrails(experiment, results, winner.key) : []) {
    log(RED(`  Guardrail: ${winner!.key} is losing on ${w.metric} (${pct(w.chanceToWin)} chance to win)`));
  }
  for (const line of recommendationLines(recommend(experiment, results))) log(line);
}

// Flagsmith's interval on the goal and what Turnout recommends from it: an interval crossing zero isn't a win.
export function recommendationLines(rec: Recommendation): string[] {
  const call = rec.call === 'ship' ? 'ship' : rec.call === 'revert' ? 'revert' : 'keep running';
  return [
    rec.interval
      ? `Credible interval for ${rec.variant} on the goal: ${formatInterval(rec.interval)}${rec.chanceToWin !== null ? ` (${pct(rec.chanceToWin)} chance to win)` : ''}`
      : 'Credible interval on the goal: not computed yet',
    `Turnout recommends: ${call} (${rec.reason})`,
  ];
}

async function ask(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function run(opts: DecisionOptions, action: 'ship' | 'revert', winner: string, question: string): Promise<boolean> {
  const log = opts.log ?? console.log;
  const confirm = opts.confirm ?? ask;
  const exp = opts.experiments;
  const experiment = await exp.detail();
  const results = await exp.results();

  const losing = losingGuardrails(experiment, results, winner);
  let accept = opts.acceptLosingGuardrails ?? false;
  if (losing.length) {
    for (const w of losing) log(RED(`! ${winner} is losing on guardrail ${w.metric}: ${pct(w.chanceToWin)} chance to win, lift ${pct(w.lift)}`));
    if (!accept && opts.yes) throw new Error('A guardrail is losing. Add --accept-losing-guardrails to ship anyway, or revert.');
    if (!accept) accept = await confirm(RED(`Ship ${winner} even though it's losing on ${losing.map((w) => w.metric).join(', ')}?`));
    if (!accept) {
      log('Nothing changed. To send everyone back to control instead: turnout revert');
      return false;
    }
  }

  const steps = await plan(exp, action, winner, opts.snapshotDir);
  log('Plan:');
  steps.forEach((s, i) => log(`  ${i + 1}. ${s.title}\n     ${s.call}`));
  if (!opts.yes && !(await confirm(question))) {
    log('Nothing changed.');
    return false;
  }

  const decision = await decide({
    experiments: exp,
    action,
    winner,
    acceptLosingGuardrails: accept,
    snapshotDir: opts.snapshotDir,
    ledgerDir: opts.ledgerDir,
    ...(opts.github ? { github: opts.github } : {}),
    onStep: (s) => log(`  ${s.status === 'done' ? '✓' : '·'} ${s.title}${s.status === 'skipped' ? ' (already done)' : ''}`),
  });
  log(`\nRecorded in ${opts.ledgerDir}/RELEASES.md`);
  if (decision.entry.snapshot) log(`Decision snapshot: ${decision.entry.snapshot}`);
  if (decision.github && 'url' in decision.github) log(`Written to the GitHub Release: ${decision.github.url}`);
  if (decision.github && 'error' in decision.github) log(`Not written to GitHub: ${decision.github.error}`);
  return true;
}

export async function ship(opts: DecisionOptions & { winner?: string }): Promise<void> {
  const log = opts.log ?? console.log;
  const exp = opts.experiments;
  const experiment = await exp.detail();
  const results = await exp.results();
  for (const line of describeResults(experiment, results)) log(line);

  const suggested = pickWinner(experiment, results);
  const winner = opts.winner ?? suggested?.key;
  if (!winner) throw new Error('Flagsmith has no result to pick a winner from yet. Pass --winner <variant> to choose yourself.');
  log(
    opts.winner
      ? `\nShipping ${winner} (chosen by you${suggested ? `; Flagsmith's results page leans ${suggested.key}` : ''}).`
      : `\nShipping ${winner}, the variation Flagsmith's results page shows as winning (${pct(suggested!.chanceToWin)}).`,
  );
  const rec = recommend(experiment, results);
  for (const line of recommendationLines(rec)) log(line);
  if (rec.call === 'keep-running' && !opts.yes) {
    log(RED(`! Turnout recommends keeping the experiment running: ${rec.reason}. An interval crossing zero isn't a win.`));
  }
  if (await run(opts, 'ship', winner, rec.call === 'keep-running' ? 'Ship it anyway, against the recommendation?' : 'Ship it?')) {
    log(`\nEveryone now gets ${winner} from the flag's environment default. Rolling back is an ordinary flag edit.`);
  }
}

export async function revert(opts: DecisionOptions): Promise<void> {
  const log = opts.log ?? console.log;
  if (await run({ ...opts, acceptLosingGuardrails: true }, 'revert', 'control', 'Revert everyone to control?')) {
    log('\nEveryone now gets control from the flag\'s environment default. The experiment is complete; its split is drained.');
  }
}
