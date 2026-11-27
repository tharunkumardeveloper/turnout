// Records the README's GIFs as real screen recordings (Playwright video), with the moments that matter marked, so
// gif.sh plays those at normal speed and fast-forwards the waits.
//   node docs/images/readme/source/record.mjs <out-dir> <clip>    clip: judge | traffic | try | flagsmith | features
// Writes <out-dir>/<clip>.webm and <out-dir>/<clip>.json ({ marks: [{ t, label }], end }).
import { chromium } from 'playwright';
import { mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [out, clip] = process.argv.slice(2);
const LIVE = process.env.TURNOUT_LIVE ?? 'https://172-198-62-67.sslip.io';
const SIZE = { width: 1280, height: 720 };
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: SIZE, colorScheme: 'light', recordVideo: { dir: join(out, 'raw'), size: SIZE } });
// A returning visitor: no notice bar, no tour offer, so the recording shows the demo itself.
await ctx.addInitScript(() => {
  for (const k of ['turnout-live-notice-seen', 'turnout-tour-public-seen', 'turnout-tour-public-console-seen', 'turnout-tour-judge-seen', 'turnout-tour-console-seen']) localStorage.setItem(k, '1');
});
const page = await ctx.newPage();
const t0 = Date.now();
const marks = [];
const mark = (label) => marks.push({ t: (Date.now() - t0) / 1000, label });
const pause = (ms) => page.waitForTimeout(ms);

if (clip === 'judge') {
  await page.goto(`${LIVE}/`);
  const f = page.frameLocator('#judge-frame');
  await f.locator('#pilot button').waitFor();
  await pause(1500);
  // Take over from the autopilot, wait for its running step to finish, then an A/B test from the start.
  const take = f.locator('#pilot button', { hasText: 'Take over' });
  if (await take.count()) {
    mark('take-over');
    await take.click();
  }
  await f.locator('#go').waitFor();
  // A pick previews a new test; picking the kind already running goes back to it, so then pick the other one.
  await f.locator('#kinds button', { hasText: /^A\/B$/ }).click();
  await pause(800);
  if (!/Start/.test((await f.locator('#go').textContent()) ?? '')) await f.locator('#kinds button', { hasText: /^A\/B\/C$/ }).click();
  mark('pick');
  const go = f.locator('#go');
  const step = async (label, expect) => {
    await f.locator('#go:not([disabled])', { hasText: expect }).waitFor({ timeout: 240_000 });
    await pause(1200);
    mark(label);
    await go.click();
  };
  await step('start', /Start/);
  await step('shoppers', /Send/);
  await step('ask', /Ask Flagsmith/);
  // Decide: Ship or Roll back; when Flagsmith isn't sure yet, "Stop and keep A" (the quiet button) ends it too.
  await f.locator('#go:not([disabled])').waitFor({ timeout: 240_000 });
  await pause(1500);
  mark('decide');
  if (/Ship|Roll back/.test((await go.textContent()) ?? '')) await go.click();
  else await f.locator('.action-row .btn-quiet').click();
  await f.locator('.check').waitFor({ timeout: 120_000 });
  mark('checked');
  await f.locator('#steps-panel').evaluate((e) => e.scrollTo({ top: e.scrollHeight, behavior: 'smooth' }));
  await pause(4000);
  // Hand the demo back to the autopilot.
  const back = f.locator('#pilot button', { hasText: 'carry on' });
  if (await back.count()) await back.click();
} else if (clip === 'traffic') {
  await page.goto(`${LIVE}/judge/console?mode=console`);
  await page.locator('#map-show-traffic').waitFor();
  await page.locator('#map-show-traffic').click();
  // Wait for the autopilot's shoppers, so the map is busy.
  const tok = await page.locator('meta[name="turnout-console"]').getAttribute('content');
  for (let i = 0; i < 180; i++) {
    const s = await page.evaluate(async (t) => (await fetch('/judge/api/judge/state', { headers: { 'x-turnout-console': t } })).json(), tok);
    if (s.job?.action === 'visitors' && s.job.status === 'running' && (s.job.progress?.done ?? 0) > 50) break;
    await pause(2000);
  }
  // Marked every 2 s: the dots play in real time, never fast-forwarded.
  for (let i = 0; i < 5; i++) {
    mark('traffic');
    await pause(2000);
  }
  mark('previews');
  await page.locator('#map-show-previews').click();
  await pause(3500);
  await page.locator('#map-show-traffic').click();
  await pause(2500);
} else if (clip === 'try') {
  // On your machine (Try it never runs on a public server): two GitHub links, neither with a Dockerfile.
  const LOCAL = process.env.TURNOUT_LOCAL ?? 'http://127.0.0.1:8090';
  await page.goto(`${LOCAL}/`);
  await page.locator('#try-open').waitFor();
  await pause(1500);
  mark('open');
  await page.locator('#try-open').click();
  const boxes = page.locator('#try-versions textarea');
  await boxes.first().waitFor();
  await pause(800);
  mark('links');
  await boxes.nth(0).pressSequentially('https://github.com/heroku/node-js-getting-started', { delay: 25 });
  await pause(600);
  await boxes.nth(1).pressSequentially('https://github.com/heroku/python-getting-started', { delay: 25 });
  await pause(1500);
  mark('next');
  await page.locator('#try-next').click(); // Options: the plan, nothing to change
  await page.locator('#try-build:not([disabled])').waitFor({ timeout: 120_000 });
  await pause(2500);
  mark('build');
  await page.locator('#try-build').click();
  await page.locator('#try-done').waitFor({ timeout: 600_000 });
  mark('ready');
  // Your app's console opens on the test: wait until it has loaded, then show both versions side by side.
  await page.getByText(/tryit_release:/).first().waitFor({ timeout: 120_000 });
  await page.locator('#map .map-empty').waitFor({ state: 'detached', timeout: 60_000 }).catch(() => {});
  await pause(1500);
  mark('console');
  await page.locator('#map-show-previews').click();
  await pause(2500);
  mark('previews');
  await pause(3000);
} else if (clip === 'flagsmith') {
  // Flagsmith's own dashboard on your machine, with Turnout's tour on top (:8001). The sign-in is the local stack's
  // own test login, which the console gives this machine's pages; it is never printed.
  const LOCAL = process.env.TURNOUT_LOCAL ?? 'http://127.0.0.1:8090';
  await page.goto(`${LOCAL}/`);
  const tok = await page.locator('meta[name="turnout-console"]').getAttribute('content');
  const login = await page.evaluate(async (t) => (await fetch('/api/flagsmith-login', { headers: { 'x-turnout-console': t } })).json(), tok);
  // Where the console's Flagsmith link goes: the release flag in the dashboard.
  await page.waitForFunction(() => /^http/.test(document.getElementById('menu-flagsmith')?.getAttribute('href') ?? ''), null, { timeout: 30_000 });
  const flagPage = await page.locator('#menu-flagsmith').getAttribute('href');
  await page.goto('http://127.0.0.1:8001/');
  await page.locator('input[name="email"]').fill(login.email);
  await page.locator('input[name="password"]').fill(login.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !/\/login|\/$/.test(u.pathname) || u.pathname.length > 1, { timeout: 30_000 }).catch(() => {});
  await pause(3000);
  await page.goto(flagPage ?? 'http://127.0.0.1:8001/');
  // An older console links to the dashboard's front page: open the project, where the tour's button is.
  if (!(await page.locator('.tt-launch').isVisible().catch(() => false))) {
    await page.locator('a[href*="/project/"]').first().click({ timeout: 30_000 }).catch(() => {});
  }
  await page.locator('.tt-launch').waitFor({ timeout: 60_000 });
  await pause(2500);
  mark('dashboard');
  await page.locator('.tt-launch').click();
  for (let i = 0; i < 8; i++) {
    const next = page.locator('.tt-btn.pri');
    await next.waitFor({ timeout: 20_000 }).catch(() => {}); // a stop on another page: Flagsmith loads it first
    if (!(await next.count())) break;
    await pause(1200);
    mark(`stop ${i + 1}`);
    await pause(2600);
    const done = /Done/.test((await next.textContent()) ?? '');
    await next.click();
    await pause(1500);
    if (done) break;
  }
} else if (clip === 'features') {
  await page.goto(`${LIVE}/judge/flagsmith`);
  await page.locator('.round').first().waitFor({ timeout: 30_000 });
  await pause(1500);
  mark('top');
  for (let i = 0; i < 14; i++) {
    await page.mouse.wheel(0, 120);
    await pause(140);
  }
  await pause(1500);
  mark('filter');
  await page.locator('.fcount button', { hasText: 'Needs' }).first().click();
  await pause(2500);
  await page.locator('#search').fill('');
  await page.locator('#search').pressSequentially('health', { delay: 90 });
  await pause(2500);
}

const end = (Date.now() - t0) / 1000;
await page.close();
const video = await page.video()?.path();
await ctx.close();
await browser.close();
const raw = readdirSync(join(out, 'raw')).map((n) => join(out, 'raw', n)).find((p) => p === video) ?? video;
renameSync(raw, join(out, `${clip}.webm`));
writeFileSync(join(out, `${clip}.json`), JSON.stringify({ marks, end }, null, 2));
console.log(clip, 'recorded', end.toFixed(1), 's', marks.map((m) => `${m.label}@${m.t.toFixed(1)}`).join(' '));
