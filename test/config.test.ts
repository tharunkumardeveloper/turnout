import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, matchesRule, parseConfig } from '../src/config.ts';

const valid = {
  flag: 'shop_release',
  releases: { 'shop:1.4': 'http://shop-1-4:8080', 'shop:1.5': 'http://shop-1-5:8080' },
  goal: { event: 'order_placed', when: { method: 'post', path: '/checkout', status: '2xx' } },
  guardrails: ['doc_latency_ms', 'server_error'],
};

test('parses the demo config', () => {
  const config = parseConfig(valid);
  assert.equal(config.flag, 'shop_release');
  assert.equal(config.releases.get('shop:1.5')?.host, 'shop-1-5:8080');
  assert.equal(config.fallback, 'shop:1.4');
  assert.equal(config.goal.when.method, 'POST');
});

test('requires at least one release', () => {
  assert.throws(() => parseConfig({ ...valid, releases: {} }), ConfigError);
});

test('rejects non-http upstreams and unknown guardrails', () => {
  assert.throws(() => parseConfig({ ...valid, releases: { 'shop:1.4': 'file:///etc/passwd' } }), ConfigError);
  assert.throws(() => parseConfig({ ...valid, guardrails: ['cpu'] }), ConfigError);
});

test('matches goal rules by method, path and status class', () => {
  const rule = parseConfig(valid).goal.when;
  assert.equal(matchesRule(rule, 'POST', '/checkout', 201), true);
  assert.equal(matchesRule(rule, 'POST', '/checkout?x=1', 200), true);
  assert.equal(matchesRule(rule, 'GET', '/checkout', 200), false);
  assert.equal(matchesRule(rule, 'POST', '/checkout', 500), false);
  assert.equal(matchesRule(rule, 'POST', '/checkout/extra', 200), false);
});

test('supports wildcard paths and exact status codes', () => {
  const rule = { method: 'GET', path: '/fix/*', status: '200' };
  assert.equal(matchesRule(rule, 'GET', '/fix/srm', 200), true);
  assert.equal(matchesRule(rule, 'GET', '/fix/srm', 204), false);
  assert.equal(matchesRule(rule, 'GET', '/fixes', 200), false);
});
