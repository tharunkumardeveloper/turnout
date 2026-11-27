// The live demo's visitor count: unique browsers that opened the public page, counted once each (a first-party
// cookie), people only (bots, crawlers, link previews and automated browsers are left out). Only the count and the
// date it started are kept, in <dir>/visitors.json: no addresses, no identifiers.
//
// The README's badge reads it through shields.io (GET /judge/api/badge/visitors, shields' endpoint format).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const VISITOR_COOKIE = 'tn_seen';
const ONE_YEAR = 365 * 24 * 60 * 60;
// Not a person: crawlers, link previews, uptime checks, headless and automated browsers (Turnout's own included).
const NOT_A_PERSON = /bot|crawl|spider|slurp|preview|monitor|uptime|headless|lighthouse|pingdom|curl|wget|python|node-fetch|undici|axios|go-http|java\/|okhttp|TurnoutBrowserVisit|shields/i;

export function isPerson(userAgent: string | undefined): boolean {
  return Boolean(userAgent) && /Mozilla\//.test(userAgent!) && !NOT_A_PERSON.test(userAgent!);
}

export function createVisitorCount(dir: string, now: () => Date = () => new Date()) {
  const file = join(dir, 'visitors.json');
  let data: { count: number; since: string } = { count: 0, since: now().toISOString() };
  try {
    if (existsSync(file)) {
      const read = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof read.count === 'number' && typeof read.since === 'string') data = read;
    }
  } catch {
    /* a damaged file starts again from 0 */
  }
  const save = () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(data));
    renameSync(`${file}.tmp`, file);
  };
  return {
    /** A page view: counts a new person once; returns the cookie to set, or null. */
    note(cookieHeader: string | undefined, userAgent: string | undefined, secure: boolean): string | null {
      if (!isPerson(userAgent)) return null;
      if ((cookieHeader ?? '').split(';').some((c) => c.trim().startsWith(`${VISITOR_COOKIE}=`))) return null;
      data.count += 1;
      try {
        save();
      } catch {
        /* the count still goes up for this run */
      }
      return `${VISITOR_COOKIE}=1; Path=/; Max-Age=${ONE_YEAR}; SameSite=Lax; HttpOnly${secure ? '; Secure' : ''}`;
    },
    get: () => ({ ...data }),
    /** shields.io's endpoint badge: https://shields.io/badges/endpoint-badge */
    badge: () => ({ schemaVersion: 1, label: 'live demo visitors', message: data.count.toLocaleString('en-US'), color: '6633ff', cacheSeconds: 300 }),
  };
}
