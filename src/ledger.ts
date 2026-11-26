// The release ledger: every Ship winner or Revert writes Flagsmith's result, as returned, next to the decision.
// Always to .turnout/ledger.jsonl and RELEASES.md; also to the release's GitHub Release when a token is set.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GuardrailWarning } from './flagsmith/experiments.ts';

export type LedgerEntry = {
  at: string;
  experimentId: number;
  experiment: string;
  hypothesis: string;
  flag: string;
  decision: 'shipped' | 'reverted' | 'kept-running'; // kept-running writes nothing to Flagsmith
  variant: string; // the variant everyone now gets
  release: string | null; // the release label it serves
  replaced: string | null; // what control served
  results: string[]; // Flagsmith's results, as returned, one line each
  resultsAsOf: string | null;
  losingGuardrailsAccepted: GuardrailWarning[];
  snapshot: string | null;
  by?: 'person' | 'guard'; // who decided; the guard only ever reverts
  guardReason?: string;
  reason?: string; // kept-running: why (e.g. "interval −14% to +44% crosses zero")
  interval?: { low: number; high: number } | null; // the goal's credible interval Flagsmith reported, as a relative lift
};

export function readLedger(dir: string): LedgerEntry[] {
  const file = join(dir, 'ledger.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as LedgerEntry];
      } catch {
        return []; // a torn last line from a crash; the rest still reads
      }
    });
}

export function recordDecision(dir: string, entry: LedgerEntry): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'ledger.jsonl'), `${JSON.stringify(entry)}\n`);
  const entries = readLedger(dir).reverse();
  writeFileSync(
    join(dir, 'RELEASES.md'),
    `# Releases\n\nWritten by Turnout on each Ship winner, Revert or Keep running. Results are Flagsmith's, as returned.\n\n${entries.map(renderEntry).join('\n')}`,
  );
}

export function renderEntry(e: LedgerEntry): string {
  const verb =
    e.decision === 'shipped'
      ? `Shipped ${e.variant}${e.release ? ` (${e.release})` : ''}`
      : e.decision === 'kept-running'
        ? `Kept running${e.reason ? `: ${e.reason}` : ''}`
        : `Reverted to control${e.replaced ? ` (${e.replaced})` : ''}`;
  const lines = [
    `## ${e.release ?? e.variant} · Flagsmith experiment ${e.experimentId}`,
    '',
    `**${verb}** ${e.by === 'guard' ? `automatically by Turnout's guard (${e.guardReason ?? 'a guardrail was losing'})` : 'by a person'}, on flag \`${e.flag}\`, at ${e.at}.${e.decision === 'kept-running' ? ' Nothing changed in Flagsmith; the experiment keeps running.' : ''}`,
    '',
    `- Experiment: ${e.experiment}`,
    `- Hypothesis: ${e.hypothesis}`,
    `- Flagsmith's results${e.resultsAsOf ? ` as of ${e.resultsAsOf}` : ''}:`,
    '',
    '```text',
    ...e.results,
    '```',
  ];
  if (e.losingGuardrailsAccepted.length) {
    lines.push(
      '',
      `- Shipped despite losing guardrails: ${e.losingGuardrailsAccepted.map((g) => `${g.metric} (${(g.chanceToWin * 100).toFixed(1)}% chance to win)`).join(', ')}`,
    );
  }
  if (e.snapshot) lines.push(`- Decision snapshot: \`${e.snapshot}\``);
  return `${lines.join('\n')}\n`;
}

// "shop:1.6" -> "v1.6": the git tag a release label stands for, unless the label is already a tag.
export function tagFor(release: string): string {
  const version = release.split(':').pop() ?? release;
  return /^v?\d/.test(version) ? (version.startsWith('v') ? version : `v${version}`) : version;
}

type GitHubOptions = { token: string; repository: string; apiUrl?: string; fetch?: typeof fetch };

// Adds (or replaces) this experiment's section in the tag's GitHub Release body, creating the release if the tag
// has none. The section is fenced by markers so re-running a decision rewrites it instead of appending twice.
export async function publishToGitHub(entry: LedgerEntry, tag: string, opts: GitHubOptions): Promise<string> {
  const doFetch = opts.fetch ?? fetch;
  const api = (opts.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');
  const headers = {
    authorization: `Bearer ${opts.token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
    'user-agent': 'turnout',
  };
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await doFetch(`${api}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as { id?: number; body?: string | null; html_url?: string; message?: string }) : {} };
  };

  const begin = `<!-- turnout:experiment-${entry.experimentId} -->`;
  const end = `<!-- /turnout:experiment-${entry.experimentId} -->`;
  const section = `${begin}\n${renderEntry(entry)}${end}`;

  const existing = await call('GET', `/repos/${opts.repository}/releases/tags/${encodeURIComponent(tag)}`);
  if (existing.status === 404) {
    const created = await call('POST', `/repos/${opts.repository}/releases`, { tag_name: tag, name: tag, body: section });
    if (created.status >= 300) throw new Error(`GitHub refused to create the release for ${tag}: ${created.status} ${created.json.message ?? ''}`);
    return created.json.html_url ?? '';
  }
  if (existing.status >= 300) throw new Error(`GitHub: ${existing.status} ${existing.json.message ?? ''}`);
  const body = existing.json.body ?? '';
  const start = body.indexOf(begin);
  const stop = body.indexOf(end);
  const next = start >= 0 && stop > start ? `${body.slice(0, start)}${section}${body.slice(stop + end.length)}` : `${body}${body ? '\n\n' : ''}${section}`;
  const updated = await call('PATCH', `/repos/${opts.repository}/releases/${existing.json.id}`, { body: next });
  if (updated.status >= 300) throw new Error(`GitHub refused to update the release for ${tag}: ${updated.status} ${updated.json.message ?? ''}`);
  return updated.json.html_url ?? '';
}
