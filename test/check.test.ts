import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, coverage, describe, type EnvironmentDocument } from '../src/commands/check.ts';

// Trimmed from a real environment document (Flagsmith 2.291.0, after spikes/07-round04.ts).
const split = (value: string) => [{ type: 'ALL', rules: [], conditions: [{ operator: 'PERCENTAGE_SPLIT', value, property_: '$.identity.key' }] }];
const mv = (key: string, percentage_allocation: number) => [{ multivariate_feature_option: { key }, percentage_allocation }];
const doc: EnvironmentDocument = {
  project: {
    segments: [
      { id: 1, name: 'experiment-1-rollout', rules: split('100.0'), feature_states: [{ feature: { name: 'shop_release' }, enabled: true, metadata: { experiment: { id: 1, in_experiment: true } }, multivariate_feature_state_values: mv('v2', 50) }] },
      { id: 2, name: 'experiment-2-rollout', rules: split('100.0'), feature_states: [{ feature: { name: 'checkout_button' }, enabled: true, multivariate_feature_state_values: mv('v2', 50) }] },
      { id: 3, name: 'experiment-3-rollout', rules: split('0.0'), feature_states: [{ feature: { name: 'pricing_page' }, enabled: true, multivariate_feature_state_values: mv('v2', 100) }] },
      { id: 4, name: 'beta testers', rules: split('10.0'), feature_states: [{ feature: { name: 'new_nav' }, enabled: true }] },
    ],
  },
};

test('classifies running, leftover and drained experiment splits, and ignores ordinary segments', () => {
  assert.deepEqual(
    analyze(doc).map((f) => [f.flag, f.status, f.coveragePercent]),
    [
      ['shop_release', 'running', 100],
      ['checkout_button', 'leftover', 100],
      ['pricing_page', 'drained', 0],
    ],
  );
});

test('explains the leftover split and how to fix it, without claiming the experiment is completed', () => {
  const lines = describe(analyze(doc));
  const line = lines.find((l) => l.startsWith('✗ checkout_button: experiment 2 is not running (created, paused or completed)'));
  assert.ok(line && line.includes('100% of identities') && line.includes('v2 50%'), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('--admin-key')), 'says how to tell created, paused and completed apart');
  assert.ok(lines.some((l) => l.startsWith('✓ pricing_page')));
  assert.deepEqual(describe([]), ['No experiment rollouts in this environment.']);
});

// The rollout segment Flagsmith builds for an experiment with an audience: [ALL{PERCENTAGE_SPLIT}, ANY|ALL{a rule per
// audience segment}] (api/experimentation/services.py, _compile_audience_rules and _rollout_segment_rules).
const withAudience = (match: 'ANY' | 'ALL', segmentRules: unknown[]) => [
  ...split('50.0'),
  { type: match, conditions: [], rules: segmentRules },
];
const beta = { type: 'ALL', conditions: [], rules: [{ type: 'ANY', rules: [], conditions: [{ operator: 'EQUAL', property_: 'plan', value: 'beta' }] }] };
const eu = { type: 'ALL', conditions: [], rules: [{ type: 'ANY', rules: [], conditions: [{ operator: 'IN', property_: 'country', value: 'DE,FR' }] }] };
const audienceDoc = (rules: unknown[]): EnvironmentDocument => ({
  project: { segments: [{ id: 7, name: 'experiment-7-rollout', rules: rules as never, feature_states: [{ feature: { name: 'checkout' }, enabled: true, multivariate_feature_state_values: mv('v2', 50) }] }] },
});

test('a split limited to an audience says so, instead of claiming it covers that share of every identity', () => {
  const [any] = analyze(audienceDoc(withAudience('ANY', [beta, eu])));
  assert.equal(any!.coveragePercent, 50);
  assert.deepEqual(any!.audience, { match: 'any', segments: 2, traits: ['plan', 'country'] });
  assert.equal(coverage(any!), '50% of identities matching any of its 2 audience segments');

  const notSet = { type: 'ALL', conditions: [], rules: [{ type: 'ANY', rules: [], conditions: [{ operator: 'IS_NOT_SET', property_: 'company', value: null }] }] };
  const [unset] = analyze(audienceDoc(withAudience('ANY', [notSet])));
  assert.deepEqual(unset!.audience, { match: 'any', segments: 1, traits: [], unsetTraits: ['company'] }, 'IS_NOT_SET kept apart: a missing trait matches it');

  const [all] = analyze(audienceDoc(withAudience('ALL', [beta, eu])));
  assert.equal(all!.audience!.match, 'all');

  const [one] = analyze(audienceDoc(withAudience('ANY', [beta])));
  assert.equal(coverage(one!), '50% of identities matching its audience segment');
  assert.match(describe([one!])[0]!, /covers 50% of identities matching its audience segment \(v2 50%\)\.$/);

  // With names from the Admin API.
  assert.equal(coverage({ ...any!, audience: { ...any!.audience!, names: ['Beta', 'EU'] } }, 'visitors'), '50% of visitors matching any of "Beta", "EU"');
  assert.equal(coverage({ ...one!, audience: { ...one!.audience!, names: ['Beta'] } }), '50% of identities matching segment "Beta"');

  // No audience: the plain coverage.
  assert.equal(analyze(doc)[0]!.audience, null);
  assert.equal(coverage(analyze(doc)[0]!), '100% of identities');
});
