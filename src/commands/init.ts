import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { Config } from '../config.ts';
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

const ORG = 'Switchyard';
const PROJECT = 'Switchyard demo';
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
};

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
  if (version.self_hosted_data?.has_users === false) {
    newAdmin = { email: 'admin@switchyard.local', password: randomBytes(18).toString('base64url') };
    const res = await api.post<{ key: string }>('/api/v1/auth/users/', {
      ...newAdmin,
      re_password: newAdmin.password,
      first_name: 'Switchyard',
      last_name: 'Admin',
      superuser: true,
    });
    api.auth = { token: res.key };
    save({ FLAGSMITH_ADMIN_EMAIL: newAdmin.email, FLAGSMITH_ADMIN_PASSWORD: newAdmin.password });
    log(`✓ created the first admin, ${newAdmin.email}`);
  } else if (opts.adminKey) {
    api.auth = { apiKey: opts.adminKey };
  } else {
    throw new Error('This Flagsmith already has users. Put an Organisation API key in .env as SWITCHYARD_ADMIN_KEY.');
  }

  // 2. Organisation, project, environment (reused if they exist).
  const org =
    (await api.list<Organisation>('/api/v1/organisations/')).find((o) => o.name === ORG) ??
    (await api.post<Organisation>('/api/v1/organisations/', { name: ORG }));
  const project =
    (await api.list<Project>(`/api/v1/projects/?organisation=${org.id}`)).find((p) => p.name === PROJECT) ??
    (await api.post<Project>('/api/v1/projects/', { name: PROJECT, organisation: org.id }));
  const env =
    (await api.list<Environment>(`/api/v1/environments/?project=${project.id}`)).find((e) => e.name === ENVIRONMENT) ??
    (await api.post<Environment>('/api/v1/environments/', { name: ENVIRONMENT, project: project.id }));
  log(`✓ organisation "${org.name}", project "${project.name}", environment "${env.name}"`);
  const envPath = `/api/v1/environments/${env.api_key}`;

  // 3. Keys: an Organisation API key (only when we bootstrapped, since it's shown once) and a server-side key.
  if (newAdmin || !opts.adminKey) { // keys in .env from an earlier instance are stale on a fresh one
    const key = await api.post<{ key: string }>(`/api/v1/organisations/${org.id}/master-api-keys/`, {
      name: 'Switchyard',
      is_admin: true,
    });
    save({ SWITCHYARD_ADMIN_KEY: key.key });
  }
  if (opts.serverKey && !newAdmin) {
    log('✓ server-side key already in .env');
  } else {
    const serverKey = await api.post<{ key: string }>(`${envPath}/api-keys/`, { name: 'Switchyard proxy' });
    save({ SWITCHYARD_SERVER_KEY: serverKey.key });
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

  // 5. The release flag: control serves the first upstream's release, v2 the new one.
  // The first release in the config is live (control); the second is the first one to test.
  const [controlRelease, v2Release] = [...opts.config.releases.keys()];
  if (!controlRelease || !v2Release) throw new Error('switchyard.config.yml must list at least two releases to start an experiment.');
  const features = await api.list<Feature>(`/api/v1/projects/${project.id}/features/?search=${opts.config.flag}`);
  let feature = features.find((f) => f.name === opts.config.flag);
  if (!feature) {
    feature = await api.post<Feature>(`/api/v1/projects/${project.id}/features/`, {
      name: opts.config.flag,
      initial_value: controlRelease,
      default_enabled: true,
      description: 'Release router managed by Switchyard. Each variant value is the release it serves.',
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
      description: 'Managed by Switchyard: each variant value is the release it serves',
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

  // Feature Health: a "Webhook" provider lets Switchyard mark the release flag Unhealthy in Flagsmith's dashboard
  // when a guardrail is losing. Its URL carries the secret path; Flagsmith builds it with its own public host, so
  // point it at the API address Switchyard uses.
  type HealthProvider = { name: string; webhook_url: string | null };
  const providersPath = `/api/v1/projects/${project.id}/feature-health/providers/`;
  const provider =
    (await api.list<HealthProvider>(providersPath)).find((p) => p.name === 'Webhook') ??
    (await api.post<HealthProvider>(providersPath, { name: 'Webhook' }));
  if (provider.webhook_url) {
    const path = new URL(provider.webhook_url).pathname;
    save({ SWITCHYARD_HEALTH_WEBHOOK: new URL(path, new URL(opts.apiUrl).origin).href });
    log('✓ Feature Health provider (Webhook): Switchyard reports guardrail health on the flag');
  }

  let v2 = feature.multivariate_options.find((o) => o.key === 'v2');
  if (!v2) {
    v2 = await api.post<MvOption>(`/api/v1/projects/${project.id}/features/${feature.id}/mv-options/`, {
      feature: feature.id,
      type: 'unicode',
      string_value: v2Release,
      default_percentage_allocation: 0,
      key: 'v2',
    });
    log(`✓ variant v2 → ${v2Release}`);
  }

  // 6. Metrics: the goal and two guardrails.
  const wanted = [
    { name: opts.config.goal.event, aggregation: 'occurrence', direction: 'up', expected: 'increase' },
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
    // Releases already ran on this flag: the next one is `switchyard release`'s job, which knows what's live.
    experiment = onFlag[0]!;
    log(`✓ ${onFlag.length} experiment(s) already ran on "${feature.name}"; start the next with: switchyard release <label>`);
  } else if (!experiment) {
    experiment = await api.post<Experiment>(`${envPath}/experiments/`, {
      feature: feature.id,
      name: `${opts.config.flag}: ${v2Release} vs ${controlRelease}`,
      hypothesis: `${v2Release} raises ${opts.config.goal.event} without hurting latency or errors`,
      metrics,
      experiment_rollout: {
        enabled: true,
        rollout_percentage: 100,
        feature_state_value: { type: 'string', value: controlRelease },
        multivariate_feature_state_values: [{ multivariate_feature_option: v2.id, percentage_allocation: 50 }],
      },
    });
  }
  if (experiment.status === 'created') {
    experiment = await api.post<Experiment>(`${envPath}/experiments/${experiment.id}/start/`);
  }
  log(`✓ experiment "${experiment.name}" is ${experiment.status}`);

  save({ SWITCHYARD_EXPERIMENT: `${env.api_key}/${experiment.id}` });
  if (!process.env.SWITCHYARD_PREVIEW_TOKEN) save({ SWITCHYARD_PREVIEW_TOKEN: randomBytes(18).toString('base64url') });
  // Opens judge mode (/judge?key=…) on devices other than this machine. Rotate it to revoke every judge browser.
  // Kept across re-runs: from the environment, or from the env file itself.
  const savedJudgeToken =
    process.env.SWITCHYARD_JUDGE_TOKEN || readFileSync(opts.envFile, 'utf8').match(/^SWITCHYARD_JUDGE_TOKEN=(\S+)$/m)?.[1];
  const judgeToken = savedJudgeToken || randomBytes(18).toString('base64url');
  if (!savedJudgeToken) save({ SWITCHYARD_JUDGE_TOKEN: judgeToken });
  log(`\nWrote ${Object.keys(created).join(' and ')} to ${opts.envFile}.`);
  if (newAdmin) log(`Dashboard: ${opts.dashboardUrl} (login saved in ${opts.envFile} as FLAGSMITH_ADMIN_EMAIL / FLAGSMITH_ADMIN_PASSWORD)`);
  log(`Experiment: ${opts.dashboardUrl}/project/${project.id}/environment/${env.api_key}/experiments/${experiment.id}`);
  for (const line of judgeLinks(judgeToken, opts.env ?? process.env)) log(line);
}

const CONSOLE_PORT = 8090; // this machine (Compose publishes it on 127.0.0.1 only)
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
 * The hostname for links on this machine: 127.0.0.1, or the loopback name SWITCHYARD_PUBLIC_SHOP_URL uses, so the
 * console and the Shop tab stay on the same site (see judgeLinks).
 */
export function localHost(env: NodeJS.ProcessEnv): string {
  const shopHost = hostOf(env.SWITCHYARD_PUBLIC_SHOP_URL || 'http://127.0.0.1:8080');
  return shopHost && isLoopback(shopHost) ? shopHost : '127.0.0.1';
}

/**
 * The judge links init prints, from the settings in .env (the CLI loads it into the environment).
 * This machine: 127.0.0.1, or the loopback name the shop URL uses. The console and the shop must share a hostname:
 * the Shop tab on "localhost" inside a console on "127.0.0.1" is a cross-site frame, and the browser drops the
 * shop's SameSite=Lax cookies there. 127.0.0.1 rather than localhost: on Windows a client that tries ::1 first
 * waits for the refused IPv6 attempt (Compose publishes on 127.0.0.1 only).
 * Other devices: the first SWITCHYARD_CONSOLE_HOSTS entry (or the one the shop URL uses), with the key.
 */
export function judgeLinks(token: string, env: NodeJS.ProcessEnv): string[] {
  const shopHost = hostOf(env.SWITCHYARD_PUBLIC_SHOP_URL || 'http://127.0.0.1:8080');
  const local = localHost(env);
  const lines = [`Judge mode: http://${local}:${CONSOLE_PORT}/judge`];
  const hosts = (env.SWITCHYARD_CONSOLE_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  if (hosts.length === 0) {
    lines.push('Judge mode on other devices: set SWITCHYARD_CONSOLE_HOSTS and SWITCHYARD_PUBLISH_HOST=0.0.0.0 in .env (see .env.example), then run init again for the link.');
    return lines;
  }
  const remote = shopHost && hosts.includes(shopHost) ? shopHost : hosts[0]!;
  lines.push(`Judge link for other devices: http://${remote}:${DEVICE_PORT}/judge?key=${token}`);
  if (isLoopback(env.SWITCHYARD_PUBLISH_HOST?.trim() || '127.0.0.1')) {
    lines.push('  Other devices reach it once SWITCHYARD_PUBLISH_HOST=0.0.0.0 is set in .env and the stack is restarted.');
  }
  if (shopHost !== remote) {
    lines.push(`  Set SWITCHYARD_PUBLIC_SHOP_URL=http://${remote}:8080 in .env too, so the Shop tab on other devices loads the shop from this machine.`);
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
