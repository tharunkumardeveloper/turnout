// Settings check (docs/PLAN.md step 6): the proxy routes on its own copy of Flagsmith's environment document. This
// compares that copy's flag (on or off, its value, its split) with what Flagsmith serves now, so a stale copy is seen.

export type FlagSnapshot = { enabled: boolean; value: string | null; split: Record<string, number> } | null;

type LocalFeatureState = {
  feature: { name: string };
  enabled: boolean;
  getValue(): unknown;
  multivariateFeatureStateValues?: { multivariateFeatureOption: { value: unknown }; percentageAllocation: number }[];
};

/** The flag as the SDK's local copy holds it (the SDK keeps it private: read without its types). */
export function localSnapshot(sdk: unknown, flag: string): FlagSnapshot {
  const env = (sdk as { environment?: { featureStates?: LocalFeatureState[] } }).environment;
  const fs = env?.featureStates?.find((f) => f.feature.name === flag);
  if (!fs) return null;
  return {
    enabled: fs.enabled,
    value: fs.getValue() == null ? null : String(fs.getValue()),
    split: Object.fromEntries((fs.multivariateFeatureStateValues ?? []).map((m) => [String(m.multivariateFeatureOption.value), m.percentageAllocation])),
  };
}

type RemoteFeatureState = {
  feature: { name: string };
  enabled: boolean;
  feature_state_value: unknown;
  feature_segment?: unknown;
  multivariate_feature_state_values?: { multivariate_feature_option: { value: unknown }; percentage_allocation: number }[];
};

/** The flag as Flagsmith serves it now: its environment document, read with the server key. */
export function remoteSnapshot(doc: { feature_states?: RemoteFeatureState[] }, flag: string): FlagSnapshot {
  const fs = doc.feature_states?.find((f) => f.feature.name === flag && !f.feature_segment);
  if (!fs) return null;
  return {
    enabled: fs.enabled,
    value: fs.feature_state_value == null ? null : String(fs.feature_state_value),
    split: Object.fromEntries((fs.multivariate_feature_state_values ?? []).map((m) => [String(m.multivariate_feature_option.value), m.percentage_allocation])),
  };
}

export async function fetchRemoteSnapshot(apiUrl: string, serverKey: string, flag: string, fetchImpl: typeof fetch = fetch): Promise<FlagSnapshot> {
  const base = apiUrl.replace(/\/$/, '').replace(/\/api\/v1$/, '');
  const res = await fetchImpl(`${base}/api/v1/environment-document/`, { headers: { 'X-Environment-Key': serverKey }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Flagsmith's environment document: HTTP ${res.status}`);
  return remoteSnapshot((await res.json()) as { feature_states?: RemoteFeatureState[] }, flag);
}

/** The differences, in plain words; none means the proxy routes on Flagsmith's current settings. */
export function compareSnapshots(local: FlagSnapshot, remote: FlagSnapshot): string[] {
  if (!local && !remote) return [];
  if (!local) return ["the proxy has no copy of the flag yet (it hasn't read Flagsmith's settings)"];
  if (!remote) return ['Flagsmith no longer has the flag'];
  const out: string[] = [];
  if (local.enabled !== remote.enabled) out.push(`the proxy has the flag ${local.enabled ? 'on' : 'off'}, Flagsmith has it ${remote.enabled ? 'on' : 'off'}`);
  if (local.value !== remote.value) out.push(`the proxy's default is ${local.value}, Flagsmith's is ${remote.value}`);
  for (const k of new Set([...Object.keys(local.split), ...Object.keys(remote.split)])) {
    const a = local.split[k] ?? 0;
    const b = remote.split[k] ?? 0;
    if (Math.abs(a - b) > 0.01) out.push(`${k}: the proxy sends ${a}%, Flagsmith ${b}%`);
  }
  return out;
}
