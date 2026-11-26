// switchyard doctor: is everything there, the way init and switchyard.config.yml expect it? Read-only.
// gatherFacts() reads Flagsmith, the proxy, the console and Flagsmith's Prometheus counter; evaluate() is a pure
// function that turns those facts into checks, each with what was expected and what is actually there.
// Secrets (keys, tokens, the Feature Health webhook path) are compared, never put into a check.
import { accessSync, constants, existsSync } from 'node:fs';
import http from 'node:http';
import { dirname, resolve } from 'node:path';
import type { Config } from '../config.ts';
import { readEventCounter } from '../console/server.ts';
import { AdminClient, type Environment, type Experiment, type Feature, type Metric, type WarehouseConnection } from '../flagsmith/admin.ts';
import type { FlagState } from '../flagsmith/experiments.ts';
import type { UpstreamProbe } from '../proxy/server.ts';
import { analyze, coverage, fetchEnvironmentDocument, type EnvironmentDocument } from './check.ts';
import { RELEASE_TAG } from './init.ts';
import { PREVIEW_SEGMENT, PREVIEW_TRAIT } from './preview.ts';
import { currentRelease } from './release.ts';
import { evaluateServer, gatherServerFacts, type ServerFacts, type ServerModeOptions } from '../server-mode.ts';

// The Flagsmith image compose.flagsmith.yml pins (test/doctor.test.ts keeps the two equal).
export const PINNED_FLAGSMITH_VERSION = '2.291.0';

export type CheckStatus = 'ok' | 'warn' | 'fail';
export type DoctorCheck = { area: string; name: string; expected: string; actual: string; status: CheckStatus; fix?: string };
export type DoctorReport = { at: string; checks: DoctorCheck[]; summary: Record<CheckStatus, number> };

export type DoctorOptions = {
  apiUrl: string;
  config: Config;
  adminKey?: string | undefined;
  serverKey?: string | undefined;
  experimentRef?: string | undefined; // SWITCHYARD_EXPERIMENT: <environment key>/<id>
  previewToken?: string | undefined; // also the proxy's debug token: it unlocks the release-container probe
  healthWebhook?: string | undefined; // SWITCHYARD_HEALTH_WEBHOOK
  proxyUrl: string;
  consoleUrl?: string | undefined; // unset: the console itself is asking
  metricsUrl?: string | undefined; // Flagsmith's Prometheus endpoint
  // Run on the host (Flagsmith on localhost), not inside Compose. Flagsmith's metrics server listens on 9100
  // (flagsmith_common: common/gunicorn/metrics_server.py:21), which Compose doesn't publish, so the counter is skipped.
  fromHost?: boolean | undefined;
  // Where Ship and Revert write snapshots and the ledger, and the .env init and release write. Unset: not checked.
  stateDir?: string | undefined;
  envFile?: string | undefined;
  // Server mode only (SWITCHYARD_MODE=server): HTTPS, Secure cookies, private ports, secrets, restart policies.
  server?: ServerModeOptions | undefined;
};

// One read: its value, or why it failed.
export type Got<T> = { value: T } | { error: string; status?: number };

type VersionInfo = { image_tag?: string; experimentation_enabled?: boolean; self_hosted_data?: { has_users?: boolean } };
type Tag = { id: number; label: string; is_permanent?: boolean };
type Condition = { operator?: string; property?: string; value?: string };
type Rule = { conditions?: Condition[]; rules?: Rule[] };
type Segment = { id: number; name: string; rules?: Rule[] };
type HealthProvider = { name: string; webhook_url: string | null };
type Override = FlagState['segment_overrides'][number] & { value?: { type: string; value: string } };
export type ProxyHealth = {
  ok: boolean;
  flagsmith: { ready: boolean; environmentAgeSeconds: number | null; lastError: string | null } | null;
  liveRelease: string;
  undeliveredEvents: number;
  upstreams?: Record<string, UpstreamProbe>;
};

export type DoctorFacts = {
  apiUrl: string;
  expectedVersion: string;
  config: { flag: string; releases: { label: string; host: string }[]; goal: string; guardrails: string[] };
  given: { adminKey: boolean; serverKey: boolean; envKey: string | undefined; previewToken: boolean; healthWebhook: string | undefined };
  version: Got<VersionInfo>;
  // Undefined: not read, because something it depends on is missing (and that has its own check).
  organisations?: Got<unknown[]>;
  environment?: Got<Environment>;
  document?: Got<EnvironmentDocument>;
  warehouses?: Got<WarehouseConnection[]>;
  feature?: Got<Feature | null>;
  flag?: Got<Omit<FlagState, 'segment_overrides'> & { segment_overrides: Override[] }>;
  tags?: Got<Tag[]>;
  metrics?: Got<Metric[]>;
  experiments?: Got<Experiment[]>;
  segments?: Got<Segment[]>;
  providers?: Got<HealthProvider[]>;
  proxy: Got<ProxyHealth>;
  console: Got<number> | 'self';
  metricsUrl: string | undefined;
  events: { accepted: number; rejected: number } | null;
  fromHost?: boolean;
  writable?: { label: string; path: string; problem: string | null }[];
  server?: ServerFacts; // server mode only
};

const got = async <T>(promise: Promise<T>): Promise<Got<T>> => {
  try {
    return { value: await promise };
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    return { error: describeError(error), ...(typeof status === 'number' ? { status } : {}) };
  }
};
const isOk = <T>(g: Got<T> | undefined): g is { value: T } => !!g && 'value' in g;

function describeError(error: unknown): string {
  const e = error as { name?: string; message?: string; cause?: { code?: string } };
  if (e.name === 'TimeoutError') return 'no answer in time';
  if (e.cause?.code) return `${e.message ?? 'failed'} (${e.cause.code})`;
  return e.message ?? String(error);
}

export async function gatherFacts(o: DoctorOptions): Promise<DoctorFacts> {
  const envKey = o.experimentRef?.split('/')[0] || undefined;
  const api = new AdminClient(o.apiUrl, o.adminKey ? { apiKey: o.adminKey } : undefined);
  const facts: DoctorFacts = {
    apiUrl: o.apiUrl,
    expectedVersion: PINNED_FLAGSMITH_VERSION,
    config: {
      flag: o.config.flag,
      releases: [...o.config.releases].map(([label, url]) => ({ label, host: url.hostname })),
      goal: o.config.goal.event,
      guardrails: [...o.config.guardrails],
    },
    given: { adminKey: !!o.adminKey, serverKey: !!o.serverKey, envKey, previewToken: !!o.previewToken, healthWebhook: o.healthWebhook || undefined },
    version: { error: 'not read' },
    proxy: { error: 'not read' },
    console: 'self',
    metricsUrl: o.metricsUrl,
    events: null,
    ...(o.fromHost ? { fromHost: true } : {}),
  };
  const writable = [
    ...(o.stateDir ? [{ label: 'State folder', path: o.stateDir, problem: writeProblem(o.stateDir, 'dir') }] : []),
    ...(o.envFile ? [{ label: '.env file', path: o.envFile, problem: writeProblem(o.envFile, 'file') }] : []),
  ];
  if (writable.length) facts.writable = writable;

  const flagsmith = async () => {
    facts.version = await got(withTimeout(api.get<VersionInfo>('/version/')));
    if (!isOk(facts.version)) return;
    if (o.serverKey) facts.document = await got(fetchEnvironmentDocument(o.apiUrl, o.serverKey));
    if (!o.adminKey) return;
    facts.organisations = await got(api.list('/api/v1/organisations/'));
    if (!isOk(facts.organisations) || !envKey) return;
    facts.environment = await got(api.get<Environment>(`/api/v1/environments/${envKey}/`));
    if (!isOk(facts.environment)) return;
    const project = `/api/v1/projects/${facts.environment.value.project}`;
    const env = `/api/v1/environments/${envKey}`;
    const [warehouses, features, tags, metrics, experiments, segments, providers] = await Promise.all([
      got(api.list<WarehouseConnection>(`${env}/warehouse-connections/`)),
      got(api.list<Feature>(`${project}/features/?search=${encodeURIComponent(o.config.flag)}`)),
      got(api.list<Tag>(`${project}/tags/`)),
      got(api.list<Metric>(`${env}/experiment-metrics/`)),
      got(api.list<Experiment>(`${env}/experiments/`)),
      got(api.list<Segment>(`${project}/segments/`)),
      got(api.list<HealthProvider>(`${project}/feature-health/providers/`)),
    ]);
    Object.assign(facts, { warehouses, tags, metrics, experiments, segments, providers });
    facts.feature = isOk(features) ? { value: features.value.find((f) => f.name === o.config.flag) ?? null } : features;
    if (isOk(facts.feature) && facts.feature.value) {
      facts.flag = await got(api.get(`/api/__future__/environments/${envKey}/features/${facts.feature.value.id}/`));
    }
  };

  const proxy = async () => {
    const res = await fetch(new URL('/__switchyard/health', o.proxyUrl), {
      headers: o.previewToken ? { 'x-switchyard-debug': o.previewToken } : {},
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return (await res.json()) as ProxyHealth;
  };

  const [, proxyHealth, consoleStatus, events, server] = await Promise.all([
    flagsmith(),
    got(proxy()),
    o.consoleUrl ? got(httpStatus(o.consoleUrl)) : Promise.resolve('self' as const),
    readEventCounter(o.metricsUrl),
    o.server ? gatherServerFacts(o.server) : Promise.resolve(undefined),
  ]);
  if (server) facts.server = server;
  facts.proxy = proxyHealth;
  facts.console = consoleStatus;
  facts.events = events;
  return facts;
}

/**
 * Why this process couldn't write `path`, or null. A missing folder or file counts as writable when the nearest
 * folder that exists is (it is created on first use). For a folder, its snapshots/ subfolder is checked too.
 * On Linux, Compose runs the console and cli as SWITCHYARD_UID:SWITCHYARD_GID; a bind-mounted .switchyard/ owned by
 * someone else makes Ship and Revert stop after pausing the experiment (EACCES on the snapshot).
 * Only access(2) is used, so doctor stays read-only.
 */
export function writeProblem(path: string, kind: 'dir' | 'file'): string | null {
  const targets = kind === 'dir' ? [path, resolve(path, 'snapshots')] : [path];
  for (const target of targets) {
    let at = resolve(target);
    while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
    try {
      accessSync(at, constants.W_OK);
    } catch (error) {
      return `${(error as { code?: string }).code ?? 'not writable'}: ${at} is not writable by this process`;
    }
  }
  return null;
}

function withTimeout<T>(promise: Promise<T>, ms = 8000): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(Object.assign(new Error('no answer in time'), { name: 'TimeoutError' })), ms).unref())]);
}

// The console answers only localhost Host headers (no DNS rebinding), so ask as localhost: any answer means it's up.
function httpStatus(url: string): Promise<number> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.get(u, { headers: { host: `localhost:${u.port || 80}` }, timeout: 4000 }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('no answer in time'), { name: 'TimeoutError' })));
    req.on('error', reject);
  });
}

const n = (x: number) => x.toLocaleString('en-US');
const INIT = 'Run init: docker compose run --rm cli init (safe to repeat)';

// Pure: the same facts always give the same checks.
export function evaluate(f: DoctorFacts): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const add = (area: string, name: string, status: CheckStatus, expected: string, actual: string, fix?: string) =>
    checks.push({ area, name, expected, actual, status, ...(fix && status !== 'ok' ? { fix } : {}) });
  const releases = f.config.releases.map((r) => r.label);
  const allowed = (label: string | null | undefined) => !!label && releases.includes(label);

  // ---- Flagsmith ----------------------------------------------------------------------------------------------
  let A = 'Flagsmith';
  if (!isOk(f.version)) {
    add(A, 'API', 'fail', `answers at ${f.apiUrl}`, f.version.error,
      'Start it: docker compose up -d --wait flagsmith (logs: docker compose logs flagsmith). Outside Docker, pass --api-url http://localhost:8000/api/v1/');
  } else {
    const v = f.version.value;
    add(A, 'API', 'ok', `answers at ${f.apiUrl}`, 'answers');
    add(A, 'Version', v.image_tag === f.expectedVersion ? 'ok' : 'warn', f.expectedVersion, v.image_tag ?? 'not reported',
      `Switchyard is tested on ${f.expectedVersion}: keep that tag in compose.flagsmith.yml`);
    if (v.experimentation_enabled !== undefined) {
      add(A, 'Experimentation', v.experimentation_enabled ? 'ok' : 'fail', 'enabled', v.experimentation_enabled ? 'enabled' : 'disabled',
        `Use the image compose.flagsmith.yml pins (${f.expectedVersion})`);
    }
    const hasUsers = v.self_hosted_data?.has_users;
    if (hasUsers !== undefined) add(A, 'Admin user', hasUsers ? 'ok' : 'fail', 'created', hasUsers ? 'created' : 'none yet (a fresh instance)', INIT);
  }
  if (f.warehouses) {
    if (!isOk(f.warehouses)) add(A, 'Event store', 'fail', 'connected', f.warehouses.error);
    else {
      const wh = f.warehouses.value[0];
      add(A, 'Event store', !wh ? 'fail' : wh.status === 'connected' ? 'ok' : 'warn', 'connected (Flagsmith database)', wh ? wh.status : 'not connected: the events endpoint answers 404',
        wh ? "Check the environment's warehouse connection in Flagsmith" : INIT);
    }
  }

  // ---- Keys ---------------------------------------------------------------------------------------------------
  A = 'Keys';
  if (!f.given.adminKey) add(A, 'Admin key', 'fail', 'SWITCHYARD_ADMIN_KEY set', 'not set', `${INIT}, or put an Organisation API key in .env`);
  else if (f.organisations) {
    add(A, 'Admin key', isOk(f.organisations) ? 'ok' : 'fail', 'accepted by Flagsmith', isOk(f.organisations) ? 'accepted' : refused(f.organisations),
      'The key is from another instance (after a reset?) or was revoked: create an Organisation API key in Flagsmith and put it in .env as SWITCHYARD_ADMIN_KEY');
  }
  if (!f.given.envKey) add(A, 'Environment', 'fail', 'SWITCHYARD_EXPERIMENT set (<environment key>/<id>)', 'not set', INIT);
  else if (f.environment) {
    add(A, 'Environment', isOk(f.environment) ? 'ok' : 'fail', 'exists', isOk(f.environment) ? `"${f.environment.value.name}" (project ${f.environment.value.project})` : refused(f.environment),
      `SWITCHYARD_EXPERIMENT names an environment this Flagsmith doesn't have. ${INIT}`);
  }
  if (!f.given.serverKey) add(A, 'Server key', 'fail', 'SWITCHYARD_SERVER_KEY set', 'not set', INIT);
  else if (f.document) {
    if (!isOk(f.document)) {
      add(A, 'Server key', 'fail', 'reads the environment document', refused(f.document),
        'The key is from another instance or was revoked. Clear SWITCHYARD_SERVER_KEY in .env and run init to create one');
    } else {
      const same = !f.given.envKey || f.document.value.api_key === undefined || f.document.value.api_key === f.given.envKey;
      add(A, 'Server key', same ? 'ok' : 'fail', "valid, for SWITCHYARD_EXPERIMENT's environment", same ? 'valid' : 'valid, but for another environment',
        'Create a server-side key in the right environment (or clear SWITCHYARD_SERVER_KEY and run init)');
    }
  }

  // ---- Release flag -------------------------------------------------------------------------------------------
  A = 'Release flag';
  const flagName = f.config.flag;
  let feature: Feature | null = null;
  if (f.feature) {
    if (!isOk(f.feature)) add(A, 'Flag', 'fail', `"${flagName}" exists`, f.feature.error);
    else {
      feature = f.feature.value;
      add(A, 'Flag', feature ? 'ok' : 'fail', `"${flagName}" exists (switchyard.config.yml)`, feature ? 'exists' : 'missing', INIT);
    }
  }
  if (feature) {
    const options = feature.multivariate_options;
    const keys = options.map((o) => o.key ?? '(unkeyed)');
    add(A, 'Multivariate', options.some((o) => o.key === 'v2') ? 'ok' : 'fail', 'variants control and v2', options.length ? `variants control, ${keys.join(', ')}` : 'not multivariate (no variants)',
      `${INIT}: it adds the v2 variant`);

    const tagList = isOk(f.tags) ? f.tags.value : undefined;
    if (f.tags && !isOk(f.tags)) add(A, `Tag "${RELEASE_TAG}"`, 'warn', `tagged "${RELEASE_TAG}" (permanent)`, f.tags.error);
    else if (tagList) {
      const tag = tagList.find((t) => t.label === RELEASE_TAG);
      const actual = !tag ? `no "${RELEASE_TAG}" tag in the project` : !feature.tags.includes(tag.id) ? 'the tag exists, but not on the flag' : tag.is_permanent === false ? 'tagged, but the tag is not permanent' : 'tagged (permanent)';
      add(A, `Tag "${RELEASE_TAG}"`, actual === 'tagged (permanent)' ? 'ok' : 'warn', `tagged "${RELEASE_TAG}" (permanent)`, actual,
        `${INIT}; a permanent tag keeps the flag out of Flagsmith's stale-flag detection`);
    }

    const flag = isOk(f.flag) ? f.flag.value : undefined;
    if (f.flag && !isOk(f.flag)) add(A, 'Values', 'fail', `each one of ${releases.join(', ')}`, f.flag.error);
    if (flag) {
      const segmentNames = new Map<number, string>();
      for (const s of (isOk(f.document) ? f.document.value.project.segments : [])) segmentNames.set(s.id, s.name);
      for (const s of (isOk(f.segments) ? f.segments.value : [])) segmentNames.set(s.id, s.name);
      const values: { where: string; value: string | null }[] = [
        { where: 'control', value: flag.environment_default.value.value },
        ...options.map((o) => ({ where: o.key ?? '(unkeyed)', value: o.string_value })),
        ...flag.segment_overrides.filter((o) => o.value).map((o) => ({ where: segmentNames.get(o.segment.id) ?? `segment ${o.segment.id}`, value: o.value!.value })),
      ];
      const bad = values.filter((v) => !allowed(v.value));
      add(A, 'Values name releases', bad.length ? 'fail' : 'ok', `each one of ${releases.join(', ')}`,
        bad.length ? bad.map((v) => `${v.where} = "${v.value ?? ''}"`).join(', ') + ' not in switchyard.config.yml' : uniq(values.map((v) => `${v.where} ${v.value}`)).join(', '),
        "Add the release to switchyard.config.yml's releases, or change the value in Flagsmith; the proxy serves the live release instead");
      add(A, 'On in this environment', flag.environment_default.enabled ? 'ok' : 'fail', 'on', flag.environment_default.enabled ? 'on' : 'off',
        'Turn the flag on in Flagsmith: while it is off, every visitor gets the live release');
      const serving = currentRelease(flag, options);
      add(A, 'Serving everyone else', allowed(serving) ? 'ok' : 'fail', 'a release in switchyard.config.yml', serving);

      // Preview: optional. If the segment exists, it must match the trait, and its override must outrank a running rollout.
      const segment = isOk(f.segments) ? f.segments.value.find((s) => s.name === PREVIEW_SEGMENT) : undefined;
      if (isOk(f.segments)) {
        if (!segment) add(A, 'Preview segment', 'ok', `"${PREVIEW_SEGMENT}" if preview is used`, 'not used yet');
        else {
          const override = flag.segment_overrides.find((o) => o.segment.id === segment.id);
          const traitOk = conditions(segment.rules).some((c) => c.property === PREVIEW_TRAIT && c.operator === 'EQUAL' && c.value === 'true');
          const running = runningExperiment(f, feature.id);
          const rollout = running ? flag.segment_overrides.find((o) => segmentNames.get(o.segment.id) === `experiment-${running.id}-rollout`) : undefined;
          const servesV2 = override?.variants.find((v) => v.weight >= 100);
          const served = servesV2 ? options.find((o) => o.id === servesV2.id)?.string_value : override?.value?.value;
          if (!traitOk) add(A, 'Preview segment', 'warn', `trait ${PREVIEW_TRAIT} = "true"`, 'different rules', `Edit "${PREVIEW_SEGMENT}" in Flagsmith back to trait ${PREVIEW_TRAIT} = "true"`);
          else if (!override) add(A, 'Preview segment', 'ok', `trait ${PREVIEW_TRAIT} = "true"`, 'exists; no preview on the flag right now');
          else if (rollout && override.priority > rollout.priority) {
            add(A, 'Preview segment', 'warn', "ranks above the experiment's rollout", `ranks below experiment ${running!.id}'s rollout: preview browsers are counted in it`,
              'Run switchyard preview before switchyard release, so the preview outranks the rollout');
          } else if (!f.given.previewToken) {
            add(A, 'Preview segment', 'warn', 'SWITCHYARD_PREVIEW_TOKEN set', `serves ${served ?? '?'}, but nobody can open the preview link`, INIT);
          } else {
            add(A, 'Preview segment', allowed(served) ? 'ok' : 'fail', `trait ${PREVIEW_TRAIT} = "true", a release in switchyard.config.yml`, `serves ${served ?? '?'} to browsers that opened the preview link`);
          }
        }
      }
    }
  }

  // ---- Metrics ------------------------------------------------------------------------------------------------
  A = 'Metrics';
  if (f.metrics && !isOk(f.metrics)) add(A, 'Metrics', 'fail', 'readable', f.metrics.error);
  else if (isOk(f.metrics)) {
    const wanted = [
      { event: f.config.goal, aggregation: 'occurrence', direction: 'up', role: 'goal' },
      ...f.config.guardrails.map((g) => ({ event: g, aggregation: 'mean', direction: 'down', role: 'guardrail' })),
    ];
    for (const w of wanted) {
      const m = f.metrics.value.find((x) => x.definition?.event === w.event);
      const expected = `${w.aggregation}, ${w.direction} is better (${w.role})`;
      if (!m) add(A, w.event, 'fail', expected, 'missing', INIT);
      else {
        const same = m.aggregation === w.aggregation && m.direction === w.direction;
        add(A, w.event, same ? 'ok' : 'fail', expected, `${m.aggregation}, ${m.direction} is better`,
          `Edit the metric in Flagsmith: Switchyard sends ${w.role === 'goal' ? 'one event per order' : 'a value per page load'}, so it needs ${w.aggregation} and direction ${w.direction}`);
      }
    }
  }

  // ---- Experiment ---------------------------------------------------------------------------------------------
  A = 'Experiment';
  if (feature && f.experiments && !isOk(f.experiments)) add(A, 'State', 'fail', 'readable', f.experiments.error);
  else if (feature && isOk(f.experiments)) {
    const onFlag = f.experiments.value.filter((e) => e.feature.id === feature.id || e.feature.name === flagName).sort((a, b) => b.id - a.id);
    const unfinished = onFlag.filter((e) => e.status !== 'completed');
    const statusOf = (id: number) => f.experiments && isOk(f.experiments) ? f.experiments.value.find((e) => e.id === id)?.status : undefined;
    const splits = isOk(f.document) ? analyze(f.document.value).filter((x) => x.flag === flagName) : [];
    const splitOf = (id: number) => splits.find((x) => x.experimentId === id && x.coveragePercent > 0);
    // A created, paused or running experiment's split is its own; only a completed (or unknown) one's is left behind.
    const leftovers = splits.filter((x) => x.status === 'leftover' && !['created', 'paused', 'running'].includes(statusOf(x.experimentId) ?? ''));
    const expected = 'one running experiment, or none and no split left behind';
    const docNote = isOk(f.document) ? '' : ' (splits not checked: needs the server key)';
    if (leftovers.length) {
      const l = leftovers[0]!;
      add(A, 'State', 'fail', expected, `experiment ${l.experimentId} isn't running, but its split still covers ${coverage(l, 'visitors')}`,
        'Edits to the default miss those visitors. Start the next experiment (switchyard release <label>) to clear it; next time end with Ship winner or Revert');
    } else if (unfinished.length > 1) {
      add(A, 'State', 'fail', expected, `${unfinished.length} unfinished experiments (${unfinished.map((e) => e.id).join(', ')})`, 'Complete all but one in Flagsmith');
    } else if (unfinished.length === 1) {
      const e = unfinished[0]!;
      const split = splitOf(e.id);
      if (e.status === 'running') {
        add(A, 'State', 'ok', expected, `experiment ${e.id} running: ${e.name}${split?.audience ? ` (its split covers ${coverage(split, 'visitors')})` : ''}${docNote}`);
      } else {
        add(A, 'State', 'warn', expected, `experiment ${e.id} is ${e.status}${split ? `; its split covers ${coverage(split, 'visitors')}` : ''}`,
          e.status === 'paused' ? 'Finish it: Ship winner or Revert in the console (they drain the split)' : 'Start it in Flagsmith, or run switchyard release <label>');
      }
    } else {
      add(A, 'State', 'ok', expected, `${onFlag.length ? `no experiment running (${onFlag.length} completed)` : 'no experiment yet'}; no split left behind${docNote}`);
    }
    // An audience limits the split to the identities matching its segments. The proxy identifies visitors by their
    // cookie and sends no traits but preview. A condition on another trait therefore matches no visitor, except
    // IS_NOT_SET, which a missing trait matches (flag_engine segments/evaluator.py:518-519, 524-528).
    const current = unfinished.length === 1 ? splitOf(unfinished[0]!.id) : undefined;
    if (current?.audience) {
      const traits = current.audience.traits.filter((t) => t !== PREVIEW_TRAIT);
      const unset = (current.audience.unsetTraits ?? []).filter((t) => t !== PREVIEW_TRAIT);
      const plural = (list: string[]) => `trait${list.length > 1 ? 's' : ''} ${list.join(', ')}`;
      const unsetNote = unset.length ? `; its "is not set" condition${unset.length > 1 ? 's' : ''} on ${plural(unset)} match${unset.length > 1 ? '' : 'es'} every visitor` : '';
      add(A, 'Audience', traits.length ? 'warn' : 'ok', "conditions the proxy's visitors can match (it sends only the preview trait)",
        traits.length
          ? `experiment ${current.experimentId}'s audience reads ${plural(traits)}, which the proxy never sends: those conditions match no visitor${unsetNote}`
          : `the split covers ${coverage(current, 'visitors')}${unsetNote}`,
        'Flagsmith fixes an audience once the experiment serves traffic: start the next experiment without trait conditions in its audience (switchyard release <label> sets none)');
    }
  }

  // ---- Feature Health -----------------------------------------------------------------------------------------
  A = 'Feature Health';
  if (!f.given.healthWebhook) add(A, 'Webhook provider', 'ok', 'set up by init (optional)', 'off: SWITCHYARD_HEALTH_WEBHOOK is empty');
  else if (f.providers && !isOk(f.providers)) add(A, 'Webhook provider', 'fail', 'readable', f.providers.error);
  else if (isOk(f.providers)) {
    const provider = f.providers.value.find((p) => p.name === 'Webhook');
    const same = !!provider?.webhook_url && pathOf(provider.webhook_url) === pathOf(f.given.healthWebhook);
    add(A, 'Webhook provider', same ? 'ok' : 'fail', "Flagsmith's Webhook provider, at the URL in SWITCHYARD_HEALTH_WEBHOOK",
      !provider ? 'no Webhook provider in the project' : same ? 'exists; the URL matches' : 'exists, at a different URL', `${INIT}: it writes the provider's current URL`);
  }

  // ---- Switchyard ---------------------------------------------------------------------------------------------
  A = 'Switchyard';
  if (!isOk(f.proxy)) {
    add(A, 'Proxy', 'fail', 'answers /__switchyard/health', f.proxy.error, 'Start it: docker compose up -d switchyard (logs: docker compose logs switchyard)');
  } else {
    const p = f.proxy.value;
    const fs = p.flagsmith;
    const expected = 'answers, with the flag loaded from Flagsmith';
    if (fs && !fs.ready) add(A, 'Proxy', 'warn', expected, `answers, but hasn't loaded the flag yet${fs.lastError ? ` (${fs.lastError})` : ''}`, 'Check SWITCHYARD_SERVER_KEY, then: docker compose logs switchyard');
    else if (fs?.lastError) add(A, 'Proxy', 'warn', expected, `answers; last refresh failed: ${fs.lastError}`, 'docker compose logs switchyard');
    else add(A, 'Proxy', 'ok', expected, `answers; flag ${fs?.environmentAgeSeconds != null ? `refreshed ${fs.environmentAgeSeconds} s ago` : 'loaded'}; live release ${p.liveRelease}`);
    if (!p.upstreams) {
      add(A, 'Release containers', 'warn', 'each release answers', f.given.previewToken ? "not checked: this proxy doesn't report them (rebuild: docker compose up -d --build)" : 'not checked: needs SWITCHYARD_PREVIEW_TOKEN',
        f.given.previewToken ? 'docker compose up -d --build' : INIT);
    } else {
      for (const r of f.config.releases) {
        const u = p.upstreams[r.label];
        const actual = !u ? 'not reported by the proxy' : u.status !== undefined ? `HTTP ${u.status} in ${u.ms} ms` : `unreachable (${u.error ?? 'no answer'})`;
        add(A, r.label, u?.ok ? 'ok' : 'fail', `container ${r.host} answers`, actual, `Start it: docker compose up -d ${r.host} (logs: docker compose logs ${r.host})`);
      }
    }
  }
  for (const w of f.writable ?? []) {
    add(A, w.label, w.problem ? 'fail' : 'ok', `${w.path} writable`, w.problem ?? `${w.path} writable`,
      w.label === 'State folder'
        ? 'Ship and Revert write snapshots and the ledger here and stop after pausing the experiment if they cannot. On Linux: sudo chown -R "$(id -u):$(id -g)" .switchyard, and run through switchyard.sh (or set SWITCHYARD_UID/SWITCHYARD_GID in .env: sh setup.sh does it)'
        : 'init and release write keys and the experiment id here. On Linux: sudo chown "$(id -u):$(id -g)" .env');
  }
  if (f.console === 'self') add(A, 'Console', 'ok', 'answers', 'answers (it served this check)');
  else if (isOk(f.console)) add(A, 'Console', f.console.value < 500 ? 'ok' : 'fail', 'answers', `HTTP ${f.console.value}`, 'docker compose logs console');
  else add(A, 'Console', 'fail', 'answers', f.console.error, 'Start it: docker compose up -d console (logs: docker compose logs console)');

  // ---- Events -------------------------------------------------------------------------------------------------
  A = 'Events';
  if (!f.events && f.fromHost) {
    // Not a problem with the setup: the port just isn't published. Inside Compose (cli doctor, the console's /setup) it is read.
    add(A, "Flagsmith's counter", 'ok', 'readable inside Compose',
      'not checked from the host: Flagsmith serves its Prometheus metrics on port 9100 inside Compose only (docker compose run --rm cli doctor, or the console\'s /setup page, reads it)');
  } else if (!f.events) {
    add(A, "Flagsmith's counter", 'warn', 'readable', `couldn't read ${f.metricsUrl ?? "Flagsmith's Prometheus metrics"}`,
      "Port 9100 is only reachable inside Compose: run docker compose run --rm cli doctor");
  } else {
    const { accepted, rejected } = f.events;
    add(A, "Flagsmith's counter", rejected > 0 ? 'warn' : 'ok', '0 rejected', `${n(accepted)} accepted, ${n(rejected)} rejected`,
      'Some events were refused: docker compose logs switchyard shows each refusal');
  }
  if (isOk(f.proxy)) {
    const u = f.proxy.value.undeliveredEvents;
    add(A, 'Proxy deliveries', u > 0 ? 'warn' : 'ok', '0 undelivered', `${n(u)} undelivered`, 'docker compose logs switchyard shows why');
  }
  // ---- Server mode (local mode has no f.server and skips these) -------------------------------------------------
  if (f.server) checks.push(...evaluateServer(f.server));
  return checks;
}

function refused(g: { error: string; status?: number }): string {
  return g.status === 401 || g.status === 403 ? `refused (HTTP ${g.status})` : g.status === 404 ? 'not found (HTTP 404)' : g.error;
}

function conditions(rules: Rule[] | undefined): Condition[] {
  return (rules ?? []).flatMap((r) => [...(r.conditions ?? []), ...conditions(r.rules)]);
}

function runningExperiment(f: DoctorFacts, featureId: number): Experiment | undefined {
  return isOk(f.experiments) ? f.experiments.value.find((e) => e.feature.id === featureId && e.status === 'running') : undefined;
}

function pathOf(url: string): string | undefined {
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

const uniq = <T>(xs: T[]) => [...new Set(xs)];

export function summarize(checks: DoctorCheck[]): DoctorReport['summary'] {
  const summary = { ok: 0, warn: 0, fail: 0 };
  for (const c of checks) summary[c.status]++;
  return summary;
}

export async function runDoctor(o: DoctorOptions): Promise<DoctorReport> {
  const checks = evaluate(await gatherFacts(o));
  return { at: new Date().toISOString(), checks, summary: summarize(checks) };
}

// The terminal table: one line per check; a mismatch adds expected, actual and the fix under it.
export function formatReport(report: DoctorReport): string[] {
  const label: Record<CheckStatus, string> = { ok: ' OK ', warn: 'WARN', fail: 'FAIL' };
  const width = Math.min(28, Math.max(...report.checks.map((c) => c.name.length)));
  const lines: string[] = [];
  let area = '';
  for (const c of report.checks) {
    if (c.area !== area) {
      area = c.area;
      lines.push('', area);
    }
    lines.push(`  [${label[c.status]}] ${c.name.padEnd(width)}  ${c.actual}`);
    if (c.status !== 'ok') {
      lines.push(`         ${''.padEnd(width)}  expected: ${c.expected}`);
      if (c.fix) lines.push(`         ${''.padEnd(width)}  fix:      ${c.fix}`);
    }
  }
  const { ok, warn, fail } = report.summary;
  lines.push('', `${ok} ok, ${warn} warning${warn === 1 ? '' : 's'}, ${fail} failing.${fail ? '' : ' Everything Switchyard needs is in place.'}`);
  return lines;
}
