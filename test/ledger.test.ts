import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { publishToGitHub, readLedger, recordDecision, renderEntry, tagFor, type LedgerEntry } from '../src/ledger.ts';

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  at: '2026-11-17T09:00:00.000Z',
  experimentId: 2,
  experiment: 'shop_release: shop:1.6 vs shop:1.5',
  hypothesis: 'Express checkout raises orders',
  flag: 'shop_release',
  decision: 'reverted',
  variant: 'control',
  release: 'shop:1.5',
  replaced: 'shop:1.5',
  results: ['  order_placed (occurrence, up): v2 0.125 (n=631), control 0.115 (n=589)'],
  resultsAsOf: '2026-11-17T08:59:59Z',
  losingGuardrailsAccepted: [],
  snapshot: null,
  ...over,
});

describe('ledger file', () => {
  test('appends entries and renders RELEASES.md newest first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    recordDecision(dir, entry({ experimentId: 1, decision: 'shipped', variant: 'v2', release: 'shop:1.5', replaced: 'shop:1.4' }));
    recordDecision(dir, entry());
    assert.deepEqual(readLedger(dir).map((e) => e.experimentId), [1, 2]);
    const md = readFileSync(join(dir, 'RELEASES.md'), 'utf8');
    assert.ok(md.indexOf('experiment 2') < md.indexOf('experiment 1'));
    assert.match(md, /\*\*Shipped v2 \(shop:1\.5\)\*\*/);
    assert.match(md, /\*\*Reverted to control \(shop:1\.5\)\*\*/);
  });

  test('a torn last line does not lose the rest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    recordDecision(dir, entry());
    (await import('node:fs')).appendFileSync(join(dir, 'ledger.jsonl'), '{"at":');
    assert.equal(readLedger(dir).length, 1);
    assert.deepEqual(readLedger(join(dir, 'missing')), []);
    assert.equal(existsSync(join(dir, 'RELEASES.md')), true);
  });

  test('names the decision snapshot when there is one', () => {
    assert.match(renderEntry(entry({ snapshot: '.switchyard/snapshots/experiment-2-x.json' })), /- Decision snapshot: `\.switchyard\/snapshots\/experiment-2-x\.json`/);
    assert.doesNotMatch(renderEntry(entry()), /Decision snapshot/);
  });

  test('says when a losing guardrail was accepted', () => {
    const text = renderEntry(entry({ decision: 'shipped', variant: 'v2', losingGuardrailsAccepted: [{ metric: 'doc_latency_ms', chanceToWin: 0.001, lift: 9 }] }));
    assert.match(text, /despite losing guardrails: doc_latency_ms \(0\.1% chance to win\)/);
  });
});

test('tagFor maps a release label to its git tag', () => {
  assert.equal(tagFor('shop:1.6'), 'v1.6');
  assert.equal(tagFor('shop:v2.0.1'), 'v2.0.1');
  assert.equal(tagFor('web:latest'), 'latest');
});

// A stub of the three GitHub REST calls the ledger makes.
async function fakeGitHub(releases: Map<string, { id: number; body: string }>) {
  const calls: string[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    calls.push(`${req.method} ${req.url} ${req.headers.authorization}`);
    const send = (status: number, data: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
    const byTag = req.url?.match(/^\/repos\/o\/r\/releases\/tags\/(.+)$/);
    if (req.method === 'GET' && byTag) {
      const r = releases.get(decodeURIComponent(byTag[1]!));
      return r ? send(200, { ...r, html_url: `https://gh/${r.id}` }) : send(404, { message: 'Not Found' });
    }
    if (req.method === 'POST' && req.url === '/repos/o/r/releases') {
      const body = JSON.parse(raw);
      const r = { id: releases.size + 100, body: body.body };
      releases.set(body.tag_name, r);
      return send(201, { ...r, html_url: `https://gh/${r.id}` });
    }
    const patch = req.url?.match(/^\/repos\/o\/r\/releases\/(\d+)$/);
    if (req.method === 'PATCH' && patch) {
      const r = [...releases.values()].find((x) => x.id === Number(patch[1]))!;
      r.body = JSON.parse(raw).body;
      return send(200, { ...r, html_url: `https://gh/${r.id}` });
    }
    send(404, { message: 'no route' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, close: () => server.close() };
}

describe('GitHub Release', () => {
  test('creates the release for a tag that has none', async () => {
    const releases = new Map<string, { id: number; body: string }>();
    const gh = await fakeGitHub(releases);
    const url = await publishToGitHub(entry(), 'v1.6', { token: 't0k', repository: 'o/r', apiUrl: gh.apiUrl });
    gh.close();
    assert.equal(url, 'https://gh/100');
    assert.match(releases.get('v1.6')!.body, /<!-- switchyard:experiment-2 -->[\s\S]*Reverted to control[\s\S]*<!-- \/switchyard:experiment-2 -->/);
    assert.ok(gh.calls.every((c) => c.endsWith('Bearer t0k')));
  });

  test("keeps the author's notes and rewrites only its own section on a re-run", async () => {
    const releases = new Map([['v1.6', { id: 7, body: 'Express checkout.' }]]);
    const gh = await fakeGitHub(releases);
    await publishToGitHub(entry(), 'v1.6', { token: 't', repository: 'o/r', apiUrl: gh.apiUrl });
    await publishToGitHub(entry({ resultsAsOf: 'later' }), 'v1.6', { token: 't', repository: 'o/r', apiUrl: gh.apiUrl });
    gh.close();
    const body = releases.get('v1.6')!.body;
    assert.ok(body.startsWith('Express checkout.\n\n'));
    assert.equal(body.split('<!-- switchyard:experiment-2 -->').length, 2, 'one section, not two');
    assert.match(body, /as of later/);
  });

  test('reports GitHub refusing', async () => {
    const gh = await fakeGitHub(new Map());
    await assert.rejects(publishToGitHub(entry(), 'v1.6', { token: 't', repository: 'o/nope', apiUrl: gh.apiUrl }), /GitHub/);
    gh.close();
  });
});

test('RELEASES.md says when the guard reverted, and why', () => {
  const text = renderEntry(entry({ by: 'guard', guardReason: 'shop:1.6 losing doc_latency_ms, 0.0% chance to win' }));
  assert.match(text, /\*\*Reverted to control \(shop:1\.5\)\*\* automatically by Switchyard's guard \(shop:1\.6 losing doc_latency_ms, 0\.0% chance to win\)/);
  assert.match(renderEntry(entry()), /\*\* by a person,/);
});
