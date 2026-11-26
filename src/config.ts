import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

export const GUARDRAILS = ['doc_latency_ms', 'server_error'] as const;
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
  goal: { event: string; when: HttpRule };
  guardrails: Guardrail[];
  traffic: number; // % of visitors in the experiment (its rollout); the rest stay on the live release. Default 100.
};

export class ConfigError extends Error {}

const EVENT_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/;

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
          'mount your switchyard.config.yml there (run "switchyard new" to write one)',
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

  const goal = asRecord(doc.goal, 'goal');
  const when = asRecord(goal.when, 'goal.when');
  const rule: HttpRule = {
    method: asString(when.method, 'goal.when.method').toUpperCase(),
    path: asString(when.path, 'goal.when.path'),
    status: String(when.status ?? '2xx'),
  };
  if (!/^[1-5](xx|\d\d)$/.test(rule.status)) {
    throw new ConfigError(`goal.when.status must look like 2xx or 201, got "${rule.status}"`);
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

  const traffic = doc.traffic === undefined ? 100 : Number(doc.traffic);
  if (!Number.isFinite(traffic) || traffic <= 0 || traffic > 100) {
    throw new ConfigError(`traffic must be a percentage above 0 and up to 100, got "${String(doc.traffic)}"`);
  }

  return {
    flag,
    releases,
    fallback,
    goal: { event, when: rule },
    guardrails: guardrails as Guardrail[],
    traffic,
  };
}

export function matchesRule(rule: HttpRule, method: string, path: string, status: number): boolean {
  if (rule.method !== method.toUpperCase()) return false;
  if (!matchesPath(rule.path, path)) return false;
  const code = String(status);
  return rule.status.endsWith('xx') ? code[0] === rule.status[0] : code === rule.status;
}

// "/checkout" matches exactly; "/fix/*" matches anything under /fix/.
function matchesPath(pattern: string, path: string): boolean {
  const clean = path.split('?')[0] ?? path;
  if (pattern.endsWith('/*')) return clean.startsWith(pattern.slice(0, -1));
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
