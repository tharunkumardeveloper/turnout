import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { loadConfig, matchesRule } from '../src/config.ts';
import { readFileSync } from 'node:fs';

test('the landing example: a page with a Sign up button, POST /signup answers 201 (the config goal), no Flagsmith', async () => {
  const { createLanding } = await import('../demo/landing/server.ts');
  const server = createLanding();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const page = await (await fetch(base)).text();
    assert.match(page, /<button>/);
    assert.match(page, /action="\/signup"/);
    const ok = await fetch(`${base}/signup`, { method: 'POST', body: new URLSearchParams({ email: 'a@b.c' }) });
    assert.equal(ok.headers.get('x-switchyard-event'), 'signup'); // the optional header alternative
    const bad = await fetch(`${base}/signup`, { method: 'POST', body: new URLSearchParams({ email: 'nope' }) });
    const config = loadConfig('examples/landing/switchyard.config.yml');
    assert.equal(matchesRule(config.goal.when!, 'POST', '/signup', ok.status), true);
    assert.equal(matchesRule(config.goal.when!, 'POST', '/signup', bad.status), false);
    assert.deepEqual([...config.releases.keys()], ['landing:1', 'landing:2']);
  } finally {
    server.close();
  }
  assert.doesNotMatch(readFileSync('demo/landing/server.ts', 'utf8').replace(/^\/\/.*$/gm, ''), /flagsmith/i);
});
