# Results

Every measurement here was run during Toggle Wars, on 27 Nov 2026 unless a section says otherwise. Times are UTC.

- **This machine:** Windows 11, Docker Desktop 29.9.3 (Compose 5.7.0), Node 26.12.0.
- **The live demo's VM:** Azure, 2 vCPU, 7.7 GiB RAM, Ubuntu (kernel 7.0.0-1020-azure), Docker 29.10.0, Compose 5.8.0, public at https://172-198-62-67.sslip.io.
- **Everywhere:** Flagsmith `2.291.0` (`docker.flagsmith.com/flagsmith/flagsmith:2.291.0`), `@flagsmith/nodejs` 9.4.0.
- **Shoppers and visitors are simulated** unless a section says otherwise.

## Unit tests and type check (04:07–04:08)

`npm test`, after today's changes: **684 tests in 84 suites: 683 pass, 0 fail, 1 skipped**, in 30 s. `tsc --noEmit`: clean. (Before the changes, at 02:37: 681 tests, 680 pass, 0 fail, 1 skipped.) One test, the autopilot's idle timer in `test/judge.test.ts`, timed out twice while this machine was also running the Docker stacks; it passed on each run of its own and in this run.

## The 12-app scoreboard (02:36–02:50)

`npm run scoreboard` on the local stack, rebuilt from the current code first (`docker compose up -d --build --wait turnout console tryit`; doctor 29 ok, 0 warnings, 0 failing). Each app goes through Try it the way the console page does it, both versions built from the app's folder. Every stage's notes: [scoreboard/last-run.json](../scoreboard/last-run.json).

| app | build | start | goals | visitors | results | counts | ship | time |
|---|---|---|---|---|---|---|---|---|
| django | pass | pass | pass | pass | pass | pass | pass | 74 s |
| express | pass | pass | pass | pass | pass | pass | pass | 76 s |
| flask | pass | pass | pass | pass | pass | pass | pass | 62 s |
| go | pass | pass | pass | pass | pass | pass | pass | 56 s |
| needs-database | pass | pass | pass | pass | pass | pass | pass | 73 s |
| needs-settings | pass | pass | pass | pass | pass | pass | pass | 80 s |
| next-server | pass | pass | pass | pass | pass | pass | pass | 67 s |
| next-static | pass | pass | **fail** | pass | pass | pass | pass | 64 s |
| no-dockerfile | pass | pass | pass | pass | pass | pass | pass | 97 s |
| php | pass | pass | pass | pass | pass | pass | pass | 67 s |
| plain-html | pass | pass | pass | pass | pass | pass | pass | 58 s |
| vite-spa | pass | pass | pass | pass | pass | pass | pass | 62 s |

**builds 12/12, starts 12/12, goals found 11/12, visitors 12/12, results 12/12, counts match 12/12, ships 12/12.** next-static fails on purpose: its only link answers 404 on nginx, so there is no goal to offer.

## `turnout compare` from an empty folder (02:50–03:03)

Two landing pages served by nginx: Start Bootstrap's Agency on :3001 and Creative on :3002. Another Turnout stack was already running on this machine, so ports 8080, 8090 and 8000 were taken.

| Check | Result |
|---|---|
| `turnout compare localhost:3001 localhost:3002` in an empty folder, no questions | **271 s** to running, exit 0. Check: 27 ok, 0 warnings, 0 failing. App on 8082, console on 8093 (each the next free port) |
| 2,000 brand-new visitors (no cookie, browser user agent), `--split 50` | new version **986 of 2,000 (49.3%)** |
| One visitor, 20 more page loads with their cookie | **20 of 20** on the same version |
| Run again with `--split 20` | "Different versions or settings start a new experiment: the previous one's data is discarded." Check: 27 ok |
| 2,000 brand-new visitors at `--split 20` | new version **410 of 2,000 (20.5%)** |
| `ship v2 --yes` | Pause, snapshot, default = v2, drain, complete: all five steps done, recorded in `.turnout/RELEASES.md` |
| 100 brand-new visitors after Ship | **100 of 100** on the winner |

## Ending an experiment: the documented order against Ship winner (03:50–03:51)

`node spikes/07-round04.ts` on the local stack: two throwaway experiments (100% rollout, 50/50), and the same 300 fresh identities through a local-evaluation SDK after each step.

| | What the 300 identities get |
|---|---|
| A, while running | control 150, v2 150 (all enrolled) |
| **A, after Complete, then setting the flag's default to v2 (the documented order)** | **control 150, v2 150: the split survives, and the edit reaches nobody** |
| B, while running | control 144, v2 156 (all enrolled) |
| **B, after Turnout's Ship winner (pause → default = v2, enabled → rollout 0% with v2 weights → complete)** | **v2 300** |
| **B, after one environment-default edit back to control** | **control 300** |

## Live demo VM: Flagsmith stopped (03:10–03:11)

100 page loads through the public HTTPS address (`https://shop.172-198-62-67.sslip.io/`), each a new visitor (no cookie, browser user agent), sent from this machine over the internet, so most of each time is the network.

| | Pages served | Mean | Median | Max |
|---|---|---|---|---|
| Flagsmith running (02:36) | 100 of 100 (all 200) | 170 ms | 170 ms | 221 ms |
| **Flagsmith's API and task processor stopped** (`docker compose stop flagsmith flagsmith-task-processor`) | **100 of 100 (all 200)** | **173 ms** | 168 ms | 295 ms |

The proxy evaluates the flag locally from its last environment document, so pages don't wait on Flagsmith. Both were started again afterwards and came back healthy.

## Live demo VM: 5,000 visitors in one run (03:15)

The autopilot was switched off for the load runs (`TURNOUT_AUTOPILOT=off`) so only the test's visitors count, and switched back on afterwards. `turnout demo --visitors 5000 --concurrency 20`, with `docker stats` every 3 s.

- **31 s.** 2,477 visitors on shop:1.4, 2,523 on shop:1.5.
- **Events:** the proxy handed Flagsmith's SDK **20,097** events (`/__turnout/health` with the debug token, before and after), and **20,097** new rows appeared in Flagsmith's `experimentation_sdkexperimentationevent` table: page speed 9,013, server errors 9,013, add to cart 1,489, orders 582. **0 dropped by the SDK, 0 failed batches.** Flagsmith stayed healthy.
- **Peak memory:** flagsmith 605 MiB, postgres 484 MiB, task processor 241 MiB, the simulator 221 MiB, proxy 118 MiB, live proxy 48 MiB, each shop about 42 MiB, console 39 MiB, caddy 16 MiB (sum of peaks 1.87 GiB, of 7.7 GiB).

## Live demo VM: events under load (03:15–03:20)

Each run: `turnout demo --visitors N --concurrency C`, then 25 s for the last batch. "Handed" is what both proxies gave the SDK (their counters, before and after); "stored" is the run's new rows in Flagsmith's own table, per event.

| Visitors | Concurrency | Time | Handed | Stored | Dropped by SDK | Failed batches |
|---|---|---|---|---|---|---|
| 5,000 | 20 | 31 s | 20,097 | 20,097 | 0 | 0 |
| 3,000 | 20 | 18 s | 11,970 | 11,970 | 0 | 0 |
| 3,000 | 50 | 18 s | 12,065 | 12,065 | 0 | 0 |
| 3,000 | 100 | 22 s | 12,024 | 12,024 | 0 | 0 |
| 3,000 | 200 | 19 s | 11,985 | 11,985 | 0 | 0 |

**68,141 events handed, 68,141 stored, every event name equal in every run.** Three batches took over 5 s (the slowest 12.1 s): the condition in which the Node SDK drops events without Turnout's hold-back (below). The SDK's buffer peaked at 6,312 events held. Rows sharing visitor, event, timestamp and value exist (794 to 2,295 per run), but the totals match exactly and no batch failed, so none was retried: they are separate events, not double-stored ones.

## Live demo VM: Ship and Revert under live traffic (03:29–03:38)

A probe inside the proxy's container sent a brand-new visitor (no cookie, browser user agent) every 0.1 s and logged the release each got (the debug header). Meanwhile the guided demo's own public buttons drove A/B tests: start, 1,200 shoppers, ask Flagsmith, then Ship if Turnout recommended it, otherwise Revert. The demo draws hidden random order rates for each test, so most tests had no winner to ship. The two clocks differed by 1.19 s (corrected); the uncertainty is about ±0.7 s.

| Decision | Took | New visitors after it finished | On the decided version |
|---|---|---|---|
| **Ship shop:1.5** (experiment 243: Flagsmith 98.1%, interval +3% to +94%) | 12.7 s | 514, over 51 s | **514 of 514** |
| Revert to shop:1.4, ×7 | 8.6–9.6 s | 2,091 | 2,086; the other 5 came within 0.4 s of the moment the driver saw the decision finish, inside the clock uncertainty. From then on, every one |

5,829 probe visitors, 0 errors.

## Live demo VM: reboot (03:40)

`sudo systemctl reboot` at 03:40:22.

- **Booted** at 03:40:38 (16 s). **Every container started** by itself at 03:40:51 (29 s): restart policies, no manual step.
- **Console healthy at 03:41:24 (62 s), after 6 restarts.** Its log: `fetch failed (ECONNREFUSED)`. With Feature Health or the guard configured, as on the VM, the console reads the environment's name from Flagsmith at start, and exited because Flagsmith wasn't accepting connections yet; Docker's restart policy kept retrying. **Fixed:** the console now waits for Flagsmith (up to 3 minutes) at that step (`src/wait-for.ts`, `test/wait-for.test.ts`).
- Afterwards: public `/judge` and the shop answered 200; doctor: 34 ok, 1 warning, 0 failing; the autopilot running.

## Blind rounds during the hackathon (26 Nov 06:31 to 27 Nov 02:29)

The live demo's autopilot runs A/B tests with hidden random rates and grades each call once decided. The 41 rounds decided since the hackathon started (26 Nov, 08:00 IST): [docs/BLIND_ROUNDS.md](../docs/BLIND_ROUNDS.md), every round in [docs/blind-rounds.json](../docs/blind-rounds.json).

## Flagsmith Node SDK: events lost faster than one batch round-trip (03:50–04:00)

SDK-only reproduction, no Turnout: [`sdk-buffer-repro/repro.mjs`](sdk-buffer-repro/repro.mjs) against a local stand-in for Flagsmith's events endpoint that answers like 2.291.0 (202, or 413 over 2 MiB) after a set delay. Each SDK version installed fresh from npm. Raw output: [`results.jsonl`](sdk-buffer-repro/results.jsonl).

| SDK | Events/s × s | Batch round-trip | Buffer, flush | Tracked | Received | Lost | Logged as dropped |
|---|---|---|---|---|---|---|---|
| 9.4.0 | 100 × 60 | 0.2 s | default (1,000), default (10 s) | 6,000 | 6,000 | 0 | 0 |
| 9.4.0 | 300 × 30 | 5 s | default, default | 9,000 | 6,450 | **2,550 (28.3%)** | 2,550 |
| 9.4.0 | 150 × 60 | 10 s | default, default | 9,000 | 6,476 | **2,524 (28.0%)** | 2,524 |
| 9.4.0 | 700 × 30 | 4 s | 7,000, 1 s | 21,000 | 21,000 | 0 | 0 |
| 9.4.0 | 700 × 30 | 20 s | 7,000, 1 s | 21,000 | 13,957 | **7,043 (33.5%)** | 7,043 |
| 9.4.0 | 700 × 40 | 30 s | 20,000, 1 s | 28,000 | 2,085 | **25,915 (92.6%)**; 2 batches over 2 MiB refused whole (413) | 8,000 |
| 9.5.0 (latest) | 300 × 30 | 5 s | default, default | 9,000 | 6,459 | **2,541 (28.2%)** | 2,541 |
| 9.5.0 (latest) | 150 × 60 | 10 s | default, default | 9,000 | 6,471 | **2,529 (28.1%)** | 2,529 |

While one batch is in flight, a full buffer drops its oldest events, reported only as a log warning; a bigger buffer only makes each batch bigger, until Flagsmith refuses it whole. Turnout's hold-back (its own events wait while the SDK's buffer is nearly full) is why the live demo's load runs above lost nothing. Reported upstream: [flagsmith-nodejs-client#330](https://github.com/Flagsmith/flagsmith-nodejs-client/issues/330), fix PR [#331](https://github.com/Flagsmith/flagsmith-nodejs-client/pull/331).
