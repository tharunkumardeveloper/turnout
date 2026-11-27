import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createVisitorCount, isPerson, VISITOR_COOKIE } from '../src/console/visitors.ts';

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

describe('live demo visitors', () => {
  test('people only: never bots, link previews, uptime checks or automated browsers', () => {
    assert.ok(isPerson(CHROME));
    assert.ok(isPerson(IPHONE));
    for (const ua of [
      undefined,
      '',
      'curl/8.4.0',
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36',
      `${CHROME} TurnoutBrowserVisit/1.0`,
      'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
      'node-fetch/1.0',
    ]) assert.equal(isPerson(ua), false, String(ua));
  });

  test('each browser counts once: the first visit sets a cookie, later ones carry it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tn-visitors-'));
    const v = createVisitorCount(dir, () => new Date('2026-11-27T12:00:00Z'));
    const cookie = v.note(undefined, CHROME, true);
    assert.match(cookie ?? '', new RegExp(`^${VISITOR_COOKIE}=1; Path=/; Max-Age=\\d+; SameSite=Lax; HttpOnly; Secure$`));
    assert.equal(v.note(`other=1; ${VISITOR_COOKIE}=1`, CHROME, true), null, 'the same browser again');
    assert.equal(v.note(undefined, 'curl/8.4.0', true), null, 'not a person');
    assert.ok(v.note(undefined, IPHONE, false));
    assert.equal(v.get().count, 2);
    // Kept across restarts; only the count and its start date.
    const saved = JSON.parse(readFileSync(join(dir, 'visitors.json'), 'utf8'));
    assert.deepEqual(saved, { count: 2, since: '2026-11-27T12:00:00.000Z' });
    assert.equal(createVisitorCount(dir).get().count, 2);
  });

  test("the badge is shields.io's endpoint format", () => {
    const v = createVisitorCount(mkdtempSync(join(tmpdir(), 'tn-visitors-')));
    for (let i = 0; i < 1234; i++) v.note(undefined, CHROME, false);
    assert.deepEqual(v.badge(), { schemaVersion: 1, label: 'live demo visitors', message: '1,234', color: '6633ff', cacheSeconds: 300 });
  });
});
