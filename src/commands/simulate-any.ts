// `turnout simulate`: pretend visitors for any website, so a comparison shows results in minutes. They go through a
// second proxy bound to a separate Flagsmith environment ("Demo (simulated)", see sim-setup in cli.ts), so they never
// land in the real experiment.
//
// Turnout knows nothing about your site in advance, so each visitor explores it the way a person would:
//   1. loads the home page (Flagsmith picks the version, exactly as for a real visitor);
//   2. a quarter leave right there (a bounce); the rest follow 1 to 4 of the page's own links (same-origin <a href>,
//      never assets or Turnout's paths), preferring pages they haven't seen;
//   3. with the hidden conversion rate of the version they got, they make the goal: when a page they visited has a
//      <form> that posts to the goal (method and path), they fill it in (email, name, password, phone, numbers,
//      checkboxes, the first option of each select; hidden fields kept) and submit it like a browser would; otherwise
//      they send the goal request itself.
// A GET goal (a page such as GET /product/*) is kept out of the browsing: visitors open such a page only when they
// convert, so browsing never adds conversions of its own; the page they open is one of your real links when one matches.
// The rates are drawn per version (one better, worse or the same as the first) and revealed when the run ends. Every
// visitor is labelled simulated (user agent TurnoutSimulatedVisitor). They are real requests to your app: a goal
// like POST /signup may create real records. A single-page app with no links in its HTML gets the goal request only.
import { pickTruth, type Truth } from '../console/blind.ts';
import type { HttpRule } from '../config.ts';

export const SIM_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 TurnoutSimulatedVisitor/1.0';
const ASSET = /\.(css|js|mjs|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|pdf|zip|json|xml|txt|mp4|webm|mp3)$/i;
const SKIP = /^\/(__turnout|_next\/|static\/|assets\/|api\/auth|logout|signout|sign-out)/i;
export const BOUNCE_RATE = 0.25;

/** Same-origin page links in a page: "/about", not assets, not Turnout's own paths or sign-out links, at most 30. */
export function pageLinks(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*["'](\/[^"'#?\s]*)/gi)) {
    const path = m[1]!;
    if (path.startsWith('//') || SKIP.test(path) || ASSET.test(path)) continue;
    out.add(path);
    if (out.size >= 30) break;
  }
  return [...out];
}

/** The request a goal rule describes, with any * in its path filled in. */
export function goalRequest(rule: HttpRule): { method: string; path: string } {
  return { method: rule.method, path: rule.path.replace(/\*/g, '1') };
}

export type FormField = { name: string; type: string; value: string; options?: string[] };
export type PageForm = { method: string; action: string; fields: FormField[] };

const attr = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
};
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** The forms in a page: method, action (resolved against the page's path) and their named fields. */
export function pageForms(html: string, pagePath = '/'): PageForm[] {
  const forms: PageForm[] = [];
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const open = m[1] ?? '';
    const body = m[2] ?? '';
    const method = (attr(open, 'method') ?? 'GET').toUpperCase();
    let action = pagePath;
    try {
      action = new URL(decode(attr(open, 'action') ?? '') || pagePath, `http://site${pagePath}`).pathname;
    } catch {
      /* keep the page's own path */
    }
    const fields: FormField[] = [];
    for (const t of body.matchAll(/<input\b[^>]*>/gi)) {
      const name = attr(t[0], 'name');
      if (!name) continue;
      const type = (attr(t[0], 'type') ?? 'text').toLowerCase();
      if (['submit', 'button', 'image', 'reset', 'file'].includes(type)) continue;
      fields.push({ name: decode(name), type, value: decode(attr(t[0], 'value') ?? '') });
    }
    for (const t of body.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
      const name = attr(t[1] ?? '', 'name');
      if (!name) continue;
      const options = [...(t[2] ?? '').matchAll(/<option\b([^>]*)>([^<]*)/gi)].map((o) => decode(attr(o[1] ?? '', 'value') ?? o[2]!.trim())).filter((v) => v !== '');
      fields.push({ name: decode(name), type: 'select', value: options[0] ?? '', options });
    }
    for (const t of body.matchAll(/<textarea\b([^>]*)>/gi)) {
      const name = attr(t[1] ?? '', 'name');
      if (name) fields.push({ name: decode(name), type: 'textarea', value: '' });
    }
    forms.push({ method, action, fields });
  }
  return forms;
}

/** Made-up values a person would type, by field type and name. Visitor n gets its own email. */
export function fillForm(form: PageForm, n: number): URLSearchParams {
  const body = new URLSearchParams();
  const radios = new Set<string>();
  for (const f of form.fields) {
    const name = f.name.toLowerCase();
    let value = f.value;
    if (f.type === 'hidden' || f.type === 'select') value = f.value;
    else if (f.type === 'checkbox') value = f.value || 'on';
    else if (f.type === 'radio') {
      if (radios.has(f.name)) continue;
      radios.add(f.name);
      value = f.value || 'on';
    } else if (f.type === 'email' || /e-?mail/.test(name)) value = `sim-visitor-${n}@example.test`;
    else if (f.type === 'password' || /pass/.test(name)) value = 'Turnout-sim-123!';
    else if (f.type === 'tel' || /phone|mobile|tel/.test(name)) value = '5550100';
    else if (f.type === 'number' || f.type === 'range' || /qty|quantity|count|amount/.test(name)) value = f.value || '1';
    else if (f.type === 'url') value = 'https://example.test';
    else if (f.type === 'date') value = '2026-12-01';
    else if (/first/.test(name)) value = 'Sim';
    else if (/last|surname/.test(name)) value = 'Visitor';
    else if (/name/.test(name)) value = 'Sim Visitor';
    else if (/zip|postal|pin/.test(name)) value = '10001';
    else if (/city/.test(name)) value = 'Springfield';
    else if (/address|street/.test(name)) value = '1 Example Street';
    else if (f.type === 'textarea') value = 'A simulated visitor (Turnout).';
    else value = f.value || 'test';
    body.append(f.name, value);
  }
  return body;
}

const ruleMatches = (rule: HttpRule, method: string, path: string): boolean => {
  if (rule.method !== method) return false;
  return rule.path.endsWith('/*') ? path.startsWith(rule.path.slice(0, -1)) : rule.path === path;
};

/** Hidden conversion rates, one per version: the first is the base (8–12%), each other one better, worse or the same. */
export function pickRates(releases: string[], rand: () => number = Math.random): Record<string, number> {
  const base = Math.round((0.08 + rand() * 0.04) * 1000) / 1000;
  return Object.fromEntries(releases.map((r, i) => [r, i === 0 ? base : Math.round(base * [0.7, 1, 1.4][Math.min(2, Math.floor(rand() * 3))]! * 1000) / 1000]));
}

export type AnySimOptions = {
  target: string; // the simulation proxy, e.g. http://turnout-sim:8080
  visitors: number;
  concurrency: number;
  releases: string[]; // every version, the live one (A) first
  goal: HttpRule | undefined; // no goal: visitors only browse (page speed is still measured)
  debugToken: string; // the proxy names the release it served for this token
  rates?: Record<string, number>; // the hidden conversion rate per release; drawn when not given
  truth?: Truth; // the older two-version form of `rates`
  rand?: () => number;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
};
export type ReleaseTally = { visitors: number; goals: number; errors: number; pages: number; bounces: number; forms: number };
export type AnySimReport = { rates: Record<string, number>; truth: Truth | null; byRelease: Record<string, ReleaseTally>; spa: boolean };

export async function simulateAny(o: AnySimOptions): Promise<AnySimReport> {
  const rand = o.rand ?? Math.random;
  const f = o.fetchImpl ?? fetch;
  const truth = o.truth ?? (o.releases.length === 2 && !o.rates ? pickTruth(0, o.releases[0]!, o.releases[1]!, null, rand) : null);
  const rates = o.rates ?? (truth ? { [truth.control]: truth.rates.control, [truth.v2]: truth.rates.v2 } : pickRates(o.releases, rand));
  const byRelease: AnySimReport['byRelease'] = {};
  const tally = (release: string) => (byRelease[release] ??= { visitors: 0, goals: 0, errors: 0, pages: 0, bounces: 0, forms: 0 });
  let homeLinks = 0;
  let serial = 0;

  const visit = async () => {
    const n = ++serial;
    const jar = new Map<string, string>();
    let lastPage = '/';
    const request = async (method: string, path: string, body?: URLSearchParams) => {
      // x-turnout-visitor: count this as a visitor from the first page (the token only reads back the release).
      const headers: Record<string, string> = { 'user-agent': SIM_USER_AGENT, accept: 'text/html', 'x-turnout-debug': o.debugToken, 'x-turnout-visitor': '1', referer: new URL(lastPage, o.target).href };
      if (method === 'GET') headers['sec-fetch-dest'] = 'document';
      else headers['content-type'] = 'application/x-www-form-urlencoded';
      if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await f(new URL(path, o.target), { method, headers, redirect: 'manual', ...(method === 'GET' ? {} : { body: body?.toString() ?? '' }), signal: AbortSignal.timeout(15_000) });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const at = (pair ?? '').indexOf('=');
        if (at > 0) jar.set(pair!.slice(0, at).trim(), pair!.slice(at + 1));
      }
      return res;
    };
    const page = async (path: string) => {
      const res = await request('GET', path);
      const html = res.status < 400 && /html/.test(res.headers.get('content-type') ?? 'text/html') ? await res.text() : (await res.arrayBuffer(), '');
      lastPage = path;
      return { res, html };
    };

    const first = await page('/');
    const release = first.res.headers.get('x-turnout-release') ?? 'unknown';
    const t = tally(release);
    t.visitors++;
    t.pages++;
    if (first.res.status >= 500) t.errors++;
    const seen = new Set(['/']);
    const links = new Set(pageLinks(first.html));
    if (n === 1) homeLinks = links.size;
    const forms: PageForm[] = pageForms(first.html, '/');
    // Browsing never opens a goal page (a GET goal): only converting does, so the hidden rates hold.
    const isGoal = (path: string) => !!o.goal && o.goal.method === 'GET' && ruleMatches(o.goal, 'GET', path);
    const goalLinks = new Set<string>();
    const note = (path: string) => {
      if (isGoal(path)) goalLinks.add(path);
      else if (links.size < 60) links.add(path);
    };
    for (const l of [...links]) if (isGoal(l)) {
      links.delete(l);
      goalLinks.add(l);
    }
    if (rand() < BOUNCE_RATE) {
      t.bounces++;
    } else {
      for (let i = 0, steps = 1 + Math.floor(rand() * 4); i < steps && links.size; i++) {
        const fresh = [...links].filter((l) => !seen.has(l));
        const pool = fresh.length ? fresh : [...links];
        const next = pool[Math.floor(rand() * pool.length)]!;
        seen.add(next);
        const p = await page(next);
        t.pages++;
        if (p.res.status >= 500) t.errors++;
        for (const l of pageLinks(p.html)) note(l);
        forms.push(...pageForms(p.html, next));
      }
    }
    if (o.goal && rand() < (rates[release] ?? 0)) {
      const form = o.goal.method === 'GET' ? undefined : forms.find((x) => ruleMatches(o.goal!, x.method, x.action));
      const real = [...goalLinks];
      const g = real.length ? { method: 'GET', path: real[Math.floor(rand() * real.length)]! } : goalRequest(o.goal);
      const res = form ? await request(form.method, form.action, fillForm(form, n)) : await request(g.method, g.path);
      await res.arrayBuffer();
      if (form) t.forms++;
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
  return { rates, truth, byRelease, spa: homeLinks === 0 };
}

/** The hidden rates in one sentence, for the end of a run. */
export function ratesText(rates: Record<string, number>): string {
  return Object.entries(rates).map(([r, x]) => `${r} ${(x * 100).toFixed(1)}%`).join(', ');
}
