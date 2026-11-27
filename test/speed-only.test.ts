// No goal in the config: the proxy still routes, records exposures and sends page speed and errors; no goal events.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { createProxy, ID_COOKIE, type Assignment, type FlagSource } from '../src/proxy/server.ts';

test('speed-only: page loads send doc_latency_ms and server_error, a POST sends nothing', async () => {
  const app = http.createServer((req, res) => res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'text/html' }).end('ok'));
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  const appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const tracked: string[] = [];
  const exposures: string[] = [];
  const flags: FlagSource = {
    async assign(id, o): Promise<Assignment> {
      if (o.recordExposure) exposures.push(id);
      return { variant: 'v2', release: 'app:1.1', enrolled: true };
    },
    track: (event) => void tracked.push(event),
  };
  const config = parseConfig({ flag: 'app_release', releases: { 'app:1.0': appUrl, 'app:1.1': appUrl } });
  const proxy = createProxy({ config, flags, log: () => {}, warn: () => {} });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  const cookie = `${ID_COOKIE}=44444444-4444-4444-8444-444444444444`;
  await (await fetch(`${base}/`, { headers: { accept: 'text/html', cookie } })).text();
  await (await fetch(`${base}/signup`, { method: 'POST', headers: { cookie } })).text();
  await new Promise((r) => setTimeout(r, 20));
  proxy.close();
  app.close();
  assert.equal(exposures.length, 1);
  assert.deepEqual(tracked.sort(), ['doc_latency_ms', 'server_error']);
});
