import assert from 'node:assert/strict';
import { test } from 'node:test';
import { receiptFetch, Receipts } from '../src/flagsmith/receipts.ts';

const EVENTS_URL = 'http://flagsmith:8000/api/v1/events';
const batch = (events: { event: string; identifier: string | null }[]) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ events }),
});
const answering = (status: number, body?: unknown): typeof fetch => async () =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

test('matches accepted and rejected events to their visitors by batch index', async () => {
  const receipts = new Receipts();
  const f = receiptFetch(receipts, answering(202, { accepted: 2, rejected: [{ index: 1, error: 'value must be a number' }] }));
  await f(EVENTS_URL, batch([
    { event: '$flag_exposure', identifier: 'alice' },
    { event: 'doc_latency_ms', identifier: 'bob' },
    { event: 'order_placed', identifier: 'carol' },
  ]));
  assert.equal(receipts.get('alice')?.status, 'accepted');
  assert.deepEqual({ ...receipts.get('bob'), at: 0 }, { at: 0, event: 'doc_latency_ms', status: 'rejected', httpStatus: 202, error: 'value must be a number' });
  assert.equal(receipts.get('carol')?.event, 'order_placed');
});

test('reports whole-batch failures honestly', async () => {
  const cases: [number, string][] = [
    [400, 'batch_rejected'],
    [404, 'store_not_connected'],
    [503, 'not_delivered'],
  ];
  for (const [status, expected] of cases) {
    const receipts = new Receipts();
    await receiptFetch(receipts, answering(status))(EVENTS_URL, batch([{ event: 'x', identifier: 'dave' }]));
    assert.equal(receipts.get('dave')?.status, expected, `HTTP ${status}`);
  }
});

test('a network failure is not_delivered, and still rethrown to the SDK', async () => {
  const receipts = new Receipts();
  const failing: typeof fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  await assert.rejects(receiptFetch(receipts, failing)(EVENTS_URL, batch([{ event: 'x', identifier: 'erin' }])));
  assert.equal(receipts.get('erin')?.status, 'not_delivered');
});

test('environment-document polls pass straight through', async () => {
  const receipts = new Receipts();
  let calls = 0;
  const base: typeof fetch = async () => {
    calls++;
    return new Response('{}', { status: 200 });
  };
  await receiptFetch(receipts, base)('http://flagsmith:8000/api/v1/environment-document/', { method: 'GET' });
  assert.equal(calls, 1);
  assert.equal(receipts.get('anyone'), undefined);
});

test('keeps only the newest receipt per visitor', async () => {
  const receipts = new Receipts();
  receipts.record('frank', { at: 1, event: 'a', status: 'accepted', httpStatus: 202 });
  receipts.record('frank', { at: 2, event: 'b', status: 'accepted', httpStatus: 202 });
  assert.equal(receipts.get('frank')?.event, 'b');
});
