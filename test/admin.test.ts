import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { AdminClient, isClosedSocket } from '../src/flagsmith/admin.ts';

// A server that closes the socket without answering, the way gunicorn drops a kept-alive connection it has already
// closed while idle: `drops` requests in a row get no response.
let drops = 0;
const seen: string[] = [];
const server = http.createServer((req, res) => {
  seen.push(`${req.method} ${req.url}`);
  if (drops > 0) {
    drops--;
    req.socket.destroy();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
});
let client: AdminClient;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  client = new AdminClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/`, { apiKey: 'k' });
});
after(() => server.close());

test('a read on a socket the server closed is sent once more', async () => {
  seen.length = 0;
  drops = 1;
  assert.deepEqual(await client.get('/api/v1/projects/'), { ok: true });
  assert.deepEqual(seen, ['GET /api/v1/projects/', 'GET /api/v1/projects/']);
});

test('only once: a second closed socket is reported', async () => {
  seen.length = 0;
  drops = 2;
  await assert.rejects(client.get('/api/v1/projects/'), /fetch failed/);
  assert.equal(seen.length, 2);
});

test('a write is never sent twice', async () => {
  seen.length = 0;
  drops = 1;
  await assert.rejects(client.post('/api/v1/projects/', { name: 'x' }), /fetch failed/);
  assert.deepEqual(seen, ['POST /api/v1/projects/']);
});

test('isClosedSocket reads the reason from fetch\'s cause', () => {
  assert.equal(isClosedSocket(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })), true);
  assert.equal(isClosedSocket(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } })), true);
  assert.equal(isClosedSocket(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), false);
  assert.equal(isClosedSocket(new Error('x')), false);
});
