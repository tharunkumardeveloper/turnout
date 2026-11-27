// Pin a browser to one version: a Flagsmith identity override on the release flag for that browser's visitor id
// (its tn_id cookie, which is its identity in Flagsmith). Flagsmith evaluates an identity override before segment
// overrides, so before the experiment's split: the pinned browser gets that version on its next page load and is
// outside the experiment (its flag carries no experiment, so the proxy records no exposure for it). Local evaluation
// sees it because the environment document embeds identity overrides when the environment's "Use identity overrides
// in local evaluation" setting is on (the default for new environments; init turns it on). Verified on 2.291.0: the
// proxy routed a pinned identity to the override within its 5-second refresh, with enrolled=false.
//   POST /api/v1/environments/<env>/identities/                         { identifier }  → { id }
//   GET  /api/v1/environments/<env>/identities/?q=<identifier>
//   GET  /api/v1/environments/<env>/identities/<id>/featurestates/
//   POST /api/v1/environments/<env>/identities/<id>/featurestates/      { feature, enabled, feature_state_value }
//   DELETE /api/v1/environments/<env>/identities/<id>/featurestates/<fs>/
import type { AdminClient } from './admin.ts';

type Api = Pick<AdminClient, 'get' | 'post' | 'list' | 'request'>;
type IdentityRow = { id: number; identifier: string };
type OverrideRow = { id: number; feature: number | { id: number }; feature_state_value: unknown };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Only a Turnout visitor id (a UUID) can be pinned: nothing else is ever an identity here. */
export const pinnable = (identifier: string | undefined): identifier is string => !!identifier && UUID.test(identifier);

const base = (envKey: string) => `/api/v1/environments/${encodeURIComponent(envKey)}/identities/`;
const featureOf = (o: OverrideRow) => (typeof o.feature === 'number' ? o.feature : o.feature.id);

async function findIdentity(api: Api, envKey: string, identifier: string): Promise<IdentityRow | null> {
  const rows = await api.list<IdentityRow>(`${base(envKey)}?q=${encodeURIComponent(identifier)}`);
  return rows.find((r) => r.identifier === identifier) ?? null;
}

async function overridesOf(api: Api, envKey: string, identityId: number, featureId: number): Promise<OverrideRow[]> {
  const rows = await api.list<OverrideRow>(`${base(envKey)}${identityId}/featurestates/`);
  return rows.filter((r) => featureOf(r) === featureId);
}

/** The version this browser is pinned to, or null. */
export async function readPin(api: Api, envKey: string, featureId: number, identifier: string): Promise<string | null> {
  const identity = await findIdentity(api, envKey, identifier);
  if (!identity) return null;
  const [row] = await overridesOf(api, envKey, identity.id, featureId);
  return row && row.feature_state_value != null ? String(row.feature_state_value) : null;
}

/** Pins this browser to `release`, or removes the pin with null. Returns the pin now in Flagsmith. */
export async function setPin(api: Api, envKey: string, featureId: number, identifier: string, release: string | null): Promise<string | null> {
  let identity = await findIdentity(api, envKey, identifier);
  if (!identity) {
    if (release === null) return null;
    identity = await api.post<IdentityRow>(base(envKey), { identifier });
  }
  for (const row of await overridesOf(api, envKey, identity.id, featureId)) {
    await api.request('DELETE', `${base(envKey)}${identity.id}/featurestates/${row.id}/`);
  }
  if (release === null) return null;
  await api.post(`${base(envKey)}${identity.id}/featurestates/`, { feature: featureId, enabled: true, feature_state_value: release });
  return release;
}
