import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BROWSER_VISIT_UA, browserVisits, type Cdp } from '../src/commands/browsers.ts';
import { parseReleases, renderConfig, renderCompose } from '../src/commands/new.ts';

/** A stand-in browser: records every DevTools call and fires the load events a page would. */
function fakeChrome(failOn?: string) {
  const calls: { method: string; params: any }[] = [];
  let contexts = 0;
  const cdp: Cdp = {
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === failOn) throw new Error(`${method} failed`);
      if (method === 'Target.createBrowserContext') return { browserContextId: `ctx${++contexts}` };
      if (method === 'Target.createTarget') return { targetId: 't' };
      if (method === 'Target.attachToTarget') return { sessionId: 's' };
      return {};
    },
    once: async () => ({}),
    close() {},
  };
  return { cdp, calls };
}

test('each visit is a fresh browser profile, labelled automated, that loads the page and then leaves it', async () => {
  const { cdp, calls } = fakeChrome();
  const r = await browserVisits({ chromeUrl: 'http://chrome:9222', target: 'http://turnout-sim:8080/', visits: 3, lanes: 1, connect: async () => cdp, log: () => {} });
  assert.deepEqual(r, { done: 3, failed: 0, errors: [] });
  assert.equal(calls.filter((c) => c.method === 'Target.createBrowserContext').length, 3, 'a new profile (no cookie) per visit');
  assert.equal(calls.filter((c) => c.method === 'Target.disposeBrowserContext').length, 3);
  const ua = calls.find((c) => c.method === 'Network.setUserAgentOverride')!.params.userAgent;
  assert.equal(ua, BROWSER_VISIT_UA);
  assert.match(ua, /TurnoutBrowserVisit\/1\.0$/);
  assert.doesNotMatch(ua, /bot|crawl|spider|headless|lighthouse|preview|curl|wget/i, "the proxy's bot rule must count it");
  const urls = calls.filter((c) => c.method === 'Page.navigate').map((c) => c.params.url);
  assert.deepEqual(urls.slice(0, 2), ['http://turnout-sim:8080/', 'about:blank'], 'the page, then away: the page-speed report goes out');
});

test('a failing visit is counted and the profile still cleaned up', async () => {
  const { cdp, calls } = fakeChrome('Page.navigate');
  const r = await browserVisits({ chromeUrl: 'x', target: 'http://t/', visits: 2, lanes: 1, connect: async () => cdp, log: () => {} });
  assert.equal(r.done, 0);
  assert.equal(r.failed, 2);
  assert.match(r.errors[0]!, /Page.navigate failed/);
  assert.equal(calls.filter((c) => c.method === 'Target.disposeBrowserContext').length, 2);
});

test('turnout new --browser-speed: the lcp_ms and cls guardrails, and a headless Chrome for turnout browsers', () => {
  const { releases } = parseReleases(['http://localhost:3001', 'http://localhost:3002']);
  const answers = { flagsmith: 'bundled', releases: ['http://localhost:3001', 'http://localhost:3002'], success: 'none', traffic: 100, browserSpeed: true } as never;
  assert.match(renderConfig(answers, releases), /^guardrails: \[server_error, lcp_ms, cls\]/m);
  const withGoal = { flagsmith: 'bundled', releases: ['http://localhost:3001', 'http://localhost:3002'], success: 'POST /signup', traffic: 100, browserSpeed: true } as never;
  assert.match(renderConfig(withGoal, releases), /^guardrails: \[doc_latency_ms, server_error, lcp_ms, cls\]/m);
  assert.match(renderConfig({ ...(withGoal as object), browserSpeed: false } as never, releases), /^guardrails: \[doc_latency_ms, server_error\]/m);
  const compose = renderCompose(answers, releases);
  assert.match(compose, /\n  chrome:\n    image: chromedp\/headless-shell:stable\n    profiles: \[sim\]/);
  assert.doesNotMatch(compose.split('\n  chrome:')[1]!.split('\n\n')[0]!, /ports:/, 'its DevTools port is never published');
});
