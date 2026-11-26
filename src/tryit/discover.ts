// Turnout learns the site by watching it (docs/PLAN.md steps 3 and 4): right after the build, each version is walked
// once (never counted), and what a visitor can do there that reaches the server becomes the goals to choose from:
// form sends first, then downloads, then pages that sound like a conversion. Only actions every version has.
import { pageLinks } from '../commands/simulate-any.ts';
// @ts-expect-error: a plain browser module with no types (the console page loads it as is)
import { goalsFromHtml as fromHtml } from '../console/ui/try-model.js';

const goalsFromHtml = fromHtml as (html: string) => string[];

/** One version's actions: its home page and up to `pages` of the pages it links to, read once. */
export async function walk(base: string, pages = 8, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const seen = new Set<string>();
  const queue = ['/'];
  const goals: string[] = [];
  const okPages = new Set<string>();
  while (queue.length && seen.size < pages + 1) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const res = await fetchImpl(new URL(path, base), { signal: AbortSignal.timeout(4000), headers: { 'user-agent': 'TurnoutWalk/1.0' } }).catch(() => null);
    if (res?.ok) okPages.add(path);
    if (!res?.ok || !/html/i.test(res.headers.get('content-type') ?? 'text/html')) continue;
    const html = await res.text().catch(() => '');
    for (const g of goalsFromHtml(html)) if (!goals.includes(g)) goals.push(g);
    for (const p of pageLinks(html)) if (!seen.has(p)) queue.push(p);
  }
  // A link to a page that isn't there (404) is no goal: each page or download offered must answer.
  const answers = async (g: string) => {
    if (!g.startsWith('GET ')) return true;
    const path = g.slice(4).replace(/\*$/, '');
    if (seen.has(path)) return okPages.has(path);
    const res = await fetchImpl(new URL(path, base), { signal: AbortSignal.timeout(4000), headers: { 'user-agent': 'TurnoutWalk/1.0' } }).catch(() => null);
    await res?.arrayBuffer().catch(() => {});
    return Boolean(res && res.status < 400);
  };
  const ok = await Promise.all(goals.map(answers));
  return goals.filter((_, i) => ok[i]);
}

/** Actions every version has, in the first version's order (it ranks them). */
export function common(perVersion: string[][]): string[] {
  const [first = [], ...rest] = perVersion;
  return first.filter((g) => rest.every((r) => r.includes(g)));
}

/** How a goal reads to a person: "POST /signup" → "sends the form to /signup". */
export function describeAction(goal: string): string {
  const [method, path = ''] = goal.split(' ');
  if (method === 'POST') return `sends the form to ${path}`;
  if (/\.(pdf|docx?|zip|pptx?|xlsx?)$/i.test(path)) return `downloads ${path.split('/').pop()}`;
  return `opens ${path.replace(/\*$/, '')}`;
}
