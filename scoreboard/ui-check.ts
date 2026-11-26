// The UI check: every page and dialog of a running Turnout, in headless Chrome, at phone, tablet, laptop and desktop
// widths. It fails on a script error, on a failed call to the console's own API, or on a page wider than the screen
// (sideways scrolling), and saves a screenshot of each for a person to look at.
//
//   npm run ui-check                         Turnout running (turnout.bat or sh turnout.sh); Chrome or Edge installed
//   TURNOUT_CONSOLE=http://127.0.0.1:8090    where the console is (default)
//   CHROME=/path/to/chrome                   which browser (default: the usual install places)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONSOLE = (process.env.TURNOUT_CONSOLE ?? 'http://127.0.0.1:8090').replace(/\/$/, '');
const OUT = join(fileURLToPath(new URL('.', import.meta.url)), 'ui-shots');
const PORT = 9400 + Math.floor(Math.random() * 400);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const browser = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => p && existsSync(p));
if (!browser) {
  console.error('No Chrome or Edge found: set CHROME=/path/to/chrome and run npm run ui-check again.');
  process.exit(1);
}
const page = await fetch(`${CONSOLE}/`).catch(() => null);
if (!page?.ok) {
  console.error(`No Turnout console at ${CONSOLE}: start it with turnout.bat or sh turnout.sh, then run npm run ui-check again.`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
const chrome = spawn(browser, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'tn-ui-'))}`, '--hide-scrollbars', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let ver: { webSocketDebuggerUrl: string } | null = null;
for (let i = 0; i < 150 && !ver; i++) {
  await sleep(200);
  ver = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json() as Promise<{ webSocketDebuggerUrl: string }>).catch(() => null);
}
if (!ver) {
  chrome.kill();
  console.error(`${browser} didn't start its debugging port within 30 s.`);
  process.exit(1);
}
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map<number, (m: any) => void>();
const listeners: ((m: any) => void)[] = [];
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(String(m.data));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
  } else for (const l of listeners) l(msg);
});
const send = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((res) => {
  const i = ++id;
  pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params, sessionId }));
});

type Scene = { name: string; path: string; w: number; dark?: boolean; click?: string[] };
const WIDTHS = [390, 820, 1280, 1440];
const scenes: Scene[] = [];
for (const w of WIDTHS) {
  scenes.push({ name: `console-${w}`, path: '/', w }, { name: `app-${w}`, path: '/app', w }, { name: `setup-${w}`, path: '/setup', w }, { name: `flagsmith-${w}`, path: '/flagsmith', w });
  scenes.push({ name: `tryit-${w}`, path: '/', w, click: ['#try-open'] }, { name: `your-test-${w}`, path: '/app', w, click: ['#tp-open'] });
}
scenes.push({ name: 'console-dark', path: '/', w: 1440, dark: true }, { name: 'your-test-dark', path: '/app', w: 1440, dark: true, click: ['#tp-open'] });

const problems: string[] = [];
for (const sc of scenes) {
  const { result } = await send('Target.createTarget', { url: 'about:blank' });
  const s = (await send('Target.attachToTarget', { targetId: result.targetId, flatten: true })).result.sessionId as string;
  const errs: string[] = [];
  const own = new URL(CONSOLE).host;
  const listener = (msg: any) => {
    if (msg.sessionId !== s) return;
    // A script error in the console itself (an app inside a preview frame may have errors of its own).
    if (msg.method === 'Runtime.exceptionThrown' && (() => { try { return new URL(msg.params.exceptionDetails.url ?? CONSOLE).host === own; } catch { return true; } })()) errs.push(`script error: ${msg.params.exceptionDetails.exception?.description?.split('\n')[0] ?? msg.params.exceptionDetails.text}`);
    // Only the console's own calls count: an app inside a preview frame may have errors of its own.
    if (msg.method === 'Network.responseReceived' && new URL(msg.params.response.url).host === own && msg.params.response.status >= 400) errs.push(`${msg.params.response.status} on ${new URL(msg.params.response.url).pathname}`);
  };
  listeners.push(listener);
  await send('Runtime.enable', {}, s);
  await send('Network.enable', {}, s);
  await send('Page.enable', {}, s);
  await send('Emulation.setDeviceMetricsOverride', { width: sc.w, height: sc.w < 600 ? 844 : 900, deviceScaleFactor: 1, mobile: sc.w < 600 }, s);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: sc.dark ? 'dark' : 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] }, s);
  await send('Page.navigate', { url: `${CONSOLE}${sc.path}` }, s);
  await sleep(6000);
  const evaluate = async (expression: string) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, s)).result?.result?.value;
  for (const sel of sc.click ?? []) {
    const r = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el || el.hidden) return 'missing'; el.click(); return 'ok'; })()`);
    if (r !== 'ok') errs.push(`${sel} isn't on the page`);
    await sleep(4000);
  }
  const width = await evaluate('document.documentElement.scrollWidth');
  if (width > sc.w + 1) errs.push(`the page is ${width} px wide on a ${sc.w} px screen (sideways scrolling)`);
  const shot = await send('Page.captureScreenshot', { format: 'png' }, s);
  writeFileSync(join(OUT, `${sc.name}.png`), Buffer.from(shot.result.data, 'base64'));
  listeners.splice(listeners.indexOf(listener), 1);
  await send('Target.closeTarget', { targetId: result.targetId });
  for (const e of [...new Set(errs)]) problems.push(`${sc.name}: ${e}`);
  console.log(`${errs.length ? 'FAIL' : 'ok  '} ${sc.name}${errs.length ? `: ${[...new Set(errs)].join('; ')}` : ''}`);
}
ws.close();
chrome.kill();
console.log(`\n${scenes.length - new Set(problems.map((p) => p.split(':')[0])).size}/${scenes.length} screens clean. Screenshots: ${OUT}`);
process.exit(problems.length ? 1 : 0);
