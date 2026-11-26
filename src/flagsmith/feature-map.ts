// The Flagsmith feature map: every menu of Flagsmith's project dashboard and every integration it lists, with what
// Turnover does with each (or why not here), a link into the dashboard, and a live value read from the Admin API.
//
// buildFlagsmithMap() is pure: it turns the facts into the map. readMapFacts() gathers the facts; each read is
// optional, so one refused or missing endpoint blanks one value instead of the page.
//
// Every "not available here" item names the Flagsmith 2.291.0 source it rests on (paths under api/ unless they
// start with frontend/; frontend paths are from the image's own source map, /app/static/main.*.js.map).
// Dashboard routes: frontend/web/routes.js:64-146. A flag opens with ?feature=<id>&tab=<tab>
// (frontend/web/components/feature-summary/FeatureRow.tsx:297-302; tab names: navigation/TabMenu/Tabs.tsx:58-66).
import { readLedger } from '../ledger.ts';
import type { AdminClient } from './admin.ts';
import type { Experiments } from './experiments.ts';

export type MapStatus = 'used' | 'used-read-only' | 'not-available-locally' | 'not-used';
export type MapItem = {
  id: string;
  kind: 'menu' | 'integration' | 'feature';
  name: string;
  status: MapStatus;
  what: string; // one plain sentence: what Turnover does with it, or why not here
  live: string | null; // a value read from Flagsmith just now
  link: string | null; // into Flagsmith's dashboard
  needs?: string; // for not-available-locally: what it would take
  source?: string; // Flagsmith 2.291.0 source the claim rests on
  details?: { text: string; href?: string }[];
};
export type FlagsmithMap = {
  generatedAt: string;
  flagsmith: { version: string | null; dashboardUrl: string; projectId: number | null; environment: string | null; flag: string };
  counts: Record<MapStatus, number>;
  items: MapItem[];
};

export type CodeRefRepo = { repositoryUrl: string; revision: string; scannedAt: string; references: { file: string; line: number; permalink: string }[] };

export type MapFacts = {
  flag: string;
  envKey: string;
  version: { imageTag: string; isEnterprise: boolean } | null;
  environment: { id: number; name: string; project: number } | null;
  environments: number | null;
  feature: {
    id: number;
    initialValue: string | null;
    variants: { key: string; value: string | null }[];
    tagIds: number[];
    lifecycleStage: string | null;
    segmentOverrides: number | null;
  } | null;
  tags: { id: number; label: string; isPermanent: boolean }[] | null;
  segments: { id: number; name: string }[] | null;
  lifecycleCounts: Record<string, number> | null;
  codeReferences: CodeRefRepo[] | null;
  healthProviders: string[] | null;
  auditVisible: number | null;
  evaluations: { days: number; total: number } | null;
  experiment: { id: number; name: string; status: string } | null;
  experimentsOnFlag: number | null;
  metrics: string[] | null;
  eventStore: string | null;
  events: { accepted: number; rejected: number } | null;
  ledgerEntries: number | null;
  integrations: Record<string, number | null> | null; // configurations per integration id, read from its own endpoint
};

export const PREVIEW_SEGMENT = 'turnover-preview';
export const EVALUATION_DAYS = 7;
const APP_DIRS = ['demo/']; // where this repository keeps the app; the flag's name should never appear there

// Lifecycle stage → the Lifecycle page's section (frontend/web/components/pages/feature-lifecycle/constants.tsx:7-14).
const STAGE_SECTION: Record<string, string> = { new: 'new', live: 'live', stale: 'stale', permanent: 'permanent', needs_monitoring: 'monitor', to_remove: 'remove' };

const SSRF = 'core/fields.py:24-28 (NoSSRFURLField), core/validators.py:22-31, core/network.py:8-34';
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fmt = (n: number) => n.toLocaleString('en-US');

export function buildFlagsmithMap(f: MapFacts, opts: { dashboardUrl: string; now?: Date }): FlagsmithMap {
  const dash = opts.dashboardUrl.replace(/\/+$/, '');
  const p = f.environment?.project ?? null;
  const proj = (path: string) => (p === null ? null : `${dash}/project/${p}${path}`);
  const env = (path: string) => proj(`/environment/${encodeURIComponent(f.envKey)}${path}`);
  const flagLink = (tab?: string) => (f.feature ? env(`/features?feature=${f.feature.id}${tab ? `&tab=${tab}` : ''}`) : env('/features'));
  const integrationsLink = proj('/integrations');
  const flagTags = f.feature && f.tags ? f.tags.filter((t) => f.feature!.tagIds.includes(t.id)) : null;
  const items: MapItem[] = [];

  // ---- the project menu (frontend/web/components/navigation/navbars/ProjectNavbar.tsx:35-132) ----

  items.push({
    id: 'menu.environments',
    kind: 'menu',
    name: 'Environments',
    status: 'used',
    what: `The flag lives in the ${f.environment?.name ?? 'Production'} environment; its environment default is what Ship winner and Revert set, and what everyone outside an experiment is served.`,
    live: f.environments === null ? null : `${plural(f.environments, 'environment')}${f.environment ? `; Turnover uses ${f.environment.name}` : ''}`,
    link: flagLink(),
  });

  const preview = f.segments?.find((s) => s.name === PREVIEW_SEGMENT);
  items.push({
    id: 'menu.segments',
    kind: 'menu',
    name: 'Segments',
    status: 'used',
    what: `"turnover preview" adds the ${PREVIEW_SEGMENT} segment (trait preview = true), whose override serves the next release to your team ahead of the experiment; each experiment's split is Flagsmith's own experiment-<id>-rollout segment.`,
    live:
      f.segments === null
        ? null
        : `${plural(f.segments.length, 'segment')}${preview ? `, including ${PREVIEW_SEGMENT}` : ` (${PREVIEW_SEGMENT} appears after the first "turnover preview")`}` +
          (f.feature?.segmentOverrides != null ? `; ${plural(f.feature.segmentOverrides, 'segment override')} on ${f.flag}` : ''),
    link: preview ? proj(`/segments/${preview.id}`) : proj('/segments'),
    source: 'features/feature_segments/services.py:69-75 (override priority)',
  });

  const stage = f.feature?.lifecycleStage ?? null;
  const counts = f.lifecycleCounts
    ? Object.entries(f.lifecycleCounts).filter(([, n]) => n > 0).map(([k, n]) => `${k.replace('_', ' ')} ${n}`).join(', ')
    : null;
  items.push({
    id: 'menu.lifecycle',
    kind: 'menu',
    name: 'Lifecycle',
    status: 'used-read-only',
    what: `Turnover's init tags the flag "release", a permanent tag, so Lifecycle files it under Permanent and stale-flag detection leaves it alone; the Code References scan feeds the same page.`,
    live: stage || counts ? [stage ? `${f.flag} is ${stage.replace('_', ' ')}` : null, counts ? `project: ${counts}` : null].filter(Boolean).join('; ') : null,
    link: proj(`/lifecycle${stage && STAGE_SECTION[stage] ? `/${STAGE_SECTION[stage]}` : ''}`),
    source: 'features/feature_lifecycle/services.py:42-80 (a permanent tag wins over code references)',
  });

  items.push({
    id: 'menu.audit-log',
    kind: 'menu',
    name: 'Audit Log',
    status: 'not-available-locally',
    needs: 'a plan with audit history',
    what: "Flagsmith records every change Turnover makes, but shows audit history only for plans with a visibility window; a free organisation's window is 0 days, so this page is empty here and Turnover's release ledger (.turnover/ledger.jsonl) is the record.",
    live:
      f.auditVisible === null && f.ledgerEntries === null
        ? null
        : [f.auditVisible === null ? null : `${plural(f.auditVisible, 'entry', 'entries')} visible through the API`, f.ledgerEntries === null ? null : `${plural(f.ledgerEntries, 'decision')} in Turnover's ledger`]
            .filter(Boolean)
            .join('; '),
    link: proj('/audit-log'),
    source: 'organisations/models.py:424-429 (free plan metadata), organisations/subscriptions/metadata.py:15 (audit_log_visibility_days = 0), audit/views.py:84-91',
  });

  items.push({
    id: 'menu.change-requests',
    kind: 'menu',
    name: 'Segment Change Requests',
    status: 'not-available-locally',
    needs: "Flagsmith's Enterprise image",
    what: "Four-eyes approval comes from Flagsmith's workflows module, which ships in the Enterprise image, so this open-source image doesn't register the change-requests API; in Turnover a person confirms every Ship and Revert instead.",
    live: f.version ? `this image: ${f.version.imageTag}, is_enterprise ${String(f.version.isEnterprise)}` : null,
    link: proj('/change-requests'),
    source: 'app/settings/common.py:1116-1119 (workflows_logic only when installed), projects/urls.py:105-111',
  });

  const refRepos = f.codeReferences ?? [];
  const refCount = refRepos.reduce((n, r) => n + r.references.length, 0);
  items.push({
    id: 'menu.integrations',
    kind: 'menu',
    name: 'Integrations',
    status: 'used-read-only',
    what: 'Turnover configures nothing on this page; of the 18 integrations it lists, Code References runs live, and the rest send to or install from outside services (each one is below, with what it needs).',
    live: f.codeReferences === null ? null : `Code References: ${plural(refCount, 'reference')} from ${plural(refRepos.length, 'repository', 'repositories')}`,
    link: integrationsLink,
  });

  items.push({
    id: 'menu.compare',
    kind: 'menu',
    name: 'Compare',
    status: 'not-used',
    what: 'Compare puts environments or flags side by side; the demo runs a single environment, so there is nothing to compare yet.',
    live: f.environments === null ? null : plural(f.environments, 'environment'),
    link: proj('/compare'),
  });

  items.push({
    id: 'menu.project-settings',
    kind: 'menu',
    name: 'Project Settings',
    status: 'used',
    what: "Turnover's init creates the Webhook provider under Project Settings → Feature Health; Turnover posts the release flag's health to it.",
    live: f.healthProviders === null ? null : f.healthProviders.length ? `Feature Health providers: ${f.healthProviders.join(', ')}` : 'no Feature Health provider yet (run init)',
    link: proj('/settings?tab=feature-health'),
  });

  // ---- integrations (frontend/common/stores/default-flags.ts:2-373, integration_data) ----

  const appRefs = refRepos.flatMap((r) => r.references).filter((r) => APP_DIRS.some((d) => r.file.startsWith(d)));
  items.push({
    id: 'integration.code-references',
    kind: 'integration',
    name: 'Code References',
    status: refRepos.length ? 'used' : 'not-used',
    what: refRepos.length
      ? `Turnover scans the repository for "${f.flag}" and submits what it finds: the name lives in infrastructure config, never in the app (${appRefs.length ? `${plural(appRefs.length, 'reference')} in app code` : 'none in demo/'}).`
      : 'Run "turnover code-refs" (or the GitHub Action) with a GitHub repository URL to submit a scan; Flagsmith then shows where the flag appears on its Usage tab.',
    live: f.codeReferences === null ? null : refRepos.length ? `${plural(refCount, 'reference')}: ${refRepos.flatMap((r) => r.references.map((x) => `${x.file}:${x.line}`)).join(', ') || 'none'}` : `no references to ${f.flag} recorded yet`,
    link: flagLink('usage'),
    source: 'projects/code_references/views.py:32-71, services.py:117-196',
    details: refRepos.flatMap((r) => r.references.map((x) => ({ text: `${x.file}:${x.line} @ ${r.revision.slice(0, 12)}`, href: x.permalink }))),
  });

  const outbound = (
    id: string,
    name: string,
    needs: string,
    what: string,
    source: string,
  ): MapItem => {
    const configured = f.integrations?.[id];
    const live = configured == null ? null : configured === 0 ? 'none configured on this instance' : `${configured} configured on this instance`;
    return { id: `integration.${id}`, kind: 'integration', name, status: 'not-available-locally', needs, what, live, link: integrationsLink, source };
  };
  const vendor = (name: string, does: string) =>
    `${does}; it needs ${/^[AEIOU]/.test(name) ? 'an' : 'a'} ${name} account, and Flagsmith refuses a base URL that resolves to a private address, so nothing on this laptop can stand in for it.`;

  items.push(
    outbound('amplitude', 'Amplitude', 'an Amplitude account', vendor('Amplitude', 'Sends which flags each identity was served to Amplitude'), `integrations/amplitude/models.py:9-10, integrations/common/models.py:19; ${SSRF}`),
    outbound('backstage', 'Backstage', 'a Backstage portal', 'A plugin for your Backstage developer portal that reads flags from Flagsmith; it installs on the Backstage side, and the demo has no portal.', 'frontend/common/stores/default-flags.ts:28-37 (external: true)'),
    outbound('datadog', 'Datadog', 'a Datadog account', vendor('Datadog', 'Sends flag change events to Datadog'), `integrations/datadog/models.py:12-16; ${SSRF}`),
    outbound('dynatrace', 'Dynatrace', 'a Dynatrace account', vendor('Dynatrace', 'Sends flag change events to Dynatrace'), `integrations/dynatrace/models.py:11, integrations/common/models.py:19; ${SSRF}`),
    outbound(
      'mcp',
      'Flagsmith MCP Server',
      'an MCP server deployment',
      "Lets AI assistants manage flags; the hosted server talks to Flagsmith's SaaS, and a self-hosted Flagsmith needs its own MCP server deployment. The endpoints this map reads (lifecycle counts, code references, evaluation data) are the ones Flagsmith tags for it.",
      'frontend/web/components/integrations/mcp/mcpSnippets.tsx:3-13; projects/code_references/views.py:84-88, features/feature_lifecycle/views.py:29-37 (tags=["mcp"])',
    ),
    outbound(
      'github',
      'GitHub',
      'a GitHub App',
      "Links GitHub issues and pull requests to flags through a GitHub App, which a self-hosted Flagsmith must register itself (GITHUB_APP_ID, GITHUB_PEM); Turnover writes its release notes to GitHub Releases on its own, with GITHUB_TOKEN.",
      'app/settings/common.py:1092-1093, integrations/github/client.py:38-68',
    ),
    outbound('gitlab', 'GitLab', 'a GitLab instance on a public address', 'Links GitLab issues and merge requests to flags; Flagsmith calls the GitLab instance URL, which must not resolve to a private address.', `integrations/gitlab/models.py:13; ${SSRF}`),
    outbound(
      'grafana',
      'Grafana',
      'a Grafana instance on a public address',
      'Annotates Grafana dashboards on flag and segment changes; Flagsmith refuses a base URL that resolves to a loopback or private address, so a Grafana on this laptop cannot receive them.',
      `integrations/grafana/models.py:41-53, integrations/common/models.py:19; ${SSRF}`,
    ),
    outbound('heap', 'Heap', 'a Heap account', vendor('Heap', 'Sends which flags each identity was served to Heap'), `integrations/heap/models.py:7, integrations/common/models.py:19; ${SSRF}`),
    outbound('jira', 'Jira', 'a Jira site', "Shows flags inside Jira issues; it installs from Atlassian's side, and the demo has no Jira site.", 'frontend/common/stores/default-flags.ts:199-209 (external: true)'),
    outbound('mixpanel', 'Mixpanel', 'a Mixpanel account', vendor('Mixpanel', 'Sends which flags each identity was served to Mixpanel'), `integrations/mixpanel/models.py:7, integrations/common/models.py:19; ${SSRF}`),
    outbound('new-relic', 'New Relic', 'a New Relic account', vendor('New Relic', 'Sends flag change events to New Relic'), `integrations/new_relic/models.py:11, integrations/common/models.py:19; ${SSRF}`),
    outbound('rudderstack', 'Rudderstack', 'a Rudderstack account', vendor('Rudderstack', 'Sends which flags each identity was served to Rudderstack'), `integrations/rudderstack/models.py:7, integrations/common/models.py:19; ${SSRF}`),
    outbound('segment', 'Segment', 'a Segment account', vendor('Segment', 'Sends which flags each identity was served to Segment'), `integrations/segment/models.py:7, integrations/common/models.py:19; ${SSRF}`),
    outbound('sentry', 'Sentry', 'a Sentry webhook on a public address', 'Sends flag change events to a Sentry webhook URL, which must not resolve to a private address.', `integrations/sentry/models.py:21-23; ${SSRF}`),
    outbound(
      'slack',
      'Slack',
      'a Slack app',
      'Posts flag changes to a Slack channel through OAuth with a Slack app; a self-hosted Flagsmith needs its own app credentials (SLACK_CLIENT_ID), and without them it answers "Slack is not configured".',
      'app/settings/common.py:1089-1090, integrations/slack/views.py:109-113',
    ),
    outbound(
      'webhook',
      'Webhook',
      'a public HTTPS endpoint',
      "Sends flag evaluations to a URL you provide, which Flagsmith refuses when it resolves to a loopback or private address; Turnover's Feature Health webhook goes the other way, from Turnover into Flagsmith.",
      `integrations/webhook/models.py:13-16, webhooks/models.py:7-8, 22-24; ${SSRF}`,
    ),
  );

  // ---- features without a menu of their own ----

  items.push({
    id: 'feature.multivariate-flag',
    kind: 'feature',
    name: 'Multivariate flag',
    status: 'used',
    what: `Each variant's value of ${f.flag} names a release; the proxy routes every visitor to the container for the value Flagsmith gives it.`,
    live: f.feature ? [`control → ${f.feature.initialValue ?? '?'}`, ...f.feature.variants.map((v) => `${v.key} → ${v.value ?? '?'}`)].join(' · ') : null,
    link: flagLink('value'),
  });
  items.push({
    id: 'feature.experiments',
    kind: 'feature',
    name: 'Experiments',
    status: 'used',
    what: 'Every release is the next experiment on the same flag; Flagsmith splits the traffic and computes the Bayesian result, and Turnover never computes its own statistics.',
    live: f.experiment ? `experiment ${f.experiment.id} is ${f.experiment.status}${f.experimentsOnFlag ? `; ${plural(f.experimentsOnFlag, 'experiment')} on ${f.flag} so far` : ''}` : null,
    link: f.experiment ? env(`/experiments/${f.experiment.id}`) : env('/experiments'),
    source: 'experimentation/services.py:484-507, 757-775',
  });
  items.push({
    id: 'feature.metrics',
    kind: 'feature',
    name: 'Metrics',
    status: 'used',
    what: 'The goal (orders, counted) and two guardrails (page latency and server errors, lower is better) are Flagsmith metrics; the proxy turns HTTP into their events.',
    live: f.metrics ? (f.metrics.length ? f.metrics.join(', ') : 'none yet (run init)') : null,
    link: env('/metrics'),
  });
  items.push({
    id: 'feature.event-store',
    kind: 'feature',
    name: 'Event store',
    status: 'used',
    what: "Turnover's init connects Flagsmith's own event store (its Postgres database), which experiment events need before Flagsmith accepts them.",
    live: f.eventStore ? `warehouse connection: ${f.eventStore}` : null,
    link: null,
  });
  const unhealthy = flagTags?.some((t) => t.label === 'Unhealthy') ?? false;
  items.push({
    id: 'feature.feature-health',
    kind: 'feature',
    name: 'Feature Health',
    status: 'used',
    what: "While an experiment runs, Turnover reports the release flag's health; a losing guardrail makes Flagsmith tag the flag Unhealthy, with Flagsmith's numbers as the reason.",
    live:
      f.healthProviders === null && !flagTags
        ? null
        : [f.healthProviders?.length ? `provider: ${f.healthProviders.join(', ')}` : null, flagTags ? (unhealthy ? `${f.flag} is tagged Unhealthy` : `${f.flag} is healthy (no Unhealthy tag)`) : null]
            .filter(Boolean)
            .join('; '),
    link: flagLink('health'),
    source: 'features/feature_health/providers/webhook/, features/feature_health/constants.py',
  });
  items.push({
    id: 'feature.tags',
    kind: 'feature',
    name: 'Tags',
    status: 'used',
    what: `Turnover's init adds the permanent "release" tag; Feature Health adds and removes the Unhealthy system tag.`,
    live: flagTags ? (flagTags.length ? flagTags.map((t) => `${t.label}${t.isPermanent ? ' (permanent)' : ''}`).join(', ') : 'no tags') : null,
    link: flagLink('settings'),
    source: 'projects/tags/models.py:27-30',
  });
  items.push({
    id: 'feature.flag-analytics',
    kind: 'feature',
    name: 'Flag Analytics',
    status: 'used',
    what: "The proxy's SDK reports how often it evaluated the flag; Flagsmith charts it on the flag's Usage tab.",
    live: f.evaluations ? `${fmt(f.evaluations.total)} evaluations in the last ${plural(f.evaluations.days, 'day')}` : null,
    link: flagLink('usage'),
  });
  items.push({
    id: 'feature.prometheus',
    kind: 'feature',
    name: 'Prometheus events counter',
    status: 'used-read-only',
    what: "The console reads Flagsmith's own count of accepted and rejected experiment events from its Prometheus endpoint, so the numbers are Flagsmith's.",
    live: f.events ? `accepted ${fmt(f.events.accepted)} · rejected ${fmt(f.events.rejected)}` : null,
    link: null,
    source: 'experimentation/metrics.py:12-13',
  });

  const tally: Record<MapStatus, number> = { used: 0, 'used-read-only': 0, 'not-available-locally': 0, 'not-used': 0 };
  for (const item of items) tally[item.status]++;
  return {
    generatedAt: (opts.now ?? new Date()).toISOString(),
    flagsmith: { version: f.version?.imageTag ?? null, dashboardUrl: dash, projectId: p, environment: f.environment?.name ?? null, flag: f.flag },
    counts: tally,
    items,
  };
}

// ---- reading the facts --------------------------------------------------------------------------------------------

const maybe = async <T>(read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch {
    return null;
  }
};

type FeatureRow = {
  id: number;
  name: string;
  initial_value: string | null;
  tags: number[];
  multivariate_options: { key: string | null; string_value: string | null }[];
  lifecycle_stage?: string | null;
  num_segment_overrides?: number | null;
};

export async function readMapFacts(o: {
  api: AdminClient;
  envKey: string;
  flag: string;
  experiment?: { id: number; name: string; status: string } | null;
  readEvents?: () => Promise<{ accepted: number; rejected: number } | null>;
  ledgerDir?: string;
}): Promise<MapFacts> {
  const { api, envKey, flag } = o;
  const count = (path: string | null) => (path ? maybe(async () => (await api.list<unknown>(path)).length) : null);
  // Three rounds, each read in parallel: what needs only the environment key, then what needs the project and
  // environment ids, then what needs the feature id or the organisation.
  const [version, environment, experiments, metrics, warehouses, events, envIntegrationCounts] = await Promise.all([
    maybe(() => api.get<{ image_tag?: string; is_enterprise?: boolean }>('/version/')),
    maybe(() => api.get<{ id: number; name: string; project: number }>(`/api/v1/environments/${envKey}/`)),
    maybe(() => api.list<{ id: number; name: string; status: string; feature: { name: string } }>(`/api/v1/environments/${envKey}/experiments/`)),
    maybe(() => api.list<{ name: string }>(`/api/v1/environments/${envKey}/experiment-metrics/`)),
    maybe(() => api.list<{ status: string }>(`/api/v1/environments/${envKey}/warehouse-connections/`)),
    o.readEvents ? maybe(o.readEvents) : null,
    Promise.all(ENV_INTEGRATIONS.map((id) => count(`/api/v1/environments/${envKey}/integrations/${id}/`))),
  ]);
  const p = environment?.project;
  const e = environment?.id;
  const projectPath = `/api/v1/projects/${p}`;

  const [featureRow, environments, tags, segments, lifecycleCounts, healthProviders, audit, organisation, projectIntegrationCounts] = await Promise.all([
    // With ?environment, the features list adds each flag's lifecycle stage (features/views.py:318-323).
    p && e
      ? maybe(async () => (await api.list<FeatureRow>(`${projectPath}/features/?environment=${e}&search=${encodeURIComponent(flag)}`)).find((x) => x.name === flag) ?? null)
      : null,
    p ? count(`/api/v1/environments/?project=${p}`) : null,
    p ? maybe(() => api.list<{ id: number; label: string; is_permanent: boolean }>(`${projectPath}/tags/`)) : null,
    p ? maybe(() => api.list<{ id: number; name: string }>(`${projectPath}/segments/`)) : null,
    e ? maybe(() => api.get<Record<string, number>>(`/api/v1/environments/${e}/feature-lifecycle-counts/`)) : null,
    p ? maybe(() => api.list<{ name: string }>(`${projectPath}/feature-health/providers/`)) : null, // never pass on webhook_url
    p ? maybe(() => api.get<{ count?: number; results?: unknown[] }>(`${projectPath}/audit/`)) : null,
    p ? maybe(() => api.get<{ organisation: number }>(`${projectPath}/`)) : null,
    Promise.all(PROJECT_INTEGRATIONS.map((id) => count(p ? `${projectPath}/integrations/${id}/` : null))),
  ]);
  const fid = featureRow?.id;

  const [codeReferences, evaluations, githubCount] = await Promise.all([
    p && fid
      ? maybe(() =>
          api.get<{ repository_url: string; revision: string; last_successful_repository_scanned_at: string; code_references: { file_path: string; line_number: number; permalink: string }[] }[]>(
            `${projectPath}/features/${fid}/code-references/`,
          ),
        )
      : null,
    p && fid && e
      ? maybe(() => api.get<{ day: string; count: number }[]>(`${projectPath}/features/${fid}/evaluation-data/?environment_id=${e}&period=${EVALUATION_DAYS}`))
      : null,
    count(organisation ? `/api/v1/organisations/${organisation.organisation}/integrations/github/` : null),
  ]);

  // How many configurations each outbound integration has here, from its own endpoint
  // (environments/urls.py:80-139, projects/urls.py:60-80, organisations/urls.py:95).
  const integrations: Record<string, number | null> = Object.fromEntries([
    ...ENV_INTEGRATIONS.map((id, i) => [id, envIntegrationCounts[i] ?? null]),
    ...PROJECT_INTEGRATIONS.map((id, i) => [id, projectIntegrationCounts[i] ?? null]),
    ['github', githubCount ?? null],
  ]);

  const onFlag = experiments?.filter((x) => x.feature?.name === flag).sort((a, b) => b.id - a.id) ?? null;
  const latest = o.experiment ?? (onFlag?.[0] ? { id: onFlag[0].id, name: onFlag[0].name, status: onFlag[0].status } : null);
  let ledgerEntries: number | null = null;
  if (o.ledgerDir) {
    try {
      ledgerEntries = readLedger(o.ledgerDir).filter((x) => x.flag === flag).length;
    } catch {
      ledgerEntries = null;
    }
  }

  return {
    flag,
    envKey,
    version: version?.image_tag ? { imageTag: version.image_tag, isEnterprise: version.is_enterprise === true } : null,
    environment: environment ? { id: environment.id, name: environment.name, project: environment.project } : null,
    environments,
    feature: featureRow
      ? {
          id: featureRow.id,
          initialValue: featureRow.initial_value,
          variants: featureRow.multivariate_options.map((m) => ({ key: m.key ?? '?', value: m.string_value })),
          tagIds: featureRow.tags,
          lifecycleStage: featureRow.lifecycle_stage ?? null,
          segmentOverrides: featureRow.num_segment_overrides ?? null,
        }
      : null,
    tags: tags?.map((t) => ({ id: t.id, label: t.label, isPermanent: t.is_permanent === true })) ?? null,
    segments: segments?.map((s) => ({ id: s.id, name: s.name })) ?? null,
    lifecycleCounts,
    codeReferences:
      codeReferences?.map((r) => ({
        repositoryUrl: r.repository_url,
        revision: r.revision,
        scannedAt: r.last_successful_repository_scanned_at,
        references: r.code_references.map((c) => ({ file: c.file_path, line: c.line_number, permalink: c.permalink })),
      })) ?? null,
    healthProviders: healthProviders?.map((h) => h.name) ?? null,
    auditVisible: audit ? (audit.count ?? audit.results?.length ?? null) : null,
    evaluations: evaluations ? { days: EVALUATION_DAYS, total: evaluations.reduce((n, d) => n + (d.count ?? 0), 0) } : null,
    experiment: latest,
    experimentsOnFlag: onFlag?.length ?? null,
    metrics: metrics?.map((m) => m.name) ?? null,
    eventStore: warehouses ? (warehouses[0]?.status ?? 'not connected') : null,
    events,
    ledgerEntries,
    integrations,
  };
}

const ENV_INTEGRATIONS = ['amplitude', 'dynatrace', 'heap', 'mixpanel', 'rudderstack', 'segment', 'sentry', 'slack', 'webhook'];
const PROJECT_INTEGRATIONS = ['datadog', 'new-relic', 'gitlab', 'grafana'];

// The console's reader: the flag and environment come from the experiment it shows. Cached briefly, because
// evaluation data is throttled to 5 reads a minute (app/settings/common.py:389, app_analytics/throttles.py:6-7).
export const MAP_CACHE_MS = 30_000;
export function createMapReader(o: {
  experiments: () => Promise<Experiments>;
  dashboardUrl: string;
  readEvents?: () => Promise<{ accepted: number; rejected: number } | null>;
  ledgerDir?: string;
  now?: () => number;
}): { read: () => Promise<FlagsmithMap>; invalidate: () => void } {
  let cached: { at: number; map: FlagsmithMap } | null = null;
  let pending: Promise<FlagsmithMap> | null = null;
  let generation = 0; // invalidate() bumps it: a read already running then answers its callers but isn't kept
  const now = o.now ?? Date.now;
  return {
    read: async () => {
      if (cached && now() - cached.at < MAP_CACHE_MS) return cached.map;
      if (pending) return pending;
      const mine = generation;
      const read = (async () => {
        try {
          const exps = await o.experiments();
          const detail = await exps.detail();
          const facts = await readMapFacts({
            api: exps.api,
            envKey: exps.ref.envKey,
            flag: detail.feature.name,
            experiment: { id: detail.id, name: detail.name, status: detail.status },
            ...(o.readEvents ? { readEvents: o.readEvents } : {}),
            ...(o.ledgerDir ? { ledgerDir: o.ledgerDir } : {}),
          });
          const map = buildFlagsmithMap(facts, { dashboardUrl: o.dashboardUrl, now: new Date(now()) });
          if (mine === generation) cached = { at: now(), map };
          return map;
        } finally {
          if (mine === generation) pending = null; // after invalidate(), a newer read may be pending: leave it
        }
      })();
      pending = read;
      return read;
    },
    // After a write (Ship, Revert, a judge job): the next read asks Flagsmith again.
    invalidate: () => {
      generation++;
      cached = null;
      pending = null;
    },
  };
}
