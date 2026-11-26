// `turnout simulate`: pretend visitors for any site, so a comparison shows results in minutes. They go through a
// second proxy bound to a separate Flagsmith environment ("Demo (simulated)", see sim-setup in cli.ts), so they never
// land in the real experiment. Each visitor loads the home page, follows one or two of its own links, and, with the
// hidden probability for the version it got, makes the goal request. The probabilities are drawn like a blind round
// (blind.ts): the new version better, worse, or the same, revealed when the run ends. Every visitor is labelled
// simulated (user agent TurnoutSimulatedVisitor). They are real requests to your app: a goal like POST /signup may
// create real records.
import { pickTruth, type Truth } from '../console/blind.ts';
import type { HttpRule } from '../config.ts';

export const SIM_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 TurnoutSimulatedVisitor/1.0';
const ASSET = /\.(css|js|mjs|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|pdf|zip|json|xml|txt)$/i;

/** Same-origin page links in a page: "/about", not assets, not Turnout's own paths, at most 20. */
export function pageLinks(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*["'](\/[^"'#?\s]*)/gi)) {
    const path = m[1]!;
    if (path.startsWith('//') || path.startsWith('/__turnout') || ASSET.test(path)) continue;
    out.add(path);
    if (out.size >= 20) break;
  }
  return [...out];
}

/** The request a goal rule describes, with any * in its path filled in. */
export function goalRequest(rule: HttpRule): { method: string; path: string } {
  return { method: rule.method, path: rule.path.replace(/\*/g, '1') };
}

export type AnySimOptions = {
  target: string; // the simulation proxy, e.g. http://turnout-sim:8080
  visitors: number;
  concurrency: number;
  releases: [string, string]; // the live release (control) and the new one (v2)
  goal: HttpRule | undefined; // no goal: visitors only browse (page speed is still measured)
  debugToken: string; // the proxy names the release it served for this token
  truth?: Truth; // drawn when not given
  rand?: () => number;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
};
export type AnySimReport = { truth: Truth; byRelease: Record<string, { visitors: number; goals: number; errors: number }> };

export async function simulateAny(o: AnySimOptions): Promise<AnySimReport> {
  const rand = o.rand ?? Math.random;
  const f = o.fetchImpl ?? fetch;
  const truth = o.truth ?? pickTruth(0, o.releases[0], o.releases[1], null, rand);
  const rate: Record<string, number> = { [o.releases[0]]: truth.rates.control, [o.releases[1]]: truth.rates.v2 };
  const byRelease: AnySimReport['byRelease'] = {};
  const tally = (release: string) => (byRelease[release] ??= { visitors: 0, goals: 0, errors: 0 });

  const visit = async () => {
    const jar = new Map<string, string>();
    const request = async (method: string, path: string) => {
      const headers: Record<string, string> = { 'user-agent': SIM_USER_AGENT, accept: 'text/html', 'x-turnout-debug': o.debugToken };
      if (method === 'GET') headers['sec-fetch-dest'] = 'document';
      else headers['content-type'] = 'application/x-www-form-urlencoded';
      if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await f(new URL(path, o.target), { method, headers, redirect: 'manual', ...(method === 'GET' ? {} : { body: '' }), signal: AbortSignal.timeout(15_000) });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const at = (pair ?? '').indexOf('=');
        if (at > 0) jar.set(pair!.slice(0, at).trim(), pair!.slice(at + 1));
      }
      return res;
    };
    const first = await request('GET', '/');
    const release = first.headers.get('x-turnout-release') ?? 'unknown';
    const t = tally(release);
    t.visitors++;
    if (first.status >= 500) t.errors++;
    const links = pageLinks(first.status < 400 ? await first.text() : (await first.arrayBuffer(), ''));
    for (let i = 0, n = 1 + Math.floor(rand() * 2); i < n && links.length; i++) {
      const res = await request('GET', links[Math.floor(rand() * links.length)]!);
      await res.arrayBuffer();
      if (res.status >= 500) t.errors++;
    }
    if (o.goal && rand() < (rate[release] ?? 0)) {
      const g = goalRequest(o.goal);
      const res = await request(g.method, g.path);
      await res.arrayBuffer();
      t.goals++;
    }
  };

  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < o.visitors) {
      next++;
      await visit().catch(() => tally('no answer').visitors++);
      done++;
      if (done % 100 === 0 || done === o.visitors) o.log?.(`${done}/${o.visitors} simulated visitors`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency, o.visitors)) }, worker));
  return { truth, byRelease };
}
