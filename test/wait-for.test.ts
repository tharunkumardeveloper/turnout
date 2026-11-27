import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForHttp } from '../src/wait-for.ts';

const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });

test('waits while Flagsmith refuses connections, then starts (any HTTP status counts as up)', async () => {
  let clock = 0;
  const lines: string[] = [];
  let calls = 0;
  const fake = (async () => {
    calls++;
    if (calls < 4) throw refused();
    return new Response('{"detail":"Authentication credentials were not provided."}', { status: 401 });
  }) as typeof fetch;
  const tries = await waitForHttp('http://flagsmith:8000/api/v1/', { fetch: fake, sleep: async (ms) => void (clock += ms), now: () => clock, log: (l) => lines.push(l) });
  assert.equal(tries, 4);
  assert.deepEqual(lines, ['Waiting for Flagsmith at http://flagsmith:8000 (ECONNREFUSED)…', 'Flagsmith answers (after 6 s).']);
});

test('answers at once: says nothing', async () => {
  const lines: string[] = [];
  await waitForHttp('http://flagsmith:8000/api/v1/', { fetch: (async () => new Response('ok')) as typeof fetch, log: (l) => lines.push(l) });
  assert.deepEqual(lines, []);
});

test('gives up after the timeout, with the reason', async () => {
  let clock = 0;
  await assert.rejects(
    waitForHttp('http://flagsmith:8000/api/v1/', { timeoutMs: 10_000, fetch: (async () => { throw refused(); }) as typeof fetch, sleep: async (ms) => void (clock += ms), now: () => clock }),
    /didn't answer within 10 s \(ECONNREFUSED\)/,
  );
});
