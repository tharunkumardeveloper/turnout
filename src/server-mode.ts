// Server mode (SWITCHYARD_MODE=server): the same Switchyard, published on a public hostname behind Caddy (compose.server.yml).
// Nothing here changes experiment logic. It holds what server mode adds on top of local mode:
//   - serverSecretProblems(): the start-up refusal (placeholder Flagsmith secrets or tokens), used by `switchyard server-check`
//     and by doctor. It names a setting and what's wrong with it, never its value.
//   - gatherServerFacts() / evaluateServer(): doctor's server-only checks (HTTPS and its certificate, Secure cookies,
//     ports that must stay private, secrets, restart policies). Local mode never runs them.
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import type { CheckStatus, DoctorCheck } from './commands/doctor.ts';

export type Mode = 'local' | 'server';
export const modeOf = (env: NodeJS.ProcessEnv): Mode => (env.SWITCHYARD_MODE?.trim().toLowerCase() === 'server' ? 'server' : 'local');

// The secrets compose.server.yml hands to Flagsmith and Postgres (switchyard.sh server writes random ones).
export const SERVER_SECRETS = ['FLAGSMITH_DJANGO_SECRET_KEY', 'FLAGSMITH_WAREHOUSE_SECRET', 'POSTGRES_PASSWORD'] as const;
// Written by init. Before init they are empty, which is fine; a placeholder never is.
export const SERVER_TOKENS = ['SWITCHYARD_JUDGE_TOKEN', 'SWITCHYARD_PREVIEW_TOKEN'] as const;
// The ports that stay on 127.0.0.1 in server mode (Flagsmith, the proxy, the console and its device port).
export const PRIVATE_PORTS = [8000, 8080, 8090, 8091] as const;
const MIN_SECRET_LENGTH = 16;

// The official compose file's values ("secret", "password") and the usual stand-ins.
const PLACEHOLDERS = new Set(['secret', 'password', 'changeme', 'change-me', 'change_me', 'placeholder', 'example', 'default', 'test', 'admin', 'postgres', 'flagsmith', 'xxx', 'todo', 'none', 'null']);

export type SecretProblem = { name: string; problem: string };

/** What's wrong with one secret's value, or null. Never returns the value itself. */
export function secretProblem(value: string | undefined): string | null {
  const v = (value ?? '').trim();
  if (!v) return 'empty';
  const lower = v.toLowerCase();
  if (PLACEHOLDERS.has(lower) || /change.?me|change.?this|placeholder|^<.*>$|^\$\{/.test(lower)) return 'a placeholder';
  if (v.length < MIN_SECRET_LENGTH) return `shorter than ${MIN_SECRET_LENGTH} characters`;
  return null;
}

/** A DNS name Caddy can get a certificate for: letters, digits, dots and dashes, at least one dot (or "localhost"). */
export function hostnameProblem(hostname: string | undefined): string | null {
  const h = (hostname ?? '').trim().toLowerCase();
  if (!h) return 'empty';
  if (h === 'localhost') return null; // CI and trying it out: Caddy's internal certificate
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h)) return 'not a hostname (e.g. switchyard.example.com, no scheme or port)';
  if (/^[0-9.]+$/.test(h)) return 'an IP address: use a DNS name that points at this server, so Caddy can get a certificate';
  return null;
}

/**
 * Why server mode must not start, by setting name. `afterInit`: also require the tokens init writes; before init an
 * empty token is fine (init creates it), a placeholder is not.
 */
export function serverSecretProblems(env: NodeJS.ProcessEnv, afterInit = false): SecretProblem[] {
  const problems: SecretProblem[] = [];
  const host = hostnameProblem(env.SWITCHYARD_HOSTNAME);
  if (host) problems.push({ name: 'SWITCHYARD_HOSTNAME', problem: host });
  for (const name of SERVER_SECRETS) {
    const p = secretProblem(env[name]);
    if (p) problems.push({ name, problem: p });
  }
  for (const name of SERVER_TOKENS) {
    if (!afterInit && !(env[name] ?? '').trim()) continue;
    const p = secretProblem(env[name]);
    if (p) problems.push({ name, problem: p });
  }
  const publish = (env.SWITCHYARD_PUBLISH_HOST ?? '127.0.0.1').trim();
  if (publish !== '127.0.0.1') problems.push({ name: 'SWITCHYARD_PUBLISH_HOST', problem: `"${publish}": server mode publishes through Caddy only, keep 127.0.0.1` });
  if ((env.SWITCHYARD_CONSOLE_HOSTS ?? '').trim()) problems.push({ name: 'SWITCHYARD_CONSOLE_HOSTS', problem: 'set: server mode shows judge mode read-only at https://<hostname>/judge; leave it empty' });
  return problems;
}

// ---- doctor ---------------------------------------------------------------------------------------------------------

export type ServerModeOptions = {
  hostname: string;
  tls: 'public' | 'internal'; // internal: Caddy's own CA (SWITCHYARD_CADDY_TLS="tls internal", CI and trying it out)
  edgeAddress?: string | undefined; // where to reach Caddy from here (Compose: "caddy"); default the hostname
  env: NodeJS.ProcessEnv; // the settings, for the secret checks (values are compared, never reported)
  restartPolicies?: string | undefined; // "service=policy,…" read from Docker by switchyard.sh / switchyard.bat
};

export type TlsFacts = { authorized: boolean; error: string | null; issuer: string | null; validTo: string | null; selfSigned: boolean };
export type ServerFacts = {
  hostname: string;
  tls: 'public' | 'internal';
  https: { value: TlsFacts } | { error: string };
  cookies: { value: { setCookies: number; secure: number; status: number } } | { error: string };
  readOnly: { value: { postStatus: number } } | { error: string };
  ports: { port: number; reachable: boolean; detail: string }[];
  portsLoopback: boolean; // the hostname resolves to this container's loopback: the port probe proves nothing
  secrets: SecretProblem[];
  restart: { service: string; policy: string }[] | null;
};

const SELF_SIGNED = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);

function tlsProbe(address: string, servername: string, verify: boolean): Promise<TlsFacts> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: address, port: 443, servername, rejectUnauthorized: verify, timeout: 6000 }, () => {
      const cert = socket.getPeerCertificate();
      const issuer = cert?.issuer ? String(cert.issuer.O ?? cert.issuer.CN ?? '') || null : null;
      resolve({ authorized: socket.authorized, error: socket.authorizationError ? String(socket.authorizationError) : null, issuer, validTo: cert?.valid_to ?? null, selfSigned: false });
      socket.end();
    });
    socket.on('timeout', () => socket.destroy(new Error('no answer in time')));
    socket.on('error', reject);
  });
}

async function probeTls(address: string, servername: string): Promise<TlsFacts> {
  try {
    return await tlsProbe(address, servername, true);
  } catch (error) {
    const code = (error as { code?: string }).code ?? '';
    if (!SELF_SIGNED.has(code) && code !== 'ERR_TLS_CERT_ALTNAME_INVALID' && code !== 'CERT_HAS_EXPIRED') throw error;
    const seen = await tlsProbe(address, servername, false);
    return { ...seen, authorized: false, error: code, selfSigned: SELF_SIGNED.has(code) };
  }
}

// One HTTPS request to Caddy, naming the public hostname (SNI and Host), certificate not verified (probeTls does that).
function httpsRequest(address: string, hostname: string, method: string, path: string): Promise<{ status: number; setCookies: string[] }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: address, port: 443, servername: hostname, method, path, headers: { host: hostname, 'content-type': 'application/json' }, rejectUnauthorized: false, timeout: 6000 },
      (res) => {
        res.resume();
        const raw = res.headers['set-cookie'];
        resolve({ status: res.statusCode ?? 0, setCookies: Array.isArray(raw) ? raw : raw ? [raw] : [] });
      },
    );
    req.on('timeout', () => req.destroy(new Error('no answer in time')));
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

function portOpen(host: string, port: number): Promise<{ reachable: boolean; detail: string }> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 3000 });
    socket.on('connect', () => {
      socket.destroy();
      resolve({ reachable: true, detail: 'accepted a connection' });
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ reachable: false, detail: 'no answer (filtered)' });
    });
    socket.on('error', (e: NodeJS.ErrnoException) => resolve({ reachable: false, detail: e.code ?? e.message }));
  });
}

async function isLoopbackName(hostname: string): Promise<boolean> {
  if (hostname === 'localhost') return true;
  const { lookup } = await import('node:dns/promises');
  try {
    const { address } = await lookup(hostname);
    return address.startsWith('127.') || address === '::1';
  } catch {
    return false;
  }
}

const settle = async <T>(p: Promise<T>): Promise<{ value: T } | { error: string }> => {
  try {
    return { value: await p };
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    return { error: e.code ? `${e.message} (${e.code})` : e.message };
  }
};

export function parseRestartPolicies(raw: string | undefined): { service: string; policy: string }[] | null {
  if (!raw?.trim()) return null;
  return raw
    .split(/[,;\s]+/)
    .filter(Boolean)
    .map((pair) => {
      const [name = '', policy = ''] = pair.split('=');
      return { service: name.replace(/^\//, ''), policy: policy || 'no' }; // docker inspect's .Name starts with "/"
    });
}

export async function gatherServerFacts(o: ServerModeOptions): Promise<ServerFacts> {
  const address = o.edgeAddress || o.hostname;
  const [httpsFacts, cookies, readOnly, loopback] = await Promise.all([
    settle(probeTls(address, o.hostname)),
    settle(httpsRequest(address, o.hostname, 'GET', '/').then((r) => ({ status: r.status, setCookies: r.setCookies.length, secure: r.setCookies.filter((c) => /;\s*secure(;|$)/i.test(c)).length }))),
    settle(httpsRequest(address, o.hostname, 'POST', '/judge/api/judge/run').then((r) => ({ postStatus: r.status }))),
    isLoopbackName(o.hostname),
  ]);
  const ports = await Promise.all(PRIVATE_PORTS.map(async (port) => ({ port, ...(await portOpen(o.hostname, port)) })));
  return {
    hostname: o.hostname,
    tls: o.tls,
    https: httpsFacts,
    cookies,
    readOnly,
    ports,
    portsLoopback: loopback,
    secrets: serverSecretProblems(o.env, true),
    restart: parseRestartPolicies(o.restartPolicies),
  };
}

// Pure: doctor's server-mode checks from the facts above.
export function evaluateServer(f: ServerFacts): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const A = 'Server mode';
  const add = (name: string, status: CheckStatus, expected: string, actual: string, fix?: string) =>
    checks.push({ area: A, name, expected, actual, status, ...(fix && status !== 'ok' ? { fix } : {}) });
  const url = `https://${f.hostname}`;

  if ('error' in f.https) {
    add('HTTPS', 'fail', `${url} answers with a valid certificate`, f.https.error,
      'Caddy: docker compose -f compose.yaml -f compose.server.yml logs caddy. The hostname must point at this server, and ports 80 and 443 must be open.');
  } else if (f.https.value.authorized) {
    add('HTTPS', 'ok', `${url} answers with a valid certificate`, `valid certificate from ${f.https.value.issuer ?? 'a trusted CA'}, until ${f.https.value.validTo}`);
  } else if (f.tls === 'internal' && f.https.value.selfSigned) {
    add('HTTPS', 'ok', `${url} answers (Caddy's internal certificate, SWITCHYARD_CADDY_TLS)`, `self-signed certificate from ${f.https.value.issuer ?? "Caddy's local CA"} (${f.https.value.error}): expected with tls internal, browsers warn`);
  } else {
    add('HTTPS', 'fail', `${url} answers with a valid certificate`, `certificate not trusted: ${f.https.value.error}`,
      "Caddy couldn't get a public certificate yet: check its logs, DNS for the hostname, and that ports 80 and 443 reach this server.");
  }

  if ('error' in f.cookies) add('Secure cookies', 'fail', 'the proxy sets cookies with Secure over HTTPS', f.cookies.error);
  else if (f.cookies.value.setCookies === 0) add('Secure cookies', 'warn', 'the proxy sets cookies with Secure over HTTPS', `GET / answered HTTP ${f.cookies.value.status} with no cookies`, 'Is the proxy up? docker compose logs switchyard');
  else {
    const { setCookies, secure } = f.cookies.value;
    add('Secure cookies', secure === setCookies ? 'ok' : 'fail', 'every cookie marked Secure', `${secure} of ${setCookies} marked Secure`, 'compose.server.yml sets SWITCHYARD_SECURE_COOKIES=1 on the proxy');
  }

  if ('error' in f.readOnly) add('Public judge view', 'fail', `${url}/judge refuses actions`, f.readOnly.error);
  else {
    const s = f.readOnly.value.postStatus;
    add('Public judge view', s === 405 || s === 403 ? 'ok' : 'fail', `POST ${url}/judge/api/judge/run refused (405)`, `HTTP ${s}`, 'deploy/Caddyfile must route only GET /judge and /judge/* to the console');
  }

  const open = f.ports.filter((p) => p.reachable);
  const where = f.portsLoopback ? `${f.hostname} (resolves to loopback here, so this only proves the container's own ports: check from another machine)` : f.hostname;
  add('Private ports', open.length ? 'fail' : 'ok', `${f.ports.map((p) => p.port).join(', ')} not reachable on ${where}`,
    open.length ? `reachable: ${open.map((p) => p.port).join(', ')}` : `not reachable (${f.ports.map((p) => `${p.port} ${p.detail}`).join(', ')})`,
    'Keep SWITCHYARD_PUBLISH_HOST=127.0.0.1 and reach Flagsmith and the console through an SSH tunnel (docs/SETUP.md, "Running on a server").');

  add('Secrets', f.secrets.length ? 'fail' : 'ok', 'no placeholder secrets or tokens', f.secrets.length ? f.secrets.map((s) => `${s.name} is ${s.problem}`).join('; ') : 'none',
    'sh switchyard.sh server <hostname> writes random Flagsmith secrets; init writes the tokens. Values are never shown here.');

  if (!f.restart) {
    add('Restart policies', 'warn', 'restart: unless-stopped on every service', 'not checked: run from switchyard.sh / switchyard.bat, which read them from Docker',
      'sh switchyard.sh status (or switchyard.bat status)');
  } else {
    const bad = f.restart.filter((r) => r.policy !== 'unless-stopped' && r.policy !== 'always');
    add('Restart policies', bad.length ? 'fail' : 'ok', 'unless-stopped (or always) on every running service', bad.length ? bad.map((r) => `${r.service}: ${r.policy}`).join(', ') : `${f.restart.length} services, all restart`,
      'compose.server.yml sets restart: unless-stopped on every service; start with -f compose.yaml -f compose.server.yml');
  }
  return checks;
}
