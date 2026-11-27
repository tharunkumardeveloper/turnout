import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { checkMarkdown, commentOnPullRequest, MARKER, pullRequestNumber } from '../src/ci/report.ts';

test('the report: a headline from the number of problems, then check\'s own output', () => {
  const ok = checkMarkdown({ problems: 0, lines: ['No experiment splits found.'], runUrl: 'https://github.com/o/r/actions/runs/1' });
  assert.ok(ok.startsWith(`${MARKER}\n### ✅ Turnout check: no problems found`));
  assert.match(ok, /sample-ratio check \(SRM\)/);
  assert.match(ok, /<details><summary>Full output<\/summary>\n\n```text\nNo experiment splits found\.\n```/);
  assert.match(ok, /\[This run\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/1\)/);
  const bad = checkMarkdown({ problems: 2, lines: ['✗ fail  Sample ratio: control 700, v2 300 for 50/50'] });
  assert.match(bad, /### ❌ Turnout check: 2 problems found/);
  assert.match(bad, /<details open>/, 'problems are shown unfolded');
  assert.match(checkMarkdown({ problems: 1, lines: [] }), /1 problem found/);
  assert.match(checkMarkdown({ problems: 0, lines: [], error: "Couldn't reach Flagsmith" }), /### ⚠️ Turnout check couldn't run\n\nCouldn't reach Flagsmith/);
  assert.doesNotMatch(checkMarkdown({ problems: 0, lines: ['a ``` b'] }), /a ``` b/, 'output can\'t close the code block');
});

test('the pull request a run is for, from the event payload', () => {
  assert.equal(pullRequestNumber({ pull_request: { number: 12 } }), 12);
  assert.equal(pullRequestNumber({ issue: { number: 7, pull_request: {} } }), 7);
  assert.equal(pullRequestNumber({ issue: { number: 7 } }), null, 'an issue comment is not a pull request');
  assert.equal(pullRequestNumber({ ref: 'refs/heads/main' }), null);
  assert.equal(pullRequestNumber(null), null);
});

function fakeGitHub(opts: { forbid?: boolean; comments?: { id: number; body: string; user: { type: string } }[] } = {}) {
  const calls: { method: string; url: string; body?: unknown; auth?: string }[] = [];
  const comments = opts.comments ?? [];
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const c of req) text += c;
    calls.push({ method: req.method!, url: req.url!, ...(text ? { body: JSON.parse(text) } : {}), auth: req.headers.authorization });
    if (opts.forbid && req.method !== 'GET') return void res.writeHead(403).end('{}');
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') return void res.end(JSON.stringify(comments));
    if (req.method === 'POST') return void res.writeHead(201).end(JSON.stringify({ html_url: 'https://github.com/o/r/pull/12#issuecomment-99' }));
    if (req.method === 'PATCH') return void res.end(JSON.stringify({ html_url: 'https://github.com/o/r/pull/12#issuecomment-5' }));
  });
  return { server, calls };
}
const start = (s: http.Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

test('posts one comment on the pull request, then edits that same comment on the next run', async () => {
  const first = fakeGitHub({ comments: [{ id: 3, body: 'LGTM', user: { type: 'User' } }] });
  const api = await start(first.server);
  try {
    const made = await commentOnPullRequest({ api, repository: 'o/r', number: 12, token: 't0k', body: `${MARKER}\nhello` });
    assert.deepEqual(made, { action: 'created', url: 'https://github.com/o/r/pull/12#issuecomment-99' });
    assert.equal(first.calls.at(-1)!.method, 'POST');
    assert.equal(first.calls.at(-1)!.url, '/repos/o/r/issues/12/comments');
    assert.deepEqual(first.calls.at(-1)!.body, { body: `${MARKER}\nhello` });
    assert.equal(first.calls.at(-1)!.auth, 'Bearer t0k');
  } finally {
    first.server.close();
  }
  // Someone quoting the marker doesn't count: only the bot's own comment is edited.
  const next = fakeGitHub({ comments: [{ id: 4, body: `${MARKER}\nquoted`, user: { type: 'User' } }, { id: 5, body: `${MARKER}\nold`, user: { type: 'Bot' } }] });
  const api2 = await start(next.server);
  try {
    const edited = await commentOnPullRequest({ api: api2, repository: 'o/r', number: 12, token: 't0k', body: `${MARKER}\nnew` });
    assert.equal(edited.action, 'updated');
    assert.equal(next.calls.at(-1)!.method, 'PATCH');
    assert.equal(next.calls.at(-1)!.url, '/repos/o/r/issues/comments/5');
  } finally {
    next.server.close();
  }
});

test('no permission to comment (403) is reported, not thrown', async () => {
  const gh = fakeGitHub({ forbid: true });
  const api = await start(gh.server);
  try {
    assert.deepEqual(await commentOnPullRequest({ api, repository: 'o/r', number: 1, token: 't', body: 'x' }), { action: 'forbidden' });
  } finally {
    gh.server.close();
  }
});
