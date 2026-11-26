import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { defaultHypothesis, type Config } from '../config.ts';
import {
  AdminClient,
  type Environment,
  type Experiment,
  type Feature,
  type Metric,
  type MvOption,
  type Organisation,
  type Project,
  type WarehouseConnection,
} from '../flagsmith/admin.ts';
import { scanAndSubmit, type Git } from '../flagsmith/code-refs.ts';

const ORG = 'Turnout';
const PROJECT = 'Turnout demo';
const ENVIRONMENT = 'Production';
export const RELEASE_TAG = 'release';

type Options = {
  apiUrl: string;
  dashboardUrl: string;
  config: Config;
  adminKey: string | undefined;
  serverKey?: string | undefined; // reused when set, so re-running init doesn't mint a new key each time
  envFile: string;
  waitMs?: number; // how long to wait for Flagsmith to answer; default 3 min
  log?: (line: string) => void;
  // Scan this checkout for the flag's name and submit it to Flagsmith's Code References. Best effort: never fails init.
  codeReferences?: { root: string; env?: NodeJS.ProcessEnv; git?: Git };
  env?: NodeJS.ProcessEnv; // the settings the judge links are built from; default process.env (with .env loaded)
  // Bring your own Flagsmith: reuse this project (name or id) and environment (name or key). Nothing is created at
  // the organisation, project or environment level: only the release flag, its tag, metrics and the experiment.
  project?: string | undefined;
  environment?: string | undefined;
};

/** Finds an existing project (by id or name) and environment (by key or name); never creates either. */
export async function findProjectAndEnvironment(
  api: AdminClient,
  projectRef: string,
  environmentRef: string | undefined,
): Promise<{ org: Organisation; project: Project; env: Environment }> {
  const orgs = await api.list<Organisation>('/api/v1/organisations/');
  const projects: Project[] = [];
  for (const o of orgs) projects.push(...(await api.list<Project>(`/api/v1/projects/?organisation=${o.id}`)));
  const byId = /^\d+$/.test(projectRef) ? projects.filter((p) => p.id === Number(projectRef)) : [];
  const matches = byId.length ? byId : projects.filter((p) => p.name === projectRef);
  if (matches.length === 0) {
    const names = projects.map((p) => `"${p.name}" (${p.id})`).join(', ') || 'none';
    throw new Error(`No Flagsmith project "${projectRef}" that this key can see (projects: ${names}). init --project never creates one.`);
  }
  if (matches.length > 1) throw new Error(`More than one project is called "${projectRef}": pass its id instead (${matches.map((p) => p.id).join(', ')}).`);
  const project = matches[0]!;
  const org = orgs.find((o) => o.id === project.organisation) ?? { id: project.organisation, name: String(project.organisation) };
  const envs = await api.list<Environment>(`/api/v1/environments/?project=${project.id}`);
  const env = environmentRef
    ? (envs.find((e) => e.api_key === environmentRef) ?? envs.find((e) => e.name === environmentRef))
    : envs.length === 1
      ? envs[0]
      : envs.find((e) => e.name === ENVIRONMENT);
  if (!env) {
    const names = envs.map((e) => `"${e.name}"`).join(', ') || 'none';
    throw new Error(
      environmentRef
        ? `Project "${project.name}" has no environment "${environmentRef}" (environments: ${names}). init --project never creates one.`
        : `Project "${project.name}" has several environments (${names}): pick one with --environment <name|key>.`,
    );
  }
  return { org, project, env };
}

/**
 * An existing release flag must already look like one: its value and every variant's value a release label from the
 * config. Anything else is someone else's flag, and init refuses rather than reshape it.
 */
export function incompatibleFlag(feature: Feature, releases: Iterable<string>): string | undefined {
  const labels = new Set(releases);
  const values = [
    ...(feature.initial_value !== null && feature.initial_value !== '' ? [{ what: 'its value', value: feature.initial_value }] : []),
    ...feature.multivariate_options.map((o) => ({ what: `variant ${o.key ?? o.id}`, value: o.string_value ?? '' })),
  ];
  const bad = values.filter((v) => !labels.has(String(v.value)));
  if (bad.length === 0) return undefined;
  return (
    `Flag "${feature.name}" already exists with values that aren't releases in your config ` +
    `(${bad.map((b) => `${b.what} = "${b.value}"`).join(', ')}; releases: ${[...labels].join(', ')}). ` +
    'Nothing was changed on it: pick another flag name in turnout.config.yml, or list those releases.'
  );
}

export async function init(opts: Options): Promise<void> {
  const log = opts.log ?? console.log;
  const api = new AdminClient(opts.apiUrl);
  const created: Record<string, string> = {};
  // Fail before touching Flagsmith if the keys couldn't be saved afterwards.
  assertWritableEnvFile(opts.envFile);
  // Every secret is saved the moment it exists: a failure later must not lose a login shown only once.
  const save = (values: Record<string, string>) => {
    Object.assign(created, values);
    writeEnv(opts.envFile, values);
  };

  // 1. Who are we? A fresh instance gets its first admin; an existing one needs an Organisation API key.
  // Flagsmith takes a while to start after `docker compose up`; wait for it rather than fail.
  type Version = { self_hosted_data?: { has_users: boolean } };
  const waitMs = opts.waitMs ?? 180_000;
  const started = Date.now();
  let version: Version | undefined;
  for (let attempt = 0; !version; attempt++) {
    try {
      version = await api.get<Version>('/version/');
    } catch (error) {
      if (Date.now() - started > waitMs) throw new Error(`Flagsmith isn't answering at ${opts.apiUrl}: ${(error as Error).message}`);
      if (attempt === 0) log(`Waiting for Flagsmith at ${opts.apiUrl} …`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  let newAdmin: { email: string; password: string } | undefined;
  if (version.self_hosted_data?.has_users === false && opts.project) {
    throw new Error(`This Flagsmith has no users yet, so it has no project "${opts.project}". Run init without --project to set it up from scratch.`);
  }
  if (version.self_hosted_data?.has_users === false) {
    newAdmin = { email: 'admin@turnout.local', password: randomBytes(18).toString('base64url') };
    const res = await api.post<{ key: string }>('/api/v1/auth/users/', {
      ...newAdmin,
      re_password: newAdmin.password,
      first_name: 'Turnout',
      last_name: 'Admin',
      superuser: true,
    });
    api.auth = { token: res.key };
    save({ FLAGSMITH_ADMIN_EMAIL: newAdmin.email, FLAGSMITH_ADMIN_PASSWORD: newAdmin.password });
    log(`✓ created the first admin, ${newAdmin.email}`);
  } else if (opts.adminKey) {
    api.auth = { apiKey: opts.adminKey };
  } else {
    throw new Error('This Flagsmith already has users. Put an Organisation API key in .env as TURNOUT_ADMIN_KEY.');
  }

  // 2. Organisation, project, environment: with --project, existing ones (never created); otherwise the demo's,
  // reused if they exist.
  let org: Organisation;
  let project: Project;
  let env: Environment;
  if (opts.project) {
    ({ org, project, env } = await findProjectAndEnvironment(api, opts.project, opts.environment));
    log(`✓ your project "${project.name}", environment "${env.name}" (organisation "${org.name}"): nothing created at that level`);
  } else {
    org =
      (await api.list<Organisation>('/api/v1/organisations/')).find((o) => o.name === ORG) ??
      (await api.post<Organisation>('/api/v1/organisations/', { name: ORG }));
    project =
      (await api.list<Project>(`/api/v1/projects/?organisation=${org.id}`)).find((p) => p.name === PROJECT) ??
      (await api.post<Project>('/api/v1/projects/', { name: PROJECT, organisation: org.id }));
    env =
      (await api.list<Environment>(`/api/v1/environments/?project=${project.id}`)).find((e) => e.name === ENVIRONMENT) ??
      (await api.post<Environment>('/api/v1/environments/', { name: ENVIRONMENT, project: project.id }));
    log(`✓ organisation "${org.name}", project "${project.name}", environment "${env.name}"`);
  }
  const envPath = `/api/v1/environments/${env.api_key}`;
  // "Pin my browser" in the console is a Flagsmith identity override; local evaluation sees identity overrides only
  // with this environment setting on (the default for new environments, off on older ones). Best effort: an
  // instance or a key that can't change it simply has no pinning.
  try {
    const settings = await api.get<{ use_identity_overrides_in_local_eval?: boolean }>(`${envPath}/`);
    if (settings?.use_identity_overrides_in_local_eval === false) {
      await api.patch(`${envPath}/`, { use_identity_overrides_in_local_eval: true });
      log('✓ identity overrides reach local evaluation (for pinning a browser to one version)');
    }
  } catch {
    /* no pinning on this instance */
  }

  // 3. Keys: an Organisation API key (only when we bootstrapped, since it's shown once) and a server-side key.
  if (newAdmin || !opts.adminKey) { // keys in .env from an earlier instance are stale on a fresh one
    const key = await api.post<{ key: string }>(`/api/v1/organisations/${org.id}/master-api-keys/`, {
      name: 'Turnout',
      is_admin: true,
    });
    save({ TURNOUT_ADMIN_KEY: key.key });
  }
  // With --project, a key in .env may belong to another environment (the demo's): reuse it only if it reads this one.
  const keyFitsEnvironment = async (key: string) => {
    if (!opts.project) return true;
    try {
      const res = await fetch(`${api.root}/api/v1/environment-document/`, { headers: { 'x-environment-key': key } });
      return res.ok && ((await res.json()) as { api_key?: string }).api_key === env.api_key;
    } catch {
      return false;
    }
  };
  if (opts.serverKey && !newAdmin && (await keyFitsEnvironment(opts.serverKey))) {
    log('✓ server-side key already in .env');
  } else {
    const serverKey = await api.post<{ key: string }>(`${envPath}/api-keys/`, { name: 'Turnout proxy' });
    save({ TURNOUT_SERVER_KEY: serverKey.key });
    log('✓ server-side key created');
  }

  // 4. Flagsmith's own event store. Without it the events endpoint answers 404.
  const warehouses = await api.list<WarehouseConnection>(`${envPath}/warehouse-connections/`);
  if (warehouses.length === 0) {
    const wh = await api.post<WarehouseConnection>(`${envPath}/warehouse-connections/`, {
      warehouse_type: 'postgres',
      config: { source: 'flagsmith_database' },
    });
    log(`✓ event store connected (${wh.status})`);
  } else {
    log(`✓ event store already connected (${warehouses[0]!.status})`);
  }

  // 5. The release flag: control serves the first upstream's release; v2, v3… serve the others.
  // The first release in the config is live (control, "A"); every other one is tested against it in the first
  // experiment: two releases make an A/B test, three an A/B/C test, and so on.
  const [controlRelease, ...newReleases] = [...opts.config.releases.keys()];
  const v2Release = newReleases[0];
  if (!controlRelease || !v2Release) throw new Error('turnout.config.yml must list at least two releases to start an experiment.');
  const features = await api.list<Feature>(`/api/v1/projects/${project.id}/features/?search=${opts.config.flag}`);
  let feature = features.find((f) => f.name === opts.config.flag);
  const conflict = feature && incompatibleFlag(feature, opts.config.releases.keys());
  if (conflict) throw new Error(conflict);
  if (!feature) {
    feature = await api.post<Feature>(`/api/v1/projects/${project.id}/features/`, {
      name: opts.config.flag,
      initial_value: controlRelease,
      default_enabled: true,
      description: 'Release router managed by Turnout. Each variant value is the release it serves.',
    });
    log(`✓ flag "${feature.name}" created`);
  }
  // A permanent tag marks it as the release router and keeps it out of Flagsmith's stale-flag detection.
  const tags = await api.list<{ id: number; label: string }>(`/api/v1/projects/${project.id}/tags/`);
  const tag =
    tags.find((t) => t.label === RELEASE_TAG) ??
    (await api.post<{ id: number; label: string }>(`/api/v1/projects/${project.id}/tags/`, {
      label: RELEASE_TAG,
      color: '#0AADDF',
      description: 'Managed by Turnout: each variant value is the release it serves',
      is_permanent: true,
    }));
  if (!feature.tags.includes(tag.id)) {
    await api.patch(`/api/v1/projects/${project.id}/features/${feature.id}/`, { tags: [...feature.tags, tag.id] });
  }
  log(`✓ flag tagged "${RELEASE_TAG}" (permanent)`);

  // Code References: where the flag's name appears in this checkout (infrastructure config, not the app).
  if (opts.codeReferences) {
    try {
      await scanAndSubmit({ api, projectId: project.id, flags: [opts.config.flag], ...opts.codeReferences, log });
    } catch (error) {
      log(`· code references not submitted: ${(error as Error).message}`);
    }
  }

  // Feature Health: a "Webhook" provider lets Turnout mark the release flag Unhealthy in Flagsmith's dashboard
  // when a guardrail is losing. Its URL carries the secret path; Flagsmith builds it with its own public host, so
  // point it at the API address Turnout uses.
  type HealthProvider = { name: string; webhook_url: string | null };
  const providersPath = `/api/v1/projects/${project.id}/feature-health/providers/`;
  // In your own project an existing provider is reused, never added: a provider is a project-wide setting.
  const existingProvider = (await api.list<HealthProvider>(providersPath)).find((p) => p.name === 'Webhook');
  const provider = existingProvider ?? (opts.project ? undefined : await api.post<HealthProvider>(providersPath, { name: 'Webhook' }));
  if (!provider) log('· Feature Health: this project has no "Webhook" provider, so guardrail health is not shown on the flag (add one in Flagsmith to get it)');
  if (provider?.webhook_url) {
    const path = new URL(provider.webhook_url).pathname;
    save({ TURNOUT_HEALTH_WEBHOOK: new URL(path, new URL(opts.apiUrl).origin).href });
    log('✓ Feature Health provider (Webhook): Turnout reports guardrail health on the flag');
  }

  const variants: MvOption[] = [];
  for (const [i, release] of newReleases.entries()) {
    const key = `v${i + 2}`;
    let option = feature.multivariate_options.find((o) => o.key === key);
    if (!option) {
      option = await api.post<MvOption>(`/api/v1/projects/${project.id}/features/${feature.id}/mv-options/`, {
        feature: feature.id,
        type: 'unicode',
        string_value: release,
        default_percentage_allocation: 0,
        key,
      });
      log(`✓ variant ${key} → ${release}`);
    }
    variants.push(option);
  }

  // 6. Metrics: the goal (first: Flagsmith's primary), secondary metrics such as add_to_cart, and the guardrails.
  // Secondary metrics expect an increase like the goal; guardrails expect no increase, which is how Turnout tells
  // them apart (src/flagsmith/experiments.ts isGuardrail).
  const wanted = [
    opts.config.goal.speedOnly
      ? { name: opts.config.goal.event, aggregation: 'mean', direction: 'down', expected: 'decrease' } // no goal: speed
      : { name: opts.config.goal.event, aggregation: 'occurrence', direction: 'up', expected: 'increase' },
    ...(opts.config.metrics ?? []).map((m) => ({ name: m.event, aggregation: 'occurrence', direction: 'up', expected: 'increase' })),
    ...opts.config.guardrails.map((g) => ({ name: g, aggregation: 'mean', direction: 'down', expected: 'not_increase' })),
  ];
  const existing = await api.list<Metric>(`${envPath}/experiment-metrics/`);
  const metrics: { metric: number; expected_direction: string }[] = [];
  for (const m of wanted) {
    const metric =
      existing.find((e) => e.definition?.event === m.name) ??
      (await api.post<Metric>(`${envPath}/experiment-metrics/`, {
        name: m.name,
        aggregation: m.aggregation,
        direction: m.direction,
        definition: { version: 1, event: m.name },
      }));
    metrics.push({ metric: metric.id, expected_direction: m.expected });
  }
  log(`✓ metrics: ${wanted.map((m) => m.name).join(', ')}`);

  // 7. The first experiment, started.
  const experiments = await api.list<Experiment>(`${envPath}/experiments/`);
  const onFlag = experiments.filter((e) => e.feature.id === feature.id).sort((a, b) => b.id - a.id);
  let experiment = onFlag.find((e) => e.status !== 'completed');
  if (!experiment && onFlag.length) {
    // Releases already ran on this flag: the next one is `turnout release`'s job, which knows what's live.
    experiment = onFlag[0]!;
    log(`✓ ${onFlag.length} experiment(s) already ran on "${feature.name}"; start the next with: turnout release <label>`);
  } else if (!experiment) {
    experiment = await api.post<Experiment>(`${envPath}/experiments/`, {
      feature: feature.id,
      name: `${opts.config.flag}: ${newReleases.join(' vs ')} vs ${controlRelease}`,
      hypothesis: defaultHypothesis(newReleases.join(' or '), opts.config.goal.event),
      metrics,
      experiment_rollout: {
        enabled: true,
        rollout_percentage: opts.config.traffic,
        feature_state_value: { type: 'string', value: controlRelease },
        // An even share each: 50/50 for A/B, 34/33/33 for A/B/C (control keeps the remainder).
        multivariate_feature_state_values: variants.map((v) => ({ multivariate_feature_option: v.id, percentage_allocation: Math.floor(100 / (variants.length + 1)) })),
      },
    });
  }
  const rollout = (experiment as { experiment_rollout?: { rollout_percentage?: number } }).experiment_rollout?.rollout_percentage;
  if (experiment.status !== 'completed' && rollout !== undefined && rollout !== opts.config.traffic) {
    log(`! experiment ${experiment.id} sends ${rollout}% of visitors into the experiment, but turnout.config.yml says traffic: ${opts.config.traffic}. A running experiment keeps its split: start a new one (turnout release, or turnout compare with the new settings) to change it.`);
  }
  if (experiment.status === 'created') {
    experiment = await api.post<Experiment>(`${envPath}/experiments/${experiment.id}/start/`);
  }
  log(`✓ experiment "${experiment.name}" is ${experiment.status}`);

  // A metric added to the config later is attached to the current experiment while it isn't completed (Flagsmith:
  // api/experimentation/experiment_urls.py:12, serializers.py:228-247 refuse a completed one or a duplicate).
  if (experiment.status !== 'completed') {
    const attached = await api.get<{ metric: number }[]>(`${envPath}/experiments/${experiment.id}/metrics/`);
    const missing = metrics.filter((m) => !attached.some((a) => a.metric === m.metric));
    for (const m of missing) await api.post(`${envPath}/experiments/${experiment.id}/metrics/`, m);
    if (missing.length) log(`✓ attached ${missing.length} new metric(s) to the running experiment`);
  }

  save({ TURNOUT_EXPERIMENT: `${env.api_key}/${experiment.id}` });
  if (!process.env.TURNOUT_PREVIEW_TOKEN) save({ TURNOUT_PREVIEW_TOKEN: randomBytes(18).toString('base64url') });
  // Opens judge mode (/judge?key=…) on devices other than this machine. Rotate it to revoke every judge browser.
  // Kept across re-runs: from the environment, or from the env file itself.
  const savedJudgeToken =
    process.env.TURNOUT_JUDGE_TOKEN || readFileSync(opts.envFile, 'utf8').match(/^TURNOUT_JUDGE_TOKEN=(\S+)$/m)?.[1];
  const judgeToken = savedJudgeToken || randomBytes(18).toString('base64url');
  if (!savedJudgeToken) save({ TURNOUT_JUDGE_TOKEN: judgeToken });
  log(`\nWrote ${Object.keys(created).join(' and ')} to ${opts.envFile}.`);
  if (newAdmin) log(`Dashboard: ${opts.dashboardUrl} (login saved in ${opts.envFile} as FLAGSMITH_ADMIN_EMAIL / FLAGSMITH_ADMIN_PASSWORD)`);
  log(`Experiment: ${opts.dashboardUrl}/project/${project.id}/environment/${env.api_key}/experiments/${experiment.id}`);
  for (const line of judgeLinks(judgeToken, opts.env ?? process.env)) log(line);
}

const CONSOLE_PORT = 8090; // this machine (Compose publishes it on 127.0.0.1 only); TURNOUT_PUBLIC_CONSOLE_PORT overrides it
/** The console port published on this machine: TURNOUT_PUBLIC_CONSOLE_PORT (set by "turnout new --console-port"), else 8090. */
export function consolePort(env: NodeJS.ProcessEnv): number {
  const n = Number(env.TURNOUT_PUBLIC_CONSOLE_PORT?.trim());
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : CONSOLE_PORT;
}
export const DEVICE_PORT = 8091; // other devices: the console's judge-link-only port (CONSOLE_DEVICE_PORT)
const isLoopback = (host: string) => host === 'localhost' || host === '[::1]' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
const hostOf = (url: string | undefined): string | undefined => {
  try {
    return url ? new URL(url).hostname : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The hostname for links on this machine: 127.0.0.1, or the loopback name TURNOUT_PUBLIC_SHOP_URL uses, so the
 * console and the Shop tab stay on the same site (see judgeLinks).
 */
export function localHost(env: NodeJS.ProcessEnv): string {
  const shopHost = hostOf(env.TURNOUT_PUBLIC_SHOP_URL || 'http://127.0.0.1:8080');
  return shopHost && isLoopback(shopHost) ? shopHost : '127.0.0.1';
}

/**
 * The judge links init prints, from the settings in .env (the CLI loads it into the environment).
 * This machine: 127.0.0.1, or the loopback name the shop URL uses. The console and the shop must share a hostname:
 * the Shop tab on "localhost" inside a console on "127.0.0.1" is a cross-site frame, and the browser drops the
 * shop's SameSite=Lax cookies there. 127.0.0.1 rather than localhost: on Windows a client that tries ::1 first
 * waits for the refused IPv6 attempt (Compose publishes on 127.0.0.1 only).
 * Other devices: the first TURNOUT_CONSOLE_HOSTS entry (or the one the shop URL uses), with the key.
 */
export function judgeLinks(token: string, env: NodeJS.ProcessEnv): string[] {
  const shopHost = hostOf(env.TURNOUT_PUBLIC_SHOP_URL || 'http://127.0.0.1:8080');
  const local = localHost(env);
  const lines = [`Judge mode: http://${local}:${consolePort(env)}/judge`];
  const hosts = (env.TURNOUT_CONSOLE_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  if (hosts.length === 0) {
    lines.push('Judge mode on other devices: set TURNOUT_CONSOLE_HOSTS and TURNOUT_PUBLISH_HOST=0.0.0.0 in .env (see .env.example), then run init again for the link.');
    return lines;
  }
  const remote = shopHost && hosts.includes(shopHost) ? shopHost : hosts[0]!;
  lines.push(`Judge link for other devices: http://${remote}:${DEVICE_PORT}/judge?key=${token}`);
  if (isLoopback(env.TURNOUT_PUBLISH_HOST?.trim() || '127.0.0.1')) {
    lines.push('  Other devices reach it once TURNOUT_PUBLISH_HOST=0.0.0.0 is set in .env and the stack is restarted.');
  }
  if (shopHost !== remote) {
    lines.push(`  Set TURNOUT_PUBLIC_SHOP_URL=http://${remote}:8080 in .env too, so the Shop tab on other devices loads the shop from this machine.`);
  } else {
    lines.push('  On this machine too, open that link: the Shop tab needs the console and the shop on the same hostname.');
  }
  return lines;
}

// Docker creates a missing bind-mounted file as a directory; say what to do instead of failing on EISDIR.
export function assertWritableEnvFile(path: string): void {
  if (existsSync(path) && statSync(path).isDirectory()) {
    throw new Error(`${path} is a directory (Docker creates one when the file is missing). Remove it, run "cp .env.example .env", and try again.`);
  }
}

export function writeEnv(path: string, values: Record<string, string>): void {
  assertWritableEnvFile(path);
  let text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n]/.test(value)) throw new Error(`Refusing to write ${key} to ${path}: unsafe name or value`);
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, () => line) : `${text.trimEnd()}\n${line}\n`;
  }
  writeFileSync(path, text.trimStart());
}
