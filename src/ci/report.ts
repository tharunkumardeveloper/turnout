// turnout check in CI: its result as Markdown for the job summary, and one pull-request comment that each run updates
// instead of adding another. Uses only GitHub's REST API with the workflow's own token (GITHUB_TOKEN), and needs the
// workflow to grant `pull-requests: write` for the comment; without it, the job summary still has the report.

/** The marker that finds Turnout's earlier comment on a pull request, so a new run edits it. */
export const MARKER = '<!-- turnout-check -->';

/** The report: a headline from the number of problems, then check's own output, exactly as it printed it. */
export function checkMarkdown(o: { problems: number; lines: string[]; error?: string | null; runUrl?: string | null }): string {
  const head = o.error
    ? `### ⚠️ Turnout check couldn't run\n\n${o.error}`
    : o.problems === 0
      ? '### ✅ Turnout check: no problems found'
      : `### ❌ Turnout check: ${o.problems} problem${o.problems === 1 ? '' : 's'} found`;
  const what = 'Experiment splits left on a flag after its experiment stopped, and, with an admin key, the Experiment Doctor: exposures on every arm, events on every arm, and the sample-ratio check (SRM) against the configured split.';
  const body = o.lines.length ? `\n\n<details${o.problems > 0 || o.error ? ' open' : ''}><summary>Full output</summary>\n\n\`\`\`text\n${o.lines.join('\n').replaceAll('```', "'''")}\n\`\`\`\n\n</details>` : '';
  return `${MARKER}\n${head}\n\n${what}${body}${o.runUrl ? `\n\n[This run](${o.runUrl})` : ''}\n`;
}

type Fetch = typeof fetch;
type Comment = { id: number; body?: string; user?: { type?: string } };

/** The pull request a workflow run is for, from the event payload GitHub writes (GITHUB_EVENT_PATH); null otherwise. */
export function pullRequestNumber(event: unknown): number | null {
  const e = event as { pull_request?: { number?: unknown }; issue?: { number?: unknown; pull_request?: unknown } } | null;
  if (typeof e?.pull_request?.number === 'number') return e.pull_request.number;
  if (e?.issue?.pull_request && typeof e.issue.number === 'number') return e.issue.number;
  return null;
}

/**
 * Posts the report on the pull request, or edits Turnout's earlier comment there (found by MARKER among the bot's
 * comments). Returns what it did. A 403 (the workflow didn't grant pull-requests: write) is returned, not thrown.
 */
export async function commentOnPullRequest(o: {
  api: string; // GITHUB_API_URL, e.g. https://api.github.com
  repository: string; // owner/name
  number: number;
  token: string;
  body: string;
  fetch?: Fetch;
}): Promise<{ action: 'created' | 'updated' | 'forbidden'; url?: string }> {
  const get = o.fetch ?? fetch;
  const headers = { authorization: `Bearer ${o.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' };
  const base = `${o.api.replace(/\/$/, '')}/repos/${o.repository}/issues`;
  let existing: Comment | undefined;
  for (let page = 1; page <= 10 && !existing; page++) {
    const res = await get(`${base}/${o.number}/comments?per_page=100&page=${page}`, { headers });
    if (res.status === 403) return { action: 'forbidden' };
    if (!res.ok) throw new Error(`GitHub answered ${res.status} listing the pull request's comments`);
    const comments = (await res.json()) as Comment[];
    existing = comments.find((c) => c.body?.startsWith(MARKER) && c.user?.type === 'Bot');
    if (comments.length < 100) break;
  }
  const res = existing
    ? await get(`${base}/comments/${existing.id}`, { method: 'PATCH', headers, body: JSON.stringify({ body: o.body }) })
    : await get(`${base}/${o.number}/comments`, { method: 'POST', headers, body: JSON.stringify({ body: o.body }) });
  if (res.status === 403) return { action: 'forbidden' };
  if (!res.ok) throw new Error(`GitHub answered ${res.status} ${existing ? 'editing' : 'posting'} the comment`);
  const made = (await res.json()) as { html_url?: string };
  return { action: existing ? 'updated' : 'created', ...(made.html_url ? { url: made.html_url } : {}) };
}
