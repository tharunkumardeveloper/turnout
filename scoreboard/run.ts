// The scoreboard: every sample app in scoreboard/apps through Try it, end to end, the way the console's page drives it.
// build → start → goals → visitors → Flagsmith results → counts match → Ship, pass or fail per stage.
//
//   npm run scoreboard                      every app (Turnout running: turnout.bat or sh turnout.sh)
//   npm run scoreboard -- flask express     only these
//   TURNOUT_CONSOLE=http://127.0.0.1:8090   where the console is (default)
//
// Nothing is tuned for one app: every app gets the same calls, and the goal is the one Try it picks from the running app.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error: a plain browser module with no types (the console page loads it as is)
import { SKIP, tarParts } from '../src/console/ui/try-model.js';

const CONSOLE = (process.env.TURNOUT_CONSOLE ?? 'http://127.0.0.1:8090').replace(/\/$/, '');
const HERE = fileURLToPath(new URL('.', import.meta.url));
const APPS = join(HERE, 'apps');
const VISITORS = 300;
const RATES = [0.1, 0.2]; // pretend conversion rates for A and B: enough for Flagsmith's 5 conversions per version
const BUILD_TIMEOUT_MS = 20 * 60_000;
const JOB_TIMEOUT_MS = 10 * 60_000;

export const STAGES = ['build', 'start', 'goals', 'visitors', 'results', 'counts', 'ship'] as const;
type Stage = (typeof STAGES)[number];
type Outcome = { pass: boolean; note: string };
type Row = { app: string; stages: Partial<Record<Stage, Outcome>>; seconds: number };

let token = '';
async function call<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${CONSOLE}${path === '/try/upload' ? '/api' : '/try/api'}${path}`, {
    ...init,
    headers: { 'x-turnout-console': token, 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${path}: HTTP ${res.status}`);
  return body;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function filesOf(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(APPS, full).replaceAll('\\', '/').split('/').slice(1).join('/');
    if (SKIP.test(rel)) continue;
    if (statSync(full).isDirectory()) out.push(...filesOf(full));
    else out.push(rel);
  }
  return out;
}

async function upload(dir: string, files: string[]): Promise<string> {
  const entries = files.map((path) => {
    const data = new Uint8Array(readFileSync(join(dir, path)));
    return { path, size: data.length, data };
  });
  const body = Buffer.concat(tarParts(entries));
  return (await call<{ id: string }>('/try/upload', { method: 'POST', body, headers: { 'content-type': 'application/x-tar' } })).id;
}

async function job(action: string, extra: object = {}): Promise<any> {
  const experimentId = (await call('/judge/state')).experiment?.id;
  await call('/judge/run', { method: 'POST', body: JSON.stringify({ action, experimentId, ...extra }) });
  const until = Date.now() + JOB_TIMEOUT_MS;
  while (Date.now() < until) {
    await sleep(1000);
    const { job: j } = await call('/judge/job');
    if (j?.action === action && j.status === 'done') return j;
    if (j?.action === action && j.status === 'failed') throw new Error(j.error ?? `${action} failed`);
  }
  throw new Error(`${action} didn't finish in ${JOB_TIMEOUT_MS / 60_000} min`);
}

async function runApp(app: string): Promise<Row> {
  const started = Date.now();
  const row: Row = { app, stages: {}, seconds: 0 };
  const set = (s: Stage, pass: boolean, note = '') => (row.stages[s] = { pass, note: note.replace(/\s+/g, ' ').slice(0, 160) });
  const dir = join(APPS, app);
  try {
    const files = filesOf(dir);
    // A build left running (a run stopped halfway) has to finish first: Try it builds one thing at a time.
    while ((await call('/try/status')).status === 'building') await sleep(3000);
    const id = await upload(dir, files);
    const buildOnce = async (extra: object) => {
      const request = { method: 'POST', body: JSON.stringify({ versions: [{ kind: 'folder', value: id }, { kind: 'folder', value: id }], goal: '', rates: RATES, ...extra }) };
      for (let i = 0; ; i++) {
        try {
          await call('/try/build', request);
          break;
        } catch (error) {
          // A build or test step still running (from a run stopped halfway): wait for it, up to 15 minutes.
          if (i > 300 || !/running/i.test((error as Error).message)) throw error;
          await sleep(3000);
        }
      }
      const until = Date.now() + BUILD_TIMEOUT_MS;
      let s: any;
      do {
        await sleep(2000);
        s = await call('/try/status');
      } while (s.status === 'building' && Date.now() < until);
      return s;
    };
    let st = await buildOnce({});
    // What the console's "needs" card offers, one click: a throwaway database, and the settings it named (test values).
    let clicked = '';
    if (st.status === 'failed' && st.needs) {
      const env = (st.needs.settings as string[]).filter((n) => !(st.needs.database && /^(DATABASE_URL|DB_|POSTGRES|MYSQL)/.test(n))).map((n) => `${n}=turnout-test`).join('\n');
      clicked = [st.needs.database && `a throwaway ${st.needs.database}`, env && `settings ${env.replace(/=turnout-test/g, '').replace(/\n/g, ', ')}`].filter(Boolean).join(' and ');
      st = await buildOnce({ ...(st.needs.database ? { database: st.needs.database } : {}), env });
    }
    const stageOk = (i: number) => st.versions.length > 0 && st.versions.every((v: any) => v.stages[i]?.status === 'done');
    set('build', stageOk(0), stageOk(0) ? '' : (st.error ?? st.status));
    if (!stageOk(0)) return row;
    set('start', stageOk(1), stageOk(1) ? `port ${st.versions[0].port}${clicked ? `, after one click: ${clicked}` : ''}` : (st.error ?? st.status));
    // The goal Try it picked from the running versions (none given): the first of the actions it found.
    const actions = (st.actions ?? []) as { goal: string }[];
    set('goals', actions.length > 0, actions.length ? `${st.goal} (of ${actions.map((a) => a.goal).slice(0, 4).join(', ')})` : 'none found on the running app');
    if (st.status !== 'ready') {
      if (stageOk(1)) set('start', false, st.error ?? st.status); // running, but the test didn't start
      return row;
    }

    const sent = await job('visitors', { visitors: VISITORS });
    const byRelease: Record<string, { visitors: number; orders: number }> = sent.result?.byRelease ?? {};
    const total = Object.values(byRelease).reduce((n, t) => n + t.visitors, 0);
    set('visitors', total > 0, Object.entries(byRelease).map(([r, t]) => `${r} ${t.visitors} (${t.orders} goals)`).join(', '));
    if (!total) return row;

    await job('score');
    const state = await call('/judge/state');
    const results = state.results;
    set('results', Boolean(results?.metrics?.length), results?.winner ? `${results.winner.key} ${Math.round(results.winner.chanceToWin * 100)}%` : (results ? 'no winner yet' : 'no results'));
    if (!results?.metrics?.length) return row;

    // Visitors Turnout sent per version vs the identities Flagsmith counted per arm, on the goal metric.
    const goal = results.metrics.find((m: any) => m.role === 'goal') ?? results.metrics[0];
    const arms: { key: string; release: string | null }[] = state.experiment?.arms ?? [
      { key: 'control', release: state.experiment?.control },
      { key: 'v2', release: state.experiment?.v2 },
    ];
    const diffs = arms.map((a) => ({ release: a.release, ours: byRelease[a.release ?? '']?.visitors ?? 0, theirs: goal.arms[a.key]?.n ?? 0 }));
    set('counts', diffs.every((d) => d.ours === d.theirs), diffs.map((d) => `${d.release} ${d.ours} vs ${d.theirs}`).join(', '));

    try {
      await job('ship');
      set('ship', true);
    } catch (error) {
      set('ship', false, (error as Error).message);
    }
  } catch (error) {
    const first = STAGES.find((s) => !row.stages[s]);
    if (first) set(first, false, (error as Error).message);
  } finally {
    row.seconds = Math.round((Date.now() - started) / 1000);
  }
  return row;
}

function print(rows: Row[]) {
  const mark = (o?: Outcome) => (o ? (o.pass ? 'pass' : 'FAIL') : '-');
  const w = Math.max(...rows.map((r) => r.app.length), 4);
  console.log(`\n${'app'.padEnd(w)}  ${STAGES.map((s) => s.padEnd(9)).join('')}time`);
  for (const r of rows) console.log(`${r.app.padEnd(w)}  ${STAGES.map((s) => mark(r.stages[s]).padEnd(9)).join('')}${r.seconds}s`);
  console.log('\nWhy each failure:');
  for (const r of rows) for (const s of STAGES) if (r.stages[s] && !r.stages[s]!.pass) console.log(`  ${r.app} ${s}: ${r.stages[s]!.note}`);
  const words: Record<Stage, string> = { build: 'builds', start: 'starts', goals: 'goals found', visitors: 'visitors', results: 'results', counts: 'counts match', ship: 'ships' };
  console.log(`\n${STAGES.map((s) => `${words[s]} ${rows.filter((r) => r.stages[s]?.pass).length}/${rows.length}`).join(', ')}`);
}

const page = await fetch(`${CONSOLE}/app`).then((r) => r.text()).catch(() => '');
token = page.match(/name="turnout-console" content="([^"]+)"/)?.[1] ?? '';
if (!token) {
  console.error(`No Turnout console with Try it at ${CONSOLE}: start it with turnout.bat or sh turnout.sh.`);
  process.exit(1);
}
const wanted = process.argv.slice(2);
const apps = readdirSync(APPS).filter((a) => statSync(join(APPS, a)).isDirectory() && (!wanted.length || wanted.includes(a)));
const rows: Row[] = [];
for (const app of apps) {
  process.stdout.write(`${app}… `);
  const row = await runApp(app);
  rows.push(row);
  console.log(STAGES.map((s) => `${s} ${row.stages[s] ? (row.stages[s]!.pass ? 'ok' : 'FAIL') : '-'}`).join(', '));
}
print(rows);
writeFileSync(join(HERE, 'last-run.json'), JSON.stringify({ at: new Date().toISOString(), rows }, null, 2) + '\n');
