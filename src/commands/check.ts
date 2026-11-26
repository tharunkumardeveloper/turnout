// switchyard check: read-only. Finds experiment splits left behind on flags whose experiment has stopped, using
// only the environment document (the server-side key your app already has). With an Organisation API key as well, it
// reads each stopped experiment's status, so a created or paused experiment is not reported as left behind, and it
// names the segments an experiment's audience is limited to.
import { AdminClient } from '../flagsmith/admin.ts';

type DocCondition = { operator: string; value?: string | null; property_?: string | null };
type DocRule = { type?: string; conditions?: DocCondition[]; rules?: DocRule[] };
type DocFeatureState = {
  feature: { name: string };
  enabled: boolean;
  // Flagsmith attaches this to the flag's segment overrides while an experiment on the flag runs; `id` is the running
  // experiment's, `in_experiment` whether this override is its rollout (api/experimentation/feature_state_metadata.py).
  metadata?: { experiment?: { id?: number; in_experiment?: boolean } | null } | null;
  multivariate_feature_state_values?: { multivariate_feature_option: { key?: string | null }; percentage_allocation: number }[];
};
type DocSegment = {
  id: number;
  name: string;
  rules?: DocRule[];
  feature_states?: DocFeatureState[];
};
export type EnvironmentDocument = { api_key?: string; project: { segments: DocSegment[] } }; // api_key: the environment's key

// The segments an experiment's rollout is limited to. Flagsmith builds the rollout segment as
// [ALL{PERCENTAGE_SPLIT}, *audience rules], the audience being one ANY or ALL rule with a copy of each audience
// segment's rules (api/experimentation/services.py, _compile_audience_rules and _rollout_segment_rules).
export type Audience = {
  match: 'any' | 'all';
  segments: number;
  names?: string[]; // from the Admin API, when check has an Organisation API key
  traits: string[]; // trait names the audience's conditions read, except IS_NOT_SET ones (a missing trait fails those)
  // trait names read by IS_NOT_SET conditions: a missing trait matches them (flag_engine segments/evaluator.py:518-519)
  unsetTraits?: string[];
};

export type Finding = {
  experimentId: number;
  flag: string;
  // leftover: the experiment isn't running but its split is still there. created/paused: known from the Admin API.
  status: 'running' | 'leftover' | 'drained' | 'created' | 'paused';
  experimentStatus?: string; // as the Admin API reports it, when read
  coveragePercent: number;
  audience: Audience | null;
  variants: { key: string; weight: number }[];
};

const ROLLOUT = /^experiment-(\d+)-rollout$/;
const IDENTITY_KEY = '$.identity.key';
const isSplit = (c: DocCondition) => c.operator === 'PERCENTAGE_SPLIT' && (c.property_ ?? IDENTITY_KEY) === IDENTITY_KEY;

function conditionsOf(rules: DocRule[]): DocCondition[] {
  return rules.flatMap((r) => [...(r.conditions ?? []), ...conditionsOf(r.rules ?? [])]);
}

function audienceOf(rules: DocRule[]): Audience | null {
  if (!rules.length) return null;
  const named = conditionsOf(rules).filter((c): c is DocCondition & { property_: string } => !!c.property_ && !c.property_.startsWith('$.'));
  const traits = [...new Set(named.filter((c) => c.operator !== 'IS_NOT_SET').map((c) => c.property_))];
  const unset = [...new Set(named.filter((c) => c.operator === 'IS_NOT_SET').map((c) => c.property_))];
  const extra = unset.length ? { unsetTraits: unset } : {};
  const [only] = rules;
  // Flagsmith's own shape: one wrapper rule, no conditions of its own, a rule per audience segment.
  if (rules.length === 1 && only && !only.conditions?.length && only.rules?.length) {
    return { match: only.type === 'ALL' ? 'all' : 'any', segments: only.rules.length, traits, ...extra };
  }
  return { match: 'all', segments: rules.length, traits, ...extra }; // a segment's top-level rules all have to match
}

export function analyze(doc: EnvironmentDocument): Finding[] {
  const findings: Finding[] = [];
  for (const segment of doc.project.segments) {
    const match = ROLLOUT.exec(segment.name);
    if (!match) continue;
    const experimentId = Number(match[1]);
    const rules = segment.rules ?? [];
    const splitRule = rules.find((r) => (r.conditions ?? []).some(isSplit));
    const split = splitRule?.conditions?.find(isSplit);
    const coveragePercent = split ? Number(split.value ?? 0) : 100;
    const audience = audienceOf(rules.filter((r) => r !== splitRule));
    for (const fs of segment.feature_states ?? []) {
      // Running means: the experiment running on this flag is this segment's experiment. While a newer experiment
      // runs, an older rollout's override carries the newer one's id.
      const meta = fs.metadata?.experiment;
      const running = !!meta && meta.id === experimentId && meta.in_experiment !== false;
      findings.push({
        experimentId,
        flag: fs.feature.name,
        status: running ? 'running' : coveragePercent > 0 ? 'leftover' : 'drained',
        coveragePercent,
        audience,
        variants: (fs.multivariate_feature_state_values ?? []).map((v) => ({
          key: v.multivariate_feature_option.key ?? '(unkeyed)',
          weight: v.percentage_allocation,
        })),
      });
    }
  }
  return findings.sort((a, b) => a.experimentId - b.experimentId);
}

// "50% of identities", or "50% of identities matching any of "beta", "eu"" when an audience limits the split.
export function coverage(f: Pick<Finding, 'coveragePercent' | 'audience'>, who = 'identities'): string {
  const base = `${f.coveragePercent}% of ${who}`;
  const a = f.audience;
  if (!a) return base;
  if (a.names?.length) {
    const quoted = a.names.map((n) => `"${n}"`);
    return `${base} matching ${quoted.length === 1 ? `segment ${quoted[0]}` : `${a.match} of ${quoted.join(', ')}`}`;
  }
  return `${base} matching ${a.segments === 1 ? 'its audience segment' : `${a.match} of its ${a.segments} audience segments`}`;
}

export function describe(findings: Finding[]): string[] {
  if (findings.length === 0) return ['No experiment rollouts in this environment.'];
  const lines: string[] = [];
  for (const f of findings) {
    const split = f.variants.length ? f.variants.map((v) => `${v.key} ${v.weight}%`).join(', ') : 'control only';
    const covers = `${coverage(f)} (${split})`;
    if (f.status === 'leftover') {
      if (f.experimentStatus) {
        lines.push(
          `✗ ${f.flag}: experiment ${f.experimentId} is ${f.experimentStatus}, but its split still covers ${covers}.`,
          `  Edits to the flag's default don't reach them. Start a new experiment on the flag to clear it; next time, Ship with \`switchyard ship\` (it drains the split) before completing.`,
        );
      } else {
        lines.push(
          `✗ ${f.flag}: experiment ${f.experimentId} is not running (created, paused or completed), but its split still covers ${covers}.`,
          `  Edits to the flag's default don't reach them. If it is completed, start a new experiment on the flag to clear it; if it is created or paused, start or finish it.`,
          `  With an Organisation API key (--admin-key or SWITCHYARD_ADMIN_KEY), check reads which one it is.`,
        );
      }
    } else if (f.status === 'created') {
      lines.push(
        `! ${f.flag}: experiment ${f.experimentId} is created but not started; its rollout already covers ${covers}.`,
        `  Start it in Flagsmith, or delete it if it isn't wanted.`,
      );
    } else if (f.status === 'paused') {
      lines.push(
        `! ${f.flag}: experiment ${f.experimentId} is paused; its split still covers ${covers}.`,
        `  Resume it, or finish it with \`switchyard ship\` or \`switchyard revert\` (both drain the split).`,
      );
    } else if (f.status === 'running') {
      lines.push(`· ${f.flag}: experiment ${f.experimentId} is running on ${covers}.`);
    } else {
      lines.push(`✓ ${f.flag}: experiment ${f.experimentId}'s split is drained (0%).`);
    }
  }
  return lines;
}

// The environment document, read with a server-side key (also used by switchyard doctor).
export async function fetchEnvironmentDocument(apiUrl: string, serverKey: string): Promise<EnvironmentDocument> {
  const base = apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`; // like the SDK, accept …/api/v1 too
  const url = new URL('environment-document/', base);
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'X-Environment-Key': serverKey }, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new Error(`Couldn't reach Flagsmith at ${url.origin}: ${reason(error)}. Is --api-url (FLAGSMITH_API_URL) right?`);
  }
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error(`Couldn't read the environment document (${res.status}). check needs a server-side key (ser.…).`), { status: res.status });
  }
  if (!res.ok) throw Object.assign(new Error(`Couldn't read the environment document at ${res.url} (${res.status}). Is --api-url Flagsmith's …/api/v1/?`), { status: res.status });
  return (await res.json()) as EnvironmentDocument;
}

function reason(error: unknown): string {
  const e = error as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e.name === 'TimeoutError') return 'no answer in 15 s';
  return e.cause?.code ?? e.cause?.message ?? e.message ?? String(error);
}

type RolloutDetail = { status: string; experiment_rollout?: { audience?: { match?: string; segments?: { name: string }[] } } | null };

// With an Organisation API key: each experiment's status and its audience's segment names. Returns notes to print.
async function readExperiments(findings: Finding[], api: AdminClient, envKey: string): Promise<string[]> {
  const ids = [...new Set(findings.filter((f) => f.status === 'leftover' || f.audience).map((f) => f.experimentId))];
  for (const id of ids) {
    let detail: RolloutDetail;
    try {
      detail = await api.get<RolloutDetail>(`/api/v1/environments/${encodeURIComponent(envKey)}/experiments/${id}/`);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 401 || status === 403) return [`(The Organisation API key was refused (HTTP ${status}): experiment statuses not read.)`];
      if (status === 404) {
        for (const f of findings) if (f.experimentId === id && f.status === 'leftover') f.experimentStatus = 'deleted';
        continue;
      }
      return [`(Couldn't read experiment ${id} with the Organisation API key: ${reason(error)}.)`];
    }
    const audience = detail.experiment_rollout?.audience;
    for (const f of findings) {
      if (f.experimentId !== id) continue;
      if (f.audience && audience?.segments?.length) {
        f.audience.names = audience.segments.map((s) => s.name);
        if (audience.match === 'all' || audience.match === 'any') f.audience.match = audience.match;
      }
      if (f.status !== 'leftover') continue;
      if (detail.status === 'created' || detail.status === 'paused') f.status = detail.status;
      else if (detail.status === 'running') f.status = 'running'; // the environment document is rebuilt a moment later
      else f.experimentStatus = detail.status;
    }
  }
  return [];
}

// Returns the number of splits left behind (created and paused experiments are not counted).
export async function check(opts: { apiUrl: string; serverKey: string; adminKey?: string | undefined; log?: (line: string) => void }): Promise<number> {
  const log = opts.log ?? console.log;
  const doc = await fetchEnvironmentDocument(opts.apiUrl, opts.serverKey);
  const findings = analyze(doc);
  const notes = opts.adminKey && doc.api_key ? await readExperiments(findings, new AdminClient(opts.apiUrl, { apiKey: opts.adminKey }), doc.api_key) : [];
  for (const line of [...describe(findings), ...notes]) log(line);
  return findings.filter((f) => f.status === 'leftover').length;
}
