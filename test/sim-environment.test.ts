import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simEnvironment, SIM_ENVIRONMENT } from '../src/flagsmith/sim-environment.ts';
import { compareSnapshots, remoteSnapshot } from '../src/flagsmith/settings-check.ts';

test('simulated visitors get their own environment, made once, its key kept', async () => {
  const envs = [{ api_key: 'main', name: 'Production', project: 7 }];
  const calls: string[] = [];
  let keys = 0;
  const api = {
    get: async () => envs[0],
    list: async () => envs,
    post: async (path: string, body: { name: string; project: number }) => {
      calls.push(path);
      if (path === '/api/v1/environments/') {
        const e = { api_key: 'sim', name: body.name, project: body.project };
        envs.push(e);
        return e;
      }
      return { key: `ser.${++keys}` };
    },
  };
  const file = join(mkdtempSync(join(tmpdir(), 'tn-sim-')), 'sim.json');
  const first = await simEnvironment(api as never, 'main', file);
  assert.deepEqual(first, { envKey: 'sim', serverKey: 'ser.1', created: true });
  assert.equal(envs[1]!.name, SIM_ENVIRONMENT);
  const again = await simEnvironment(api as never, 'main', file);
  assert.deepEqual(again, { envKey: 'sim', serverKey: 'ser.1', created: false });
  assert.equal(calls.length, 2); // one environment, one key
});

test('a lost key file replaces Try it’s old key instead of adding another', async () => {
  const keys = [{ id: 1, name: 'Turnout Try it' }, { id: 2, name: 'Something else' }];
  const deleted: string[] = [];
  const api = {
    get: async () => ({ api_key: 'main', name: 'Production', project: 7 }),
    list: async (path: string) => (path.includes('api-keys') ? keys : [{ api_key: 'main', name: 'Production', project: 7 }, { api_key: 'sim', name: SIM_ENVIRONMENT, project: 7 }]),
    post: async () => ({ key: 'ser.new' }),
    request: async (method: string, path: string) => void deleted.push(`${method} ${path}`),
  };
  const file = join(mkdtempSync(join(tmpdir(), 'tn-sim-')), 'sim.json');
  assert.equal((await simEnvironment(api as never, 'main', file)).serverKey, 'ser.new');
  assert.deepEqual(deleted, ['DELETE /api/v1/environments/sim/api-keys/1/']);
});

test('the settings check names every difference', () => {
  const doc = (enabled: boolean, b: number) => ({ feature_states: [{ feature: { name: 'f' }, enabled, feature_state_value: 'try:a', multivariate_feature_state_values: [{ multivariate_feature_option: { value: 'try:b' }, percentage_allocation: b }] }] });
  assert.deepEqual(compareSnapshots(remoteSnapshot(doc(true, 50), 'f'), remoteSnapshot(doc(true, 50), 'f')), []);
  assert.deepEqual(compareSnapshots(remoteSnapshot(doc(true, 0), 'f'), remoteSnapshot(doc(false, 50), 'f')), ['the proxy has the flag on, Flagsmith has it off', 'try:b: the proxy sends 0%, Flagsmith 50%']);
  assert.deepEqual(compareSnapshots(null, remoteSnapshot(doc(true, 50), 'f')), ["the proxy has no copy of the flag yet (it hasn't read Flagsmith's settings)"]);
});
