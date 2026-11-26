// In-memory stand-in for the Flagsmith Admin API endpoints that init, preview and release call. It keeps a small
// model (organisations → projects → environments → features, tags, options, metrics, experiments, segments) and
// records every request, so tests can assert both on the resulting state and on what was sent.
// Rules it enforces where the real API does and the commands depend on them:
// - auth on everything but /version/ and the first-user signup (Token <t> or Api-Key <k>);
// - signing up only while the instance has no users;
// - a partial PATCH of an mv-option answers 500 (Flagsmith 2.291.0, features/multivariate/serializers.py:85-86);
// - a flag's segment override priorities are unique;
// - one unfinished experiment per flag; an option can't change while one runs.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Environment, Feature, Metric, MvOption, Organisation, Project, WarehouseConnection } from '../src/flagsmith/admin.ts';
import type { ExperimentDetail, FlagState } from '../src/flagsmith/experiments.ts';

export type Recorded = { method: string; path: string; body: unknown; authorization: string | undefined };
export type Tag = { id: number; label: string; color: string; description: string; is_permanent: boolean; project: number };
export type Segment = { id: number; name: string; project: number; description?: string; rules: unknown[] };
export type Override = FlagState['segment_overrides'][number] & { value?: unknown };
export type FakeExperiment = ExperimentDetail & { envKey: string };

export type FakeAdminState = {
  hasUsers: boolean;
  users: { email: string; password: string; superuser: boolean }[];
  tokens: string[]; // valid "Token …" values
  adminKeys: string[]; // valid "Api-Key …" values (Organisation API keys)
  serverKeys: { envKey: string; key: string; name: string }[];
  organisations: Organisation[];
  projects: Project[];
  environments: Environment[];
  warehouses: (WarehouseConnection & { envKey: string; config: unknown })[];
  features: (Feature & { project: number; default_enabled: boolean; description?: string })[];
  tags: Tag[];
  healthProviders: { name: string; project: number; created_by: null; webhook_url: string }[];
  metrics: (Metric & { envKey: string })[];
  experiments: FakeExperiment[];
  flags: Map<string, FlagState & { segment_overrides: Override[] }>; // "<envKey>/<featureId>"
  segments: Segment[];
  codeScans: CodeScan[]; // POST …/code-references/, kept like ScannedCodeReferences (one row per feature and scan)
  evaluations: { day: string; count: number }[]; // what …/evaluation-data/ answers (Flag Analytics)
  requests: Recorded[];
  failWhen?: ((method: string, path: string) => boolean) | undefined; // answers 500 once, then clears
  nextId: number;
};
export type CodeScan = { project: number; repositoryUrl: string; revision: string; at: string; references: { feature_name: string; file_path: string; line_number: number }[] };

export function emptyState(opts: { hasUsers?: boolean; adminKeys?: string[] } = {}): FakeAdminState {
  return {
    hasUsers: opts.hasUsers ?? false,
    users: [],
    tokens: [],
    adminKeys: [...(opts.adminKeys ?? [])],
    serverKeys: [],
    organisations: [],
    projects: [],
    environments: [],
    warehouses: [],
    features: [],
    tags: [],
    healthProviders: [],
    metrics: [],
    experiments: [],
    flags: new Map(),
    segments: [],
    codeScans: [],
    evaluations: [],
    requests: [],
    nextId: 1,
  };
}

// Paginated like most Flagsmith lists; some endpoints answer bare arrays, and AdminClient.list must take both.
const page = <T>(results: T[]) => ({ count: results.length, next: null, previous: null, results });

export const flagKey = (envKey: string, featureId: number) => `${envKey}/${featureId}`;

export async function startFakeAdmin(state: FakeAdminState): Promise<{ apiUrl: string; close: () => Promise<void> }> {
  const id = () => state.nextId++;

  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body: any;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://fake');
    const path = url.pathname;
    const authorization = req.headers.authorization;
    state.requests.push({ method, path: `${path}${url.search}`, body, authorization });

    const send = (status: number, data?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(data === undefined ? '' : JSON.stringify(data));
    };
    if (state.failWhen?.(method, path)) {
      state.failWhen = undefined;
      return send(500, { detail: 'injected failure' });
    }

    // Unauthenticated endpoints.
    if (method === 'GET' && path === '/version/') {
      return send(200, { ci_commit_sha: 'fake', image_tag: '2.291.0', self_hosted_data: { has_users: state.hasUsers } });
    }
    if (method === 'POST' && path === '/api/v1/auth/users/') {
      if (state.hasUsers) return send(403, { detail: 'You do not have permission to perform this action.' });
      if (body.password !== body.re_password) return send(400, { re_password: ['mismatch'] });
      state.users.push({ email: body.email, password: body.password, superuser: body.superuser === true });
      state.hasUsers = true;
      const token = `token${id()}`;
      state.tokens.push(token);
      return send(201, { key: token });
    }

    // The environment document, read with a server-side key (check and doctor).
    if (method === 'GET' && path === '/api/v1/environment-document/') {
      const serverKey = state.serverKeys.find((k) => k.key === req.headers['x-environment-key']);
      if (!serverKey) return send(403, { detail: 'Invalid or missing environment key' });
      return send(200, environmentDocument(serverKey.envKey));
    }

    const authed =
      (authorization?.startsWith('Token ')&& state.tokens.includes(authorization.slice(6))) ||
      (authorization?.startsWith('Api-Key ') && state.adminKeys.includes(authorization.slice(8)));
    if (!authed) return send(401, { detail: 'Authentication credentials were not provided.' });

    let m: RegExpMatchArray | null;

    // The feature map's reads that take numeric ids or sit outside the routes below.
    if ((m = path.match(/^\/api\/v1\/environments\/(\d+)\/feature-lifecycle-counts\/$/)) && method === 'GET') {
      const env = state.environments.find((e) => e.id === Number(m![1]));
      if (!env) return send(404, { detail: 'Not found.' });
      const counts: Record<string, number> = { new: 0, live: 0, stale: 0, permanent: 0, needs_monitoring: 0, to_remove: 0 };
      for (const f of state.features.filter((f) => f.project === env.project)) counts[lifecycleStage(f)]!++;
      return send(200, counts);
    }
    if ((m = path.match(/^\/api\/v1\/organisations\/(\d+)\/integrations\/github\/$/)) && method === 'GET') return send(200, page([]));
    if ((m = path.match(/^\/api\/v1\/projects\/(\d+)\/$/)) && method === 'GET') {
      const project = state.projects.find((p) => p.id === Number(m![1]));
      return project ? send(200, project) : send(404, { detail: 'Not found.' });
    }

    // Organisations, projects, environments.
    if (path === '/api/v1/organisations/') {
      if (method === 'GET') return send(200, page(state.organisations));
      const org = { id: id(), name: body.name };
      state.organisations.push(org);
      return send(201, org);
    }
    if ((m = path.match(/^\/api\/v1\/organisations\/(\d+)\/master-api-keys\/$/)) && method === 'POST') {
      const key = `org.key${id()}`;
      state.adminKeys.push(key);
      return send(201, { key, name: body.name, is_admin: body.is_admin, organisation: Number(m[1]) });
    }
    if (path === '/api/v1/projects/') {
      if (method === 'GET') {
        const org = Number(url.searchParams.get('organisation'));
        return send(200, state.projects.filter((p) => p.organisation === org)); // bare array
      }
      const project = { id: id(), name: body.name, organisation: body.organisation };
      state.projects.push(project);
      return send(201, project);
    }
    if (path === '/api/v1/environments/') {
      if (method === 'GET') {
        const project = Number(url.searchParams.get('project'));
        return send(200, page(state.environments.filter((e) => e.project === project)));
      }
      const n = id();
      const env = { id: n, name: body.name, api_key: `envKey${n}`, project: body.project };
      state.environments.push(env);
      // Every existing feature gets a state in the new environment.
      for (const f of state.features.filter((f) => f.project === env.project)) createFlagState(env.api_key, f);
      return send(201, env);
    }

    if ((m = path.match(/^\/api\/v1\/environments\/([^/]+)\/(.*)$/))) {
      const envKey = m[1]!;
      const rest = m[2]!;
      const env = state.environments.find((e) => e.api_key === envKey);
      if (!env) return send(404, { detail: 'Not found.' });

      if (rest === '' && method === 'GET') return send(200, env);
      if (rest === 'api-keys/' && method === 'POST') {
        const key = `ser.key${id()}`;
        state.serverKeys.push({ envKey, key, name: body.name });
        return send(201, { key, name: body.name, active: true });
      }
      if (rest === 'warehouse-connections/') {
        const mine = state.warehouses.filter((w) => w.envKey === envKey);
        if (method === 'GET') return send(200, mine.map(({ envKey: _, ...w }) => w)); // bare array
        if (mine.length) return send(400, { detail: 'This environment already has a warehouse connection.' });
        const wh = { id: id(), status: 'connected', warehouse_type: body.warehouse_type, config: body.config, envKey };
        state.warehouses.push(wh);
        return send(201, { id: wh.id, status: wh.status, warehouse_type: wh.warehouse_type });
      }
      if (rest === 'experiment-metrics/') {
        if (method === 'GET') return send(200, page(state.metrics.filter((x) => x.envKey === envKey)));
        const metric = { id: id(), name: body.name, aggregation: body.aggregation, direction: body.direction, definition: body.definition, envKey };
        state.metrics.push(metric);
        return send(201, metric);
      }
      if (rest === 'experiments/') {
        const mine = state.experiments.filter((e) => e.envKey === envKey);
        if (method === 'GET') return send(200, page(mine.map(summary)));
        const feature = state.features.find((f) => f.id === body.feature);
        if (!feature) return send(400, { feature: ['Invalid pk'] });
        const unfinished = mine.find((e) => e.feature.id === feature.id && e.status !== 'completed');
        if (unfinished) return send(400, { detail: `Feature already has an unfinished experiment (${unfinished.id}).` });
        const experiment: FakeExperiment = {
          id: id(),
          envKey,
          name: body.name,
          hypothesis: body.hypothesis,
          status: 'created',
          feature: featureView(feature),
          metrics: (body.metrics as { metric: number; expected_direction: string }[]).map((x) => {
            const metric = state.metrics.find((s) => s.id === x.metric)!;
            return { metric: x.metric, metric_name: metric.name, aggregation: metric.aggregation, direction: metric.direction, expected_direction: x.expected_direction };
          }),
          experiment_rollout: body.experiment_rollout,
          started_at: null,
          ended_at: null,
        };
        state.experiments.push(experiment);
        return send(201, publicExperiment(experiment));
      }
      if ((m = rest.match(/^experiments\/(\d+)\/(start\/)?$/))) {
        const experiment = state.experiments.find((e) => e.envKey === envKey && e.id === Number(m![1]));
        if (!experiment) return send(404, { detail: 'Not found.' });
        if (!m[2] && method === 'GET') {
          experiment.feature = featureView(state.features.find((f) => f.id === experiment.feature.id)!);
          return send(200, publicExperiment(experiment));
        }
        if (m[2] && method === 'POST') {
          if (experiment.status !== 'created') return send(400, { detail: `Cannot transition from '${experiment.status}' to 'running'.` });
          experiment.status = 'running';
          experiment.started_at = '2026-11-17T00:00:00Z';
          startRollout(envKey, experiment);
          return send(200, publicExperiment(experiment));
        }
      }
      if (/^integrations\/[\w-]+\/$/.test(rest) && method === 'GET') return send(200, []); // nothing configured
      return send(404, { detail: `fake: no route for ${method} ${path}` });
    }

    // Project-level: features, tags, options, segments.
    if ((m = path.match(/^\/api\/v1\/projects\/(\d+)\/(.*)$/))) {
      const projectId = Number(m[1]);
      const rest = m[2]!;
      if (!state.projects.some((p) => p.id === projectId)) return send(404, { detail: 'Not found.' });

      if (rest === 'features/') {
        if (method === 'GET') {
          const search = url.searchParams.get('search') ?? '';
          const mine = state.features.filter((f) => f.project === projectId && f.name.includes(search));
          // With ?environment, Flagsmith adds the lifecycle stage (features/views.py:318-323) and override count.
          const environment = url.searchParams.get('environment');
          const envKey = state.environments.find((e) => String(e.id) === environment)?.api_key;
          return send(
            200,
            page(
              mine.map((f) => ({
                ...publicFeature(f),
                code_references_counts: [],
                ...(environment
                  ? { lifecycle_stage: lifecycleStage(f), num_segment_overrides: envKey ? (state.flags.get(flagKey(envKey, f.id))?.segment_overrides.length ?? 0) : 0 }
                  : {}),
              })),
            ),
          );
        }
      }
      // Code References (projects/code_references/): a scan, and the latest references per repository for a flag.
      if (rest === 'code-references/' && method === 'POST') {
        const errors: Record<string, unknown> = {};
        try {
          if (!/^https?:$/.test(new URL(body.repository_url).protocol)) throw new Error();
        } catch {
          errors.repository_url = ['Enter a valid URL.'];
        }
        if (!body.revision) errors.revision = ['This field may not be blank.'];
        if (body.vcs_provider !== undefined && body.vcs_provider !== 'github') errors.vcs_provider = [`"${body.vcs_provider}" is not a valid choice.`];
        if (!Array.isArray(body.code_references)) errors.code_references = ['This field is required.'];
        else if (body.code_references.some((r: { line_number: number }) => !(r.line_number >= 1))) errors.code_references = [{ line_number: ['Ensure this value is greater than or equal to 1.'] }];
        if (Object.keys(errors).length) return send(400, errors);
        const scan = { project: projectId, repositoryUrl: body.repository_url, revision: body.revision, at: new Date(Date.UTC(2026, 10, 17, 0, 0, state.codeScans.length)).toISOString(), references: body.code_references };
        state.codeScans.push(scan);
        return send(201, { created_at: scan.at, project: projectId, repository_url: scan.repositoryUrl, vcs_provider: 'github', revision: scan.revision, code_references: scan.references });
      }
      if ((m = rest.match(/^features\/(\d+)\/code-references\/$/)) && method === 'GET') {
        const feature = state.features.find((f) => f.project === projectId && f.id === Number(m![1]));
        if (!feature) return send(404, { detail: 'Not found.' });
        return send(
          200,
          latestScans(projectId).flatMap((scan) => {
            const refs = scan.references.filter((r) => r.feature_name === feature.name);
            return refs.length
              ? [{
                  repository_url: scan.repositoryUrl,
                  vcs_provider: 'github',
                  revision: scan.revision,
                  last_successful_repository_scanned_at: scan.at,
                  last_feature_found_at: scan.at,
                  code_references: refs.map((r) => ({ ...r, scanned_at: scan.at, vcs_provider: 'github', repository_url: scan.repositoryUrl, revision: scan.revision, permalink: `${scan.repositoryUrl}/blob/${scan.revision}/${r.file_path}#L${r.line_number}` })),
                }]
              : [];
          }),
        );
      }
      if ((m = rest.match(/^features\/(\d+)\/evaluation-data\/$/)) && method === 'GET') {
        if (!url.searchParams.get('environment_id')) return send(400, { environment_id: ['This field is required.'] });
        return send(200, state.evaluations.map((e) => ({ ...e, labels: { client_application_name: null, client_application_version: null, user_agent: null } })));
      }
      if (rest === 'audit/' && method === 'GET') return send(200, page([])); // a free organisation sees 0 days of history
      if (/^integrations\/[\w-]+\/$/.test(rest) && method === 'GET') return send(200, []);
      if (rest === 'features/') {
        if (state.features.some((f) => f.project === projectId && f.name === body.name)) return send(400, { name: ['already exists'] });
        const feature = {
          id: id(),
          name: body.name,
          initial_value: body.initial_value ?? null,
          default_enabled: body.default_enabled ?? false,
          description: body.description,
          multivariate_options: [] as MvOption[],
          tags: [] as number[],
          project: projectId,
        };
        state.features.push(feature);
        for (const env of state.environments.filter((e) => e.project === projectId)) createFlagState(env.api_key, feature);
        return send(201, publicFeature(feature));
      }
      if ((m = rest.match(/^features\/(\d+)\/(?:mv-options\/(?:(\d+)\/)?)?$/))) {
        const feature = state.features.find((f) => f.project === projectId && f.id === Number(m![1]));
        if (!feature) return send(404, { detail: 'Not found.' });
        const isOptions = rest.includes('mv-options/');
        const optionId = m[2] ? Number(m[2]) : undefined;

        if (!isOptions && method === 'PATCH') {
          if (body.tags) feature.tags = body.tags;
          return send(200, publicFeature(feature));
        }
        if (isOptions && optionId === undefined && method === 'POST') {
          const option: MvOption = {
            id: id(),
            key: body.key ?? null,
            string_value: body.string_value ?? null,
            default_percentage_allocation: body.default_percentage_allocation ?? 0,
          };
          feature.multivariate_options.push(option);
          for (const [k, flag] of state.flags) {
            if (k.endsWith(`/${feature.id}`)) flag.environment_default.variants.push({ id: option.id, weight: option.default_percentage_allocation });
          }
          return send(201, { ...option, feature: feature.id, type: body.type });
        }
        if (isOptions && optionId !== undefined) {
          const option = feature.multivariate_options.find((o) => o.id === optionId);
          if (!option) return send(404, { detail: 'Not found.' });
          if (method === 'PATCH') {
            // Flagsmith 2.291.0: the option validator reads every field; a partial body is a KeyError.
            return send(500, '<h1>Server Error (500)</h1>');
          }
          if (method === 'PUT') {
            for (const field of ['feature', 'type', 'string_value', 'default_percentage_allocation']) {
              if (!(field in body)) return send(400, { [field]: ['This field is required.'] });
            }
            const running = state.experiments.find((e) => e.feature.id === feature.id && e.status === 'running');
            if (running) return send(400, { detail: `Experiment ${running.id} is running on this feature.` });
            option.string_value = body.string_value;
            option.default_percentage_allocation = body.default_percentage_allocation;
            option.key = body.key ?? option.key;
            return send(200, { ...option, feature: feature.id, type: body.type });
          }
        }
      }
      if (rest === 'tags/') {
        const mine = state.tags.filter((t) => t.project === projectId);
        if (method === 'GET') return send(200, mine); // bare array
        const tag = { id: id(), label: body.label, color: body.color, description: body.description, is_permanent: body.is_permanent === true, project: projectId };
        state.tags.push(tag);
        return send(201, tag);
      }
      if (rest === 'feature-health/providers/') {
        // Flagsmith builds the URL with its own public host and a secret path.
        const mine = state.healthProviders.filter((p) => p.project === projectId);
        if (method === 'GET') return send(200, mine); // bare array
        const provider = { name: body.name, project: projectId, created_by: null, webhook_url: `http://localhost:8000/api/v1/feature-health/secret${id()}` };
        state.healthProviders.push(provider);
        return send(201, provider);
      }
      if (rest === 'segments/') {
        const mine = state.segments.filter((s) => s.project === projectId);
        if (method === 'GET') return send(200, page(mine));
        const segment = { id: id(), name: body.name, project: projectId, description: body.description, rules: body.rules };
        state.segments.push(segment);
        return send(201, segment);
      }
      return send(404, { detail: `fake: no route for ${method} ${path}` });
    }

    // The new flag-state API.
    if ((m = path.match(/^\/api\/__future__\/environments\/([^/]+)\/features\/(\d+)\/$/))) {
      const flag = state.flags.get(flagKey(m[1]!, Number(m[2])));
      if (!flag) return send(404, { detail: 'Not found.' });
      if (method === 'GET') return send(200, flag);
      if (method === 'PATCH') {
        const d = body.environment_default;
        if (d) {
          if ('enabled' in d) flag.environment_default.enabled = d.enabled;
          if (d.value) flag.environment_default.value = d.value;
          if (d.variants) {
            for (const v of d.variants as { id: number; weight: number }[]) {
              const existing = flag.environment_default.variants.find((x) => x.id === v.id);
              if (existing) existing.weight = v.weight;
              else flag.environment_default.variants.push({ ...v });
            }
          }
        }
        for (const o of (body.segment_overrides ?? []) as Override[]) {
          const clash = flag.segment_overrides.find((x) => x.priority === o.priority && x.segment.id !== o.segment.id);
          if (clash) return send(400, { detail: `Priority ${o.priority} is already used by segment ${clash.segment.id}.` });
          const i = flag.segment_overrides.findIndex((x) => x.segment.id === o.segment.id);
          if (i >= 0) flag.segment_overrides[i] = structuredClone(o);
          else flag.segment_overrides.push(structuredClone(o));
        }
        return send(200, flag);
      }
    }

    send(404, { detail: `fake: no route for ${method} ${path}` });
  });

  // Each repository's latest scan in a project (Flagsmith keeps rows whose created_at is the repository's last scan).
  function latestScans(projectId: number): CodeScan[] {
    const byRepo = new Map<string, CodeScan>();
    for (const scan of state.codeScans.filter((s) => s.project === projectId)) byRepo.set(scan.repositoryUrl, scan);
    return [...byRepo.values()];
  }

  // features/feature_lifecycle/services.py:42-80, without stale tags or usage: a permanent tag wins, then code references.
  function lifecycleStage(feature: FakeAdminState['features'][number]): string {
    if (state.tags.some((t) => feature.tags.includes(t.id) && t.is_permanent)) return 'permanent';
    const inCode = latestScans(feature.project).some((s) => s.references.some((r) => r.feature_name === feature.name));
    return inCode ? 'live' : 'new';
  }

  function createFlagState(envKey: string, feature: FakeAdminState['features'][number]): void {
    state.flags.set(flagKey(envKey, feature.id), {
      environment_default: {
        enabled: feature.default_enabled,
        value: { type: 'string', value: feature.initial_value ?? '' },
        variants: feature.multivariate_options.map((o) => ({ id: o.id, weight: o.default_percentage_allocation })),
      },
      segment_overrides: [],
    });
  }

  // Starting an experiment drops any earlier experiment's rollout override on the flag (Flagsmith #8770) and adds
  // this one's below the existing overrides.
  function startRollout(envKey: string, experiment: FakeExperiment): void {
    const flag = state.flags.get(flagKey(envKey, experiment.feature.id))!;
    const rolloutIds = new Set(state.segments.filter((s) => /^experiment-\d+-rollout$/.test(s.name)).map((s) => s.id));
    flag.segment_overrides = flag.segment_overrides.filter((o) => !rolloutIds.has(o.segment.id));
    const segment = { id: id(), name: `experiment-${experiment.id}-rollout`, project: state.features.find((f) => f.id === experiment.feature.id)!.project, rules: [] };
    state.segments.push(segment);
    const rollout = experiment.experiment_rollout!;
    flag.segment_overrides.push({
      segment: { id: segment.id },
      priority: Math.max(-1, ...flag.segment_overrides.map((o) => o.priority)) + 1,
      enabled: rollout.enabled,
      variants: rollout.multivariate_feature_state_values.map((v) => ({ id: v.multivariate_feature_option, weight: v.percentage_allocation })),
    });
  }

  // Only what check's analyze() reads: each segment's overrides, with the rollout's split and the experiment metadata
  // Flagsmith attaches while the experiment runs.
  function environmentDocument(envKey: string) {
    const env = state.environments.find((e) => e.api_key === envKey)!;
    const segments = state.segments.filter((s) => s.project === env.project).map((s) => {
      const experiment = state.experiments.find((e) => e.envKey === envKey && s.name === `experiment-${e.id}-rollout`);
      const feature_states = [...state.flags].flatMap(([k, flag]) => {
        if (!k.startsWith(`${envKey}/`)) return [];
        const feature = state.features.find((f) => f.id === Number(k.split('/')[1]))!;
        return flag.segment_overrides.filter((o) => o.segment.id === s.id).map((o) => ({
          feature: { name: feature.name },
          enabled: o.enabled,
          metadata: experiment?.status === 'running' ? { experiment: { id: experiment.id } } : null,
          multivariate_feature_state_values: o.variants.map((v) => ({
            multivariate_feature_option: { key: feature.multivariate_options.find((m) => m.id === v.id)?.key ?? null },
            percentage_allocation: v.weight,
          })),
        }));
      });
      const rules = experiment ? [{ conditions: [{ operator: 'PERCENTAGE_SPLIT', value: String(experiment.experiment_rollout?.rollout_percentage ?? 100) }] }] : s.rules;
      return { id: s.id, name: s.name, rules, feature_states };
    });
    return { api_key: envKey, project: { segments } };
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    apiUrl: `http://127.0.0.1:${port}/api/v1/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function publicFeature(f: FakeAdminState['features'][number]): Feature & { project: number } {
  return { id: f.id, name: f.name, initial_value: f.initial_value, multivariate_options: structuredClone(f.multivariate_options), tags: [...f.tags], project: f.project };
}

function featureView(f: FakeAdminState['features'][number]): ExperimentDetail['feature'] {
  return {
    id: f.id,
    name: f.name,
    initial_value: f.initial_value,
    multivariate_options: f.multivariate_options.map((o) => ({ id: o.id, key: o.key, string_value: o.string_value })),
  };
}

function publicExperiment({ envKey: _, ...e }: FakeExperiment): ExperimentDetail {
  return structuredClone(e);
}

function summary(e: FakeExperiment) {
  return { id: e.id, name: e.name, status: e.status, feature: { id: e.feature.id, name: e.feature.name } };
}

// Helpers for tests.
export const writes = (state: FakeAdminState) => state.requests.filter((r) => r.method !== 'GET');
export const calls = (state: FakeAdminState, method: string, pattern: RegExp) =>
  state.requests.filter((r) => r.method === method && pattern.test(r.path));

// A project as `switchyard init` leaves it, with its first experiment already completed (drained override kept,
// as Flagsmith does): shop_release, control shop:1.4, v2 → shop:1.5, three metrics.
export const SEED = { envKey: 'envKeySeed', adminKey: 'org.seed', projectId: 2, featureId: 4, v2Id: 5, experimentId: 9, rolloutSegmentId: 10 };
export function seededState(opts: { experimentStatus?: FakeExperiment['status'] } = {}): FakeAdminState {
  const state = emptyState({ hasUsers: true, adminKeys: [SEED.adminKey] });
  state.organisations.push({ id: 1, name: 'Switchyard' });
  state.projects.push({ id: SEED.projectId, name: 'Switchyard demo', organisation: 1 });
  state.environments.push({ id: 3, name: 'Production', api_key: SEED.envKey, project: SEED.projectId });
  const v2 = { id: SEED.v2Id, key: 'v2', string_value: 'shop:1.5', default_percentage_allocation: 0 };
  state.features.push({
    id: SEED.featureId,
    name: 'shop_release',
    initial_value: 'shop:1.4',
    default_enabled: true,
    multivariate_options: [v2],
    tags: [],
    project: SEED.projectId,
  });
  state.metrics.push(
    { id: 6, name: 'order_placed', aggregation: 'occurrence', direction: 'up', definition: { event: 'order_placed' }, envKey: SEED.envKey },
    { id: 7, name: 'doc_latency_ms', aggregation: 'mean', direction: 'down', definition: { event: 'doc_latency_ms' }, envKey: SEED.envKey },
    { id: 8, name: 'server_error', aggregation: 'mean', direction: 'down', definition: { event: 'server_error' }, envKey: SEED.envKey },
  );
  const status = opts.experimentStatus ?? 'completed';
  state.experiments.push({
    id: SEED.experimentId,
    envKey: SEED.envKey,
    name: 'shop_release: shop:1.5 vs shop:1.4',
    hypothesis: 'shop:1.5 raises order_placed',
    status,
    feature: { id: SEED.featureId, name: 'shop_release', initial_value: 'shop:1.4', multivariate_options: [{ id: v2.id, key: 'v2', string_value: 'shop:1.5' }] },
    metrics: [
      { metric: 6, metric_name: 'order_placed', aggregation: 'occurrence', direction: 'up', expected_direction: 'increase' },
      { metric: 7, metric_name: 'doc_latency_ms', aggregation: 'mean', direction: 'down', expected_direction: 'not_increase' },
      { metric: 8, metric_name: 'server_error', aggregation: 'mean', direction: 'down', expected_direction: 'not_increase' },
    ],
    experiment_rollout: {
      enabled: true,
      rollout_percentage: status === 'completed' ? 0 : 100,
      feature_state_value: { type: 'string', value: 'shop:1.4' },
      multivariate_feature_state_values: [{ multivariate_feature_option: v2.id, percentage_allocation: 50 }],
    },
    started_at: '2026-11-16T00:00:00Z',
    ended_at: status === 'completed' ? '2026-11-17T00:00:00Z' : null,
  });
  state.segments.push({ id: SEED.rolloutSegmentId, name: `experiment-${SEED.experimentId}-rollout`, project: SEED.projectId, rules: [] });
  state.flags.set(flagKey(SEED.envKey, SEED.featureId), {
    environment_default: { enabled: true, value: { type: 'string', value: 'shop:1.4' }, variants: [{ id: v2.id, weight: 0 }] },
    segment_overrides: [{ segment: { id: SEED.rolloutSegmentId }, priority: 0, enabled: true, variants: [{ id: v2.id, weight: 50 }] }],
  });
  state.nextId = 100;
  return state;
}

// Shipping v2 in place: the environment default serves v2 to everyone.
export function shipV2(state: FakeAdminState): void {
  state.flags.get(flagKey(SEED.envKey, SEED.featureId))!.environment_default.variants = [{ id: SEED.v2Id, weight: 100 }];
}
