// Simulated visitors stay in their own Flagsmith environment: Try it finds or creates
// "Try it (simulated visitors)" in the same project as the main environment, with its own server-side key, so its
// identities, events and experiments never mix with the main environment's.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AdminClient } from './admin.ts';

export const SIM_ENVIRONMENT = 'Try it (simulated visitors)';
const KEY_NAME = 'Turnout Try it';

type Env = { api_key: string; name: string; project: number };

export async function simEnvironment(api: AdminClient, mainEnvKey: string, keyFile: string): Promise<{ envKey: string; serverKey: string; created: boolean }> {
  const main = await api.get<Env>(`/api/v1/environments/${mainEnvKey}/`);
  const all = await api.list<Env>(`/api/v1/environments/?project=${main.project}`);
  let env = all.find((e) => e.name === SIM_ENVIRONMENT);
  const created = !env;
  env ??= await api.post<Env>('/api/v1/environments/', { name: SIM_ENVIRONMENT, project: main.project });
  // The server key is shown once, when made: kept in Try it's state folder, made again when it's lost.
  let saved: { envKey?: string; serverKey?: string } = {};
  try {
    saved = JSON.parse(readFileSync(keyFile, 'utf8'));
  } catch {}
  if (saved.envKey === env.api_key && saved.serverKey) return { envKey: env.api_key, serverKey: saved.serverKey, created };
  // A lost key file (a fresh container) used to leave the old key behind on every start: remove Try it's old keys
  // first, so there is only ever one.
  try {
    for (const old of await api.list<{ id: number; name: string }>(`/api/v1/environments/${env.api_key}/api-keys/`)) {
      if (old.name === KEY_NAME) await api.request('DELETE', `/api/v1/environments/${env.api_key}/api-keys/${old.id}/`).catch(() => {});
    }
  } catch {}
  const key = await api.post<{ key: string }>(`/api/v1/environments/${env.api_key}/api-keys/`, { name: KEY_NAME });
  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, JSON.stringify({ envKey: env.api_key, serverKey: key.key }), { mode: 0o600 });
  return { envKey: env.api_key, serverKey: key.key, created };
}
