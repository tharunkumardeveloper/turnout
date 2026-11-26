// `turnout new`: four questions (Flagsmith, the releases, success, traffic) → turnout.config.yml and a compose
// file for your own project (the proxy, the console and the one-off CLI), plus Flagsmith's when you want it bundled.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GUARDRAILS, parseConfig } from '../config.ts';
import { parse } from 'yaml';
import { writeEnv } from './init.ts';

// Not published yet: build it locally (docker build -t <this> .) until the publish workflow has run on a tag.
export const DEFAULT_IMAGE = 'ghcr.io/tharunkumardeveloper/turnout:latest';
export const DEFAULT_RELEASES = ['v1=http://host.docker.internal:3000', 'v2=http://host.docker.internal:3001'];
export const DEFAULT_SUCCESS = 'POST /signup 2xx';

export type NewAnswers = {
  flagsmith: 'bundled' | string; // "bundled", or your Flagsmith's API URL (…/api/v1/)
  releases: string[]; // each: "label=http://host:port", "http://host:port", or an image ("myapp:2")
  success: string; // "POST /signup 2xx", or "header signup": the app sends X-Turnout-Event: signup
  traffic: number; // % of visitors in the experiment
  flag?: string | undefined;
  event?: string | undefined;
  appPort?: number | undefined; // the port your release images listen on
  image?: string | undefined; // the Turnout image
  proxyPort?: number | undefined;
  consolePort?: number | undefined; // default 8090; change it to run next to another Turnout
  project?: string | undefined; // existing Flagsmith: project and environment init reuses
  environment?: string | undefined;
};

export type Release = { label: string; url: string; image?: string; service?: string };

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function parseReleases(entries: string[], appPort = 8080): { releases: Release[]; notes: string[] } {
  const notes: string[] = [];
  const releases = entries.map((raw, i): Release => {
    const entry = raw.trim();
    const eq = entry.indexOf('=');
    const [label, value] = eq > 0 && !entry.slice(0, eq).includes('/') ? [entry.slice(0, eq), entry.slice(eq + 1)] : [undefined, entry];
    if (/^https?:\/\//.test(value)) {
      const url = new URL(value);
      if (LOOPBACK.has(url.hostname)) {
        // Inside the proxy's container, localhost is the proxy itself.
        notes.push(`${value}: localhost inside a container is the container, so this uses host.docker.internal (your machine)`);
        url.hostname = 'host.docker.internal';
      }
      return { label: label ?? `v${i + 1}`, url: url.href.replace(/\/$/, '') };
    }
    if (!/^[a-z0-9][\w./-]*(:[\w.-]+)?(@sha256:[a-f0-9]+)?$/i.test(value)) {
      throw new Error(`release "${raw}" is neither an http(s) URL nor a Docker image`);
    }
    const name = value.split('@')[0]!;
    const base = name.slice(name.lastIndexOf('/') + 1);
    const service = base.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-|-$/g, '');
    return { label: label ?? base, url: `http://${service}:${appPort}`, image: value, service };
  });
  if (releases.length < 2) throw new Error('give at least two releases: the live one first, then the one to test');
  const labels = releases.map((r) => r.label);
  const dup = labels.find((l, i) => labels.indexOf(l) !== i);
  if (dup) throw new Error(`release label "${dup}" is used twice`);
  const services = releases.flatMap((r) => (r.service ? [r.service] : []));
  const dupService = services.find((s, i) => services.indexOf(s) !== i);
  if (dupService) throw new Error(`two images map to the same service name "${dupService}": label them, e.g. a=app:1 b=app:2`);
  return { releases, notes };
}

export function parseSuccess(text: string): { method: string; path: string; status: string } {
  const m = text.trim().match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)(?:\s+([1-5](?:xx|\d\d)))?$/i);
  if (!m) throw new Error(`success should look like "POST /signup 2xx", got "${text}"`);
  return { method: m[1]!.toUpperCase(), path: m[2]!, status: m[3] ?? '2xx' };
}

// "header" or "header <event>": success comes from the app's X-Turnout-Event response header.
export function parseHeaderSuccess(text: string): { event: string | undefined } | undefined {
  const m = text.trim().match(/^header(?:\s+(\S+))?$/i);
  return m ? { event: m[1] } : undefined;
}

// "/signup" → signup; "/api/orders/*" → orders.
export function eventFromPath(path: string): string {
  const seg = path.split(/[/?]/).filter((s) => s && s !== '*').pop() ?? '';
  let name = seg.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^[^A-Za-z]+/, '');
  if (!name || (GUARDRAILS as readonly string[]).includes(name)) name = 'goal';
  return name.slice(0, 100);
}

const yamlString = (s: string) => JSON.stringify(s); // JSON strings are valid YAML

export function renderConfig(a: NewAnswers, releases: Release[]): string {
  const byHeader = parseHeaderSuccess(a.success);
  const rule = byHeader ? undefined : parseSuccess(a.success);
  const first = releases[0]!.label;
  const flag = a.flag ?? `${(first.split(':')[0] || 'app').replace(/[^A-Za-z0-9_]/g, '_').replace(/^v\d+$/, 'app')}_release`;
  const event = a.event ?? byHeader?.event ?? (rule ? eventFromPath(rule.path) : 'goal');
  const goal = rule
    ? `# Success: the request that counts as a conversion, sent to Flagsmith as an event.
goal:
  event: ${event}
  when: { method: ${rule.method}, path: ${yamlString(rule.path)}, status: ${rule.status} }`
    : `# Success: your app answers the converting request with the response header "X-Turnout-Event: ${event}".
# Turnout sends it to Flagsmith as an event and removes the header before the visitor sees it.
goal:
  event: ${event}
  header: true`;
  const text = `# Written by "turnout new". Turnout routes each visitor to one of these releases by the Flagsmith flag below.
flag: ${flag}

# Allowlist: release label (the flag's value in Flagsmith) → where that release answers.
# The first release is served whenever Flagsmith can't answer or the flag is off.
releases:
${releases.map((r) => `  ${yamlString(r.label)}: ${r.url}`).join('\n')}

${goal}

guardrails: [doc_latency_ms, server_error]   # sent on every page load

# % of visitors in the experiment; the rest stay on the first release.
traffic: ${a.traffic}
`;
  parseConfig(parse(text)); // what we write must load
  return text;
}

export function renderCompose(a: NewAnswers, releases: Release[]): string {
  const bundled = a.flagsmith === 'bundled';
  const api = bundled ? 'http://flagsmith:8000/api/v1/' : a.flagsmith;
  const image = a.image ?? DEFAULT_IMAGE;
  const port = a.proxyPort ?? 8080;
  const consolePort = a.consolePort ?? 8090;
  const nets = bundled ? '\n    networks: [default, sdk]' : '';
  const waitFlagsmith = bundled ? '\n    depends_on:\n      flagsmith:\n        condition: service_healthy' : '';
  const apps = releases.filter((r) => r.image);
  return `# Written by "turnout new": Turnout in front of your app. Run it with
#   docker compose -f turnout.compose.yml run --rm cli init
#   docker compose -f turnout.compose.yml up -d
# then open http://127.0.0.1:${port} (your app, through Turnout) and http://127.0.0.1:${consolePort} (the console).
# ${image} is not published yet: build it from the Turnout repo with "docker build -t ${image} ." first.
${bundled ? 'include:\n  - flagsmith.compose.yml   # Flagsmith, from Turnout\'s compose.flagsmith.yml\n' : ''}
x-turnout: &turnout
  image: ${image}
  user: '\${TURNOUT_UID:-1000}:\${TURNOUT_GID:-1000}'
  extra_hosts: ['host.docker.internal:host-gateway'] # your machine, on Linux too

services:
  turnout:
    <<: *turnout
    command: proxy
    restart: unless-stopped
    environment:
      FLAGSMITH_API_URL: ${api}
      TURNOUT_SERVER_KEY: \${TURNOUT_SERVER_KEY:-} # written by init
      TURNOUT_PREVIEW_TOKEN: \${TURNOUT_PREVIEW_TOKEN:-}
    ports:
      - 127.0.0.1:${port}:8080
    volumes:
      - ./turnout.config.yml:/app/turnout.config.yml:ro
      - turnout-state:/app/.turnout${nets}${waitFlagsmith}

  console:
    <<: *turnout
    command: console
    restart: unless-stopped
    environment:
      FLAGSMITH_API_URL: ${api}
      TURNOUT_ADMIN_KEY: \${TURNOUT_ADMIN_KEY:-}
      TURNOUT_EXPERIMENT: \${TURNOUT_EXPERIMENT:-}
      TURNOUT_SERVER_KEY: \${TURNOUT_SERVER_KEY:-}
      TURNOUT_PREVIEW_TOKEN: \${TURNOUT_PREVIEW_TOKEN:-}
      TURNOUT_FEED_URL: http://turnout:8081
      TURNOUT_PROXY_URL: http://turnout:8080
      TURNOUT_PUBLIC_SHOP_URL: http://127.0.0.1:${port}
      CONSOLE_HOST: 0.0.0.0
    ports:
      - 127.0.0.1:${consolePort}:8090 # holds the admin key: this machine only
    volumes:
      - ./turnout.config.yml:/app/turnout.config.yml:ro
      - ./.turnout:/app/.turnout${nets}
    depends_on:
      turnout:
        condition: service_started

  # One-off commands: docker compose -f turnout.compose.yml run --rm cli <init | status | ship | revert | release …>
  cli:
    <<: *turnout
    profiles: [tools]
    environment:
      FLAGSMITH_API_URL: ${api}
      TURNOUT_PROXY_URL: http://turnout:8080
      TURNOUT_PUBLIC_SHOP_URL: http://127.0.0.1:${port}
      TURNOUT_PUBLIC_CONSOLE_PORT: '${consolePort}' # the judge link init prints
    volumes:
      - ./turnout.config.yml:/app/turnout.config.yml:ro
      - ./.env:/app/.env
      - ./.turnout:/app/.turnout${nets}${waitFlagsmith}
${apps
  .map(
    (r) => `
  ${r.service}: # release ${r.label}
    image: ${r.image}
    restart: unless-stopped${bundled ? '\n    networks: [default]' : ''}
`,
  )
  .join('')}
volumes:
  turnout-state: {}
`;
}

export type NewOptions = { answers: NewAnswers; dir: string; force?: boolean; flagsmithCompose?: string; adminKey?: string | undefined; log?: (l: string) => void };

/** Writes the files; refuses to overwrite unless force. Returns the paths written. */
export function writeNew(opts: NewOptions): string[] {
  const log = opts.log ?? console.log;
  const a = opts.answers;
  if (!(a.traffic > 0 && a.traffic <= 100)) throw new Error(`traffic must be a percentage above 0 and up to 100, got "${a.traffic}"`);
  if (a.flagsmith !== 'bundled' && !/^https?:\/\//.test(a.flagsmith)) throw new Error(`Flagsmith should be "bundled" or your API URL (…/api/v1/), got "${a.flagsmith}"`);
  const { releases, notes } = parseReleases(a.releases, a.appPort);
  for (const n of notes) log(`· ${n}`);
  const files: [string, string][] = [
    ['turnout.config.yml', renderConfig(a, releases)],
    ['turnout.compose.yml', renderCompose(a, releases)],
  ];
  if (a.flagsmith === 'bundled') {
    if (!opts.flagsmithCompose) throw new Error('the bundled Flagsmith compose file is missing from this install');
    files.push(['flagsmith.compose.yml', opts.flagsmithCompose]);
  }
  const clash = files.filter(([f]) => existsSync(join(opts.dir, f))).map(([f]) => f);
  if (clash.length && !opts.force) throw new Error(`${clash.join(', ')} already exist${clash.length === 1 ? 's' : ''}: pass --force to overwrite`);
  mkdirSync(join(opts.dir, '.turnout'), { recursive: true });
  for (const [f, text] of files) writeFileSync(join(opts.dir, f), text);
  const env: Record<string, string> = {};
  if (a.project) env.TURNOUT_PROJECT = a.project;
  if (a.environment) env.TURNOUT_ENVIRONMENT = a.environment;
  if (opts.adminKey) env.TURNOUT_ADMIN_KEY = opts.adminKey;
  const envFile = join(opts.dir, '.env');
  if (Object.keys(env).length || !existsSync(envFile)) writeEnv(envFile, env); // the cli mounts it, so it must exist
  const written = [...files.map(([f]) => f), '.env'];
  log(`✓ wrote ${written.join(', ')}`);
  log('Next:');
  if (a.flagsmith !== 'bundled' && !opts.adminKey) log('  put your Organisation API key in .env as TURNOUT_ADMIN_KEY');
  log('  docker compose -f turnout.compose.yml run --rm cli init');
  log('  docker compose -f turnout.compose.yml up -d');
  return written;
}

export function readFileIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}
