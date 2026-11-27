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

## Wipe, start again, resume (04:45–04:54)

The same folder as above, after its Ship.

| Step | Result |
|---|---|
| `turnout reset --yes` | 7 s: containers and volumes removed, state wiped |
| `turnout compare localhost:3001 localhost:3002` after the wipe (a fresh Flagsmith, set up from nothing) | **274 s** to running, exit 0. Check: 27 ok, 0 warnings, 0 failing |
| The same command again, on the running setup | **81 s**, exit 0, check 27 ok; 200 new visitors: 91 and 109; one visitor 20 of 20 on the same version |

## The launcher scripts in a Linux shell (04:54–04:58)

`docker:cli` (Alpine 3.24.4, BusyBox, Docker CLI 29.10.1, Compose 5.8.0) with this machine's Docker socket, the project mounted at the path Docker Desktop's engine uses for it. A real Linux shell and toolset; not macOS.

- `sh turnout.sh status` against the running stack: **29 ok, 0 warnings, 0 failing.**
- `sh setup.sh` (no terminal, so nothing installed): all 8 checks ran: "Ready. 1 warning(s)": Node.js isn't installed in that image (needed only for development). It also wrote `TURNOUT_UID=0` and `TURNOUT_GID=0` to `.env`, as designed for the user running it (root in that container); those two lines were removed afterwards, since the stack here runs on Windows.

## Page speed in real browsers, end to end (05:28–05:35)

The new `lcp_ms` and `cls` guardrails on the local stack: `turnout.config.yml` lists them, `init` created both metrics in Flagsmith, and the guided demo started an A/B/C test (experiment 391: shop:1.5 vs shop:1.6 vs shop:1.4). Then 180 real Chrome visitors (Playwright, a normal Chrome user agent, each a new browser): load the shop through the proxy, read the page's own LCP in the browser, leave the page.

- **180 of 180** pages carried the script; the proxy handed Flagsmith **180 `lcp_ms` and 180 `cls` events**, one each; Flagsmith's table held 362 of each over this run and an earlier one of 182 visitors.
- **Flagsmith's own results** (the guided demo's Ask Flagsmith):

| | Visitors | `lcp_ms` in Flagsmith | LCP read in the page | `doc_latency_ms` |
|---|---|---|---|---|
| shop:1.4 (control) | 53 | 151.9 ms | 153 ms | 7.8 ms |
| shop:1.5 | 68 | 163.3 ms (+7.5%, interval −4% to +18%) | 163 ms | 9.0 ms |
| shop:1.6 (60 ms test fault) | 57 | **235.8 ms (+55%, interval +41% to +69%, 0% chance to win)** | 236 ms | 69.1 ms |

- **CLS:** the shop's layout never moves, so `cls` was 0 everywhere. A second check put the real proxy and script in front of two pages, one that pushes a 300 px banner in above the text after 300 ms, and sent 6 Chrome visitors: the jumping page reported **0.2344** each time, the still page **0**.
- **The floors:** shop:1.6's LCP is 84 ms later, under the 100 ms floor, so `lcp_ms` alone doesn't call it losing; its 61 ms server delay already fails `doc_latency_ms`.
- **Found and fixed:** a new experiment copied the previous one's metrics, so a guardrail added to the config never reached one (the first test, experiment 390, had no `lcp_ms`). The guided demo now takes each new test's metrics from `turnout.config.yml`.

## Browser page speed when some visitors don't report (06:20–06:30)

A browser that never reports counts as 0 ms in Flagsmith's mean. To see it, the same local stack (experiment 392, shop:1.5 vs shop:1.6 vs shop:1.4) and 180 Chrome visitors, but on 27 of 1.6's 60 visits the page-speed script was blocked, as an ad blocker or an early exit would.

| | Visitors | Reported (`vitals_reported`) | LCP read in the page | `lcp_ms` in Flagsmith |
|---|---|---|---|---|
| shop:1.4 (control) | 69 | 100% | 164 ms | 164.2 ms |
| shop:1.5 | 51 | 100% | 170 ms | 170.4 ms (+4%) |
| shop:1.6 | 60 | **55%** | 238 ms | **128.1 ms: "22% faster", 98.6% chance to win** |

The bias is real: Flagsmith's numbers alone called the slowest release the fastest. **Fix, checked on these results:** the proxy records `vitals_reported` per reporting visitor; `lcp_ms` and `cls` decide only when both versions' reporting rates are within 5 points. Turnout's own functions on experiment 392: shop:1.5 comparable (100% vs 100%); shop:1.6 **not compared**, "55% of v3's visitors reported it against 100% of control's, and a visitor who didn't report counts as 0", and still losing on `doc_latency_ms`.

## `turnout browsers`: real-browser visits from the command line (06:43–06:52)

The two landing pages again, from the same folder: `turnout compare localhost:3001 localhost:3002 --browser-speed` (a new experiment, since the settings changed; check 29 ok; guardrails `server_error, lcp_ms, cls`), then `turnout browsers --visits 60`. The launcher set up the separate Demo environment, started the simulation proxy and a headless Chrome (`chromedp/headless-shell:stable`, pulled on first use), and the CLI sent the visits over the Chrome DevTools Protocol, each a fresh browser profile with the user agent `… TurnoutBrowserVisit/1.0`.

- **60 of 60 visits, 0 failed, page speed reported by 60**, in 2 min 27 s including the Chrome image's download.
- Flagsmith's results in the Demo environment: `lcp_ms` v1 (Agency) 1,507.6 ms against v2 (Creative) 784.7 ms; `vitals_reported` 100% on both; 30 visitors each, under Flagsmith's minimum of 50, so "collecting data".
- **Found and fixed:** `turnout simulate` wrote its console's port to the settings `compare` compares on resume, so running `compare` again with the same arguments after a simulation started a new experiment and discarded the data. The comparison now leaves that line out, as the Windows launcher already did.

## The GitHub Action's report and pull-request comment (05:40)

The real `turnout check` against the local Flagsmith, with GitHub Actions' variables set and a stand-in for GitHub's API on 127.0.0.1:

- `check` exited 1 on a real finding (a leftover split from the experiments above) and wrote the Markdown report to `TURNOUT_REPORT_FILE` and `GITHUB_STEP_SUMMARY`: "❌ Turnout check: 1 problem found", the output unfolded.
- `turnout pr-comment`, run twice for pull request 12: the first run **posted** a comment, the second **edited that same comment** (GET, POST, then GET, PATCH). A run whose event isn't a pull request skipped the comment and said so.

## The same experiment with the SDK in the app (05:40–05:52)

[examples/with-sdk/server.ts](../examples/with-sdk/server.ts): the demo shop's experiment written with `@flagsmith/nodejs` 9.4.0 inside the app (45 lines of code, 7 Flagsmith calls), run against the local Flagsmith on experiment 391.

- **First run: wrong, silently.** All 30 visitors got shop:1.4, and Flagsmith stored none of their events. Two causes: visitors arrived before the SDK had loaded the environment document, so each got the flag's default; and the SDK posts events to `https://events.api.flagsmith.com/v1/events` (Flagsmith Cloud) unless `eventsApiUrl` is set, whatever `apiUrl` says. That run's events (random visitor ids, page timings) went to Flagsmith Cloud.
- **Fixed** (`await flagsmith.getEnvironmentFlags()` at start, `eventProcessorConfig.eventsApiUrl`): 30 visitors split 13 / 12 / 5 (1.5 / 1.4 / 1.6), 0 switched version on a second page; Flagsmith stored 30 exposures, 30 add-to-carts, 10 orders, 60 page-speed and 60 server-error events.
- With Turnout the same experiment is 0 lines in the shop and 12 lines of `turnout.config.yml`. The comparison: [examples/with-sdk/README.md](../examples/with-sdk/README.md).

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
- **Re-run after the fix (07:37):** `sudo systemctl reboot` at 07:37:10; booted 07:37:24; every container started at 07:37:38 with **0 restarts**; the console logged "Waiting for Flagsmith at http://flagsmith:8000 (ECONNREFUSED)…" then "Flagsmith answers (after 11 s)", and became healthy; public `/judge` answered 200 about 47 s after the reboot command; doctor 36 ok, 1 warning, 0 failing; the autopilot running. This deploy also recreated Postgres under its Compose name (`turnout-practice-postgres-1`, no fixed `container_name`) with its data: experiment numbers carried on from 332.
- **After that deploy (07:29–07:37):** two autopilot rounds finished with the new `lcp_ms`, `cls` and `vitals_reported` metrics on the experiment; the simulated shoppers send no browser page speed, so those show "no events in either release" and the decisions went ahead as before, now logged "automatically by the live demo's autopilot".

## Live demo VM: Feature Health in Flagsmith's own dashboard (26 Nov 06:32 to 27 Nov 04:42)

The live demo's console reports the release flag's health to Flagsmith's Feature Health (its Webhook provider) while each experiment runs. Flagsmith's own table, `feature_health_featurehealthevent`, from the start of the hackathon: **16 Unhealthy and 84 Healthy reports**. For example, experiment 280 (shop:1.6 vs shop:1.5): Unhealthy at 04:42:19 with Flagsmith's numbers as the reason ("doc_latency_ms 64 on shop:1.6 vs 2.586 on control"), Healthy again at 04:42:39 once the experiment was decided. The guard (automatic revert) is off on the live demo (`TURNOUT_GUARD=off`), so every decision there was the autopilot's or a visitor's.

**Found while checking:** the release log said "by a person" for every decision, the autopilot's included (383 entries). Fixed: the autopilot now passes its own name with each action, outside the request body so a public request can't claim it, and the log says "automatically by the live demo's autopilot" (`src/console/autopilot.ts`, `src/ledger.ts`, tests in `test/autopilot.test.ts` and `test/ledger.test.ts`).

## Blind rounds during the hackathon (26 Nov 06:31 to 27 Nov 07:18)

The live demo's autopilot runs A/B tests with hidden random rates and grades each call once decided. The first 111 rounds decided since the hackathon started (26 Nov, 08:00 IST), experiments 186 to 330; a watcher kept the public page open so the autopilot kept running. Turnout's recommendation right in 105 of 111; Flagsmith called 36 of 38 real differences, never in the wrong direction; 2 false calls in 28 no-difference rounds; all 45 rounds with the slow release rolled back on page speed. Shipping whenever Flagsmith was 95% sure would have shipped 38 releases, 14 of them bad; Turnout's rule shipped 24, 1 bad. The write-up: [docs/BLIND_ROUNDS.md](../docs/BLIND_ROUNDS.md); every round: [docs/blind-rounds.json](../docs/blind-rounds.json).

## A real finding: Gitea 1.27.3 against 28.0.0 (07:00–07:22)

`gitea/gitea:1.27.3` and `gitea/gitea:28.0.0`, each with the same seeded repository, behind `turnout compare localhost:3101 localhost:3102 --browser-speed`; then `turnout browsers --visits 240 --path /demo/demo --latency 50` and `--visits 700`: **940 of 940 visits reported page speed** (469 on 28.0.0, 471 on 1.27.3). Flagsmith's results at 07:21:54:

```text
doc_latency_ms (mean per exposed identity, down): v2 44.3 (n=469), control 51.3 (n=471)
  v2: lift -13.8% (interval −21% to −6%), chance to win 100.0%
lcp_ms (mean per exposed identity, down): v2 708.6 (n=469), control 671.5 (n=471)
  v2: lift 5.5% (interval −3% to +14%), chance to win 10.4%
cls (mean per exposed identity, down): v2 0.0 (n=469), control 0.0 (n=471)
vitals_reported (occurrence, up): v2 1.000 (n=469), control 1.000 (n=471)
```

After the first 240 visits: `doc_latency_ms` −8.5% (−26% to +9%), `lcp_ms` +8.0% (−13% to +29%), both unsettled. What it means and its limits: [docs/FINDING_GITEA.md](../docs/FINDING_GITEA.md).

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
