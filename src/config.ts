import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

// doc_latency_ms: time to the app's response headers, measured by the proxy. lcp_ms and cls: measured in the visitor's
// own browser (largest contentful paint, cumulative layout shift) by a small script the proxy adds to each page.
export const GUARDRAILS = ['doc_latency_ms', 'server_error', 'lcp_ms', 'cls'] as const;
export type Guardrail = (typeof GUARDRAILS)[number];

export type HttpRule = {
  method: string;
  path: string;
  status: string;
};

export type Config = {
  flag: string;
  // Allowlist: release label → container. The flag's value (e.g. "shop:1.5") picks one; it never carries a URL.
  releases: Map<string, URL>;
  fallback: string; // the first release: served when Flagsmith can't answer or the flag is off
  // when: the request that counts as a conversion. header: the app may also name events itself in an
  // X-Turnout-Event response header. At least one of the two. With no goal in the file, speedOnly: the experiment's
  // primary metric is page speed (doc_latency_ms, lower is better) and server_error stays a guardrail.
  goal: { event: string; when?: HttpRule; header: boolean; speedOnly?: true };
  guardrails: Guardrail[];
  // Secondary metrics (e.g. add_to_cart in a funnel): counted from HTTP rules like the goal and shown next to it,
  // never a guardrail and never the decision. Optional; default none.
  metrics?: { event: string; when: HttpRule }[];
  traffic: number; // % of visitors in the experiment (its rollout); the rest stay on the live release. Default 100.
};

export class ConfigError extends Error {}

export const EVENT_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/;

export function loadConfig(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Docker creates a missing bind-mounted file as a directory.
    if (code === 'ENOENT' || code === 'EISDIR') {
      throw new ConfigError(
        `${path} ${code === 'EISDIR' ? 'is a directory (Docker creates one when the mounted file is missing)' : 'not found'}: ` +
          'mount your turnout.config.yml there (run "turnout new" to write one)',
      );
    }
    throw error;
  }
  return parseConfig(parse(text));
}

export function parseConfig(raw: unknown): Config {
  const doc = asRecord(raw, 'config');

  const flag = asString(doc.flag, 'flag');

  const releases = new Map<string, URL>();
  for (const [label, url] of Object.entries(asRecord(doc.releases, 'releases'))) {
    releases.set(label, asUrl(url, `releases["${label}"]`));
  }
  const fallback = [...releases.keys()][0];
  if (!fallback) throw new ConfigError("releases must list at least one release; the first is served when Flagsmith can't answer");

  if (doc.goal === undefined || doc.goal === null) return parseSpeedOnly(doc, flag, releases, fallback);
  const goal = asRecord(doc.goal, 'goal');
  if (goal.header !== undefined && typeof goal.header !== 'boolean') throw new ConfigError('goal.header must be true or false');
  const header = goal.header === true;
  let rule: HttpRule | undefined;
  if (goal.when !== undefined || !header) {
    const when = asRecord(goal.when, 'goal.when');
    rule = asRule(when, 'goal.when');
  }

  const guardrails = (doc.guardrails ?? []) as unknown[];
  if (!Array.isArray(guardrails)) throw new ConfigError('guardrails must be a list');
  for (const g of guardrails) {
    if (!GUARDRAILS.includes(g as Guardrail)) {
      throw new ConfigError(`unknown guardrail "${String(g)}"; supported: ${GUARDRAILS.join(', ')}`);
    }
  }

  // Flagsmith rejects event names it reserves or can't store; check here so a typo fails at start, not per request.
  const event = asString(goal.event, 'goal.event');
  if (!EVENT_NAME.test(event)) {
    throw new ConfigError(`goal.event must be letters, digits, _ . or - and start with a letter, got "${event}"`);
  }
  if ((GUARDRAILS as readonly string[]).includes(event)) throw new ConfigError(`goal.event "${event}" is a guardrail name`);

  const metricsRaw = doc.metrics ?? [];
  if (!Array.isArray(metricsRaw)) throw new ConfigError('metrics must be a list');
  const metrics: Config['metrics'] = [];
  metricsRaw.forEach((raw: unknown, i) => {
    const m = asRecord(raw, `metrics[${i}]`);
    const name = asString(m.event, `metrics[${i}].event`);
    if (!EVENT_NAME.test(name)) throw new ConfigError(`metrics[${i}].event must be letters, digits, _ . or - and start with a letter, got "${name}"`);
    if (name === event || (GUARDRAILS as readonly string[]).includes(name) || metrics.some((x) => x.event === name)) {
      throw new ConfigError(`metrics[${i}].event "${name}" is already the goal, a guardrail or another metric`);
    }
    metrics.push({ event: name, when: asRule(asRecord(m.when, `metrics[${i}].when`), `metrics[${i}].when`) });
  });

  const traffic = doc.traffic === undefined ? 100 : Number(doc.traffic);
  if (!Number.isFinite(traffic) || traffic <= 0 || traffic > 100) {
    throw new ConfigError(`traffic must be a percentage above 0 and up to 100, got "${String(doc.traffic)}"`);
  }

  return {
    flag,
    releases,
    fallback,
    goal: { event, ...(rule ? { when: rule } : {}), header },
    guardrails: guardrails as Guardrail[],
    metrics,
    traffic,
  };
}

// No goal: a release is judged on page speed (the primary metric) with server errors as the guardrail. A goal can be
// added later; until then nothing about the app needs describing beyond its releases.
export const SPEED_GOAL = 'doc_latency_ms';
function parseSpeedOnly(doc: Record<string, unknown>, flag: string, releases: Map<string, URL>, fallback: string): Config {
  const listed = (doc.guardrails ?? ['server_error']) as unknown[];
  if (!Array.isArray(listed)) throw new ConfigError('guardrails must be a list');
  for (const g of listed) {
    if (!GUARDRAILS.includes(g as Guardrail)) throw new ConfigError(`unknown guardrail "${String(g)}"; supported: ${GUARDRAILS.join(', ')}`);
  }
  if (doc.metrics !== undefined) throw new ConfigError('metrics need a goal: add goal: { event, when } first');
  const traffic = doc.traffic === undefined ? 100 : Number(doc.traffic);
  if (!Number.isFinite(traffic) || traffic <= 0 || traffic > 100) {
    throw new ConfigError(`traffic must be a percentage above 0 and up to 100, got "${String(doc.traffic)}"`);
  }
  return {
    flag,
    releases,
    fallback,
    goal: { event: SPEED_GOAL, header: false, speedOnly: true },
    guardrails: (listed as Guardrail[]).filter((g) => g !== SPEED_GOAL), // page speed is the primary metric here
    metrics: [],
    traffic,
  };
}

/** The goal in words for people ("POST /signup 2xx", "X-Turnout-Event: signup"); null when there is none yet. */
export function describeGoal(g: Config['goal']): string | null {
  if (g.speedOnly) return null;
  const parts = [g.when ? `${g.when.method} ${g.when.path} ${g.when.status}` : '', g.header ? `X-Turnout-Event: ${g.event}` : ''].filter(Boolean);
  return `${g.event} (${parts.join(' or ')})`;
}

/** The hypothesis Turnout writes for a release when nobody gave one. */
export const defaultHypothesis = (release: string, goalEvent: string): string =>
  goalEvent === SPEED_GOAL ? `${release} loads pages faster without more errors` : `${release} raises ${goalEvent} without hurting latency or errors`;

/** Does the proxy send page-load latency (as the speed-only goal or as a guardrail)? */
export const measuresSpeed = (c: Config): boolean => !!c.goal.speedOnly || c.guardrails.includes('doc_latency_ms');
/** Does the proxy add the browser script that measures page speed in real browsers (lcp_ms, cls)? */
export const measuresVitals = (c: Config): boolean => c.guardrails.includes('lcp_ms') || c.guardrails.includes('cls');
/**
 * One event per visitor whose browser reported page speed (an occurrence metric, shown next to the results). Flagsmith
 * counts a visitor with no lcp_ms or cls event as 0 in their means, so versions are only compared on them when about the
 * same share of each version's visitors reported (experiments.ts vitalsComparable).
 */
export const VITALS_REPORTED = 'vitals_reported';

// status: "2xx", "201", or a comma list of those ("2xx,303": a form post that redirects counts too).
const STATUS_RULE = /^[1-5](xx|\d\d)(,[1-5](xx|\d\d))*$/;

function asRule(when: Record<string, unknown>, name: string): HttpRule {
  const rule = {
    method: asString(when.method, `${name}.method`).toUpperCase(),
    path: asString(when.path, `${name}.path`),
    status: String(when.status ?? '2xx').replace(/\s+/g, ''),
  };
  if (!STATUS_RULE.test(rule.status)) {
    throw new ConfigError(`${name}.status must look like 2xx, 201 or "2xx,303", got "${rule.status}"`);
  }
  return rule;
}

export function matchesStatus(rule: string, status: number): boolean {
  const code = String(status);
  return rule.split(',').some((r) => (r.endsWith('xx') ? code[0] === r[0] : code === r));
}

export function matchesRule(rule: HttpRule, method: string, path: string, status: number): boolean {
  if (rule.method !== method.toUpperCase()) return false;
  if (!matchesPath(rule.path, path)) return false;
  return matchesStatus(rule.status, status);
}

// "/checkout" matches exactly; "/fix/*" matches anything under /fix/; "/pricing*" matches /pricing and anything
// starting with it (/pricing/, /pricing.html): the form Try it suggests for a link.
function matchesPath(pattern: string, path: string): boolean {
  const clean = path.split('?')[0] ?? path;
  if (pattern.endsWith('/*')) return clean.startsWith(pattern.slice(0, -1));
  if (pattern.endsWith('*')) return clean.startsWith(pattern.slice(0, -1));
  return clean === pattern;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`${name} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ConfigError(`${name} must be a non-empty string`);
  return value;
}

function asUrl(value: unknown, name: string): URL {
  try {
    const url = new URL(asString(value, name));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
    return url;
  } catch {
    throw new ConfigError(`${name} must be an http(s) URL`);
  }
}

/** A new experiment's metrics from the config: the goal first (Flagsmith's primary), then the funnel metrics, then the guardrails. */
export function experimentMetrics(c: Config): { name: string; expected_direction: string }[] {
  return [
    { name: c.goal.event, expected_direction: c.goal.speedOnly ? 'decrease' : 'increase' },
    ...(c.metrics ?? []).map((m) => ({ name: m.event, expected_direction: 'increase' })),
    ...c.guardrails.filter((g) => g !== c.goal.event).map((g) => ({ name: g, expected_direction: 'not_increase' })),
    ...(measuresVitals(c) ? [{ name: VITALS_REPORTED, expected_direction: 'increase' }] : []), // shown, never a guardrail
  ];
}
