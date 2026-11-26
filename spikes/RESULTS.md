# Spike results

Flagsmith `2.291.0` (pinned compose), `@flagsmith/nodejs` `9.4.0`, Docker Desktop 29.9.3, Windows 11.

## 1–3. Bootstrap a fresh instance by API: yes (2026-11-17)
`turnout init` against a fresh instance (`/version/` → `has_users: false`):
- `POST /api/v1/auth/users/` with `superuser: true` created the admin and returned a token.
- That token created the organisation, project, environment, an Organisation API key (`master-api-keys`, `is_admin: true`) and a server-side key (`environments/<key>/api-keys/`).
- `warehouse-connections` with `{"warehouse_type":"postgres","config":{"source":"flagsmith_database"}}` came back `connected`.
- Flag `shop_release` (value `shop:1.4`), mv-option `v2` (`shop:1.5`, key `v2`), metrics (`order_placed` occurrence/up, `doc_latency_ms` and `server_error` mean/down) and the experiment were created and started.

**Hurdle:** the generated admin password was only printed once. `init` now saves it to `.env` as `FLAGSMITH_ADMIN_EMAIL` / `FLAGSMITH_ADMIN_PASSWORD`.

## 4. Local-evaluation exposures: yes (2026-11-17)
`node spikes/04-local-eval.ts`:
- The environment document's segments are `['experiment-1-rollout']`, so local evaluation sees the experiment.
- The environment default's variant weight is `[0]`, zeroed by the first rollout as `services.py:1000-1025` says. This is the reason the sample-ratio check gets no expected share.
- 200 new identities: `control=shop:1.4` 106, `v2=shop:1.5` 94, all 200 `inExperiment`.
- One events batch: `202 {"accepted":250,"rejected":[]}` (200 exposures + 50 conversions).

**The docs are behind the SDK.** The docs say experiments need remote evaluation; Node SDK 9.4.0 records exposures under local evaluation fine. Turnout keeps local evaluation.

## 5. Flagsmith's Prometheus counter: yes (2026-11-17)
From inside the `flagsmith` container, `:9100/metrics`:
```
flagsmith_experimentation_sdk_events_total{result="accepted"} 250.0
flagsmith_experimentation_sdk_events_total{result="rejected"} 0.0
flagsmith_experimentation_warehouse_connection_verifications_total{result="success"} 1.0
```
Port 9100 isn't published by the official compose, so the console reads it over the compose network (`http://flagsmith:9100/metrics`).

## 7–9. Round 04: the documented order misses everyone; Ship winner reaches everyone (2026-11-17)
`node spikes/07-round04.ts` creates two throwaway experiments (100% rollout, 50/50) and counts what the same 300 visitors get through a fresh local-evaluation SDK:

| | What the 300 visitors get |
|---|---|
| A, while running | control 144, v2 156 (all enrolled) |
| **A, after Complete, then setting the flag's default to v2 (the documented order)** | **control 144, v2 156: the split survives, and the edit reaches nobody** |
| B, while running | control 141, v2 159 (all enrolled) |
| **B, after Turnout's Ship winner (pause → default = v2, enabled → rollout 0% with v2 weights → complete)** | **v2 300** |
| **B, after one environment-default edit back to control** | **control 300** |

- Spike 7 (the problem) and spike 8 (the drain) hold on the real instance.
- Spike 9 holds through the API, and since 2026-11-18 through Flagsmith's own flag editor too (see "Spike 9 through Flagsmith's own flag editor" below).
- The spike's flags (`spike_documented_*`, `spike_turnout_*`) stay in the demo project.

## 6 and 10. Results show a leader; the sample-ratio check stays empty (2026-11-17)
`node src/cli.ts status --refresh` on the demo experiment, after spike 4's 200 visitors plus a few dozen through the proxy:
```
order_placed (occurrence, up): v2 0.238 (n=105), control 0.231 (n=117)
  v2: lift 3.2%, chance to win 55.0%
doc_latency_ms (mean, down): v2 6.7 (n=105), control 0.3 (n=117)
  v2: lift 1892.0%, chance to win 1.1%
server_error (mean, down): v2 0.0 (n=105), control 0.0 (n=117)
  v2: collecting data
sample-ratio check: not computed
```
- **Spike 6:** results compute once a refresh has run, and the winner rule picks v2 (55%).
- **Spike 10:** the sample-ratio result is `null` with 222 identities, above the 100 it needs. Confirmed live.
- **Direction DOWN works:** v2's seeded latency gives it only a 1.1% chance to win on latency.
- **Confirmed in source (2026-11-18):** Mean metrics are averaged over every exposed identity, with no-event identities counting as 0. Each identity's value is `avg_if` over its post-exposure events (`experimentation/results_query.py:123-124`), which returns 0 when there are none (`experimentation/warehouses/dialect.py:39-41`); `n` counts every non-quarantined exposed identity (`results_query.py:184-196`) and the arm's mean is `sum / n` (`experimentation/stats.py:35-36`). Spike 4's 200 SDK-only identities sent no latency events, so the mean latency is diluted (control 0.3 ms). Through the proxy every visitor sends latency, so the demo isn't affected. Turnout labels these figures "mean per exposed identity".
- **Observation:** a Mean 0/1 guardrail with no errors at all shows "collecting data" indefinitely. Flagsmith's statistics return no inference when control's mean is 0 (`experimentation/stats.py:60-61`). The console should say "no errors in either release" instead.

## Full demo from scratch, through Docker Compose (2026-11-17)
After `docker compose --profile tools down -v` (everything wiped):
1. `docker compose up -d`: Flagsmith healthy.
2. `… run --rm cli init`: admin, organisation, project, environment, keys, event store, flag, metrics and a running experiment. Keys were written to the host's `.env` through the mounted file.
3. `… up -d --build`: proxy, console, shop 1.4 and shop 1.5.
4. `… run --rm cli demo --visitors 600` took 3.7 s. Control: 318 visitors, 25 orders (7.9%). v2: 282 visitors, 36 orders (12.8%). 0 page errors. True rates were 10% / 13%.
   - Flagsmith's counter showed **3775 accepted, 0 rejected**.
   - The proxy's conversion counts (25 / 36) equal the simulator's orders.
5. `… run --rm cli status --refresh`:
   ```
   order_placed (occurrence, up): v2 0.128 (n=282), control 0.079 (n=318)
     v2: lift 62.4%, chance to win 94.0%
   doc_latency_ms (mean, down): v2 66.9 (n=282), control 5.9 (n=318)
     v2: lift 1028.5%, chance to win 0.0%
   sample-ratio check: not computed
   ```
   Flagsmith's identity counts equal the simulator's visitor counts exactly.
6. `… run --rm cli ship --yes`: all 5 steps ✓, snapshot in `.turnout/snapshots/`. The next 200 visitors: **v2 200**.

**Hurdles:**
- `init` inside a container wrote `.env` inside the container. Fixed with a `cli` service (profile `tools`) that mounts `.env` and `.turnout/`.
- Right after `up`, the proxy answered before it was ready (curl exit 52). Retrying a second later worked.

## 11. Preview outranks the experiment and stays out of its data: yes (2026-11-17)
After experiment 1 was shipped (everyone on shop:1.5):
1. `cli preview shop:1.6` created segment `turnout-preview` (trait `preview` EQUAL `"true"`), moved shop:1.5 into control, set v2 to shop:1.6, and added the preview segment override (v2 100%).
   - 8 ordinary visitors: **shop:1.5**.
   - A browser that opened `/__turnout/preview?token=…`: **shop:1.6**, not enrolled.
2. `cli release shop:1.6` started experiment 2 (shop:1.6 vs shop:1.5) on the same flag, with the same metrics.
   - 20 ordinary visitors: 7 on shop:1.5, 11 on shop:1.6, all enrolled. 2 more got shop:1.5 unenrolled, from before the proxy's 5 s refresh.
   - **The preview browser: still shop:1.6, `enrolled: false`.**
3. `cli check` now lists only experiment 2. **Experiment 1's drained override was deleted when experiment 2 started** (Flagsmith #8770, confirmed live).

**Hurdles (Flagsmith 2.291.0):**
- A partial `PATCH /projects/{p}/features/{f}/mv-options/{id}/` answers **500**: `KeyError: 'feature'`, then `KeyError: 'default_percentage_allocation'` (`features/multivariate/serializers.py:85-86`). The validator reads fields a partial update doesn't send. Turnout uses a full PUT instead. **Candidate upstream issue.**
- Segment override priorities must be unique, and a finished experiment's drained override still holds priority 0. So `preview` takes the next free priority.
- `GET …/experiments/` returns `feature` as a nested object. `init`'s idempotency check originally compared it to an id; it's now fixed and typed.


## The whole release cycle on a fresh instance, after the evaluation fixes (2026-11-17)
After `docker compose --profile tools down -v`, following the README's quick start exactly (`compose.yaml`, no `-f` flags):
1. `docker compose up -d --wait flagsmith`, then `docker compose run --rm cli init`: admin, keys, event store, flag tagged `release` (permanent), metrics, experiment 1 (shop:1.5 vs shop:1.4). `init` now waits for Flagsmith, and saves each secret to `.env` the moment it exists.
2. `docker compose up -d --build --wait`: every service healthy. The shop image has **0** files mentioning Flagsmith (`grep -rli flagsmith /app`); the proxy container has no admin key, admin login or GitHub token in its environment.
3. Demo: 2,000 simulated visitors (true rates 10% / 13%).
   - Flagsmith: `order_placed` v2 0.123 (n=1000), control 0.110 (n=1000); v2 chance to win 80.4%. Identity counts equal the simulator's visitor counts.
   - Flagsmith's counter: 8,795 accepted, 0 rejected.
4. Ship winner through the console API: 5 steps done in 13 s; 200 of 200 new visitors on shop:1.5; `.turnout/RELEASES.md` written.
5. Swing-back through the Admin API (environment default, v2 weight 0): visitors get shop:1.4; the console's state shows `serving: shop:1.4` against the ledger's `shop:1.5`. Swung forward again.
6. `preview shop:1.6`: the preview browser gets shop:1.6 (`enrolled: false`), ordinary visitors shop:1.5. `release shop:1.6` started experiment 2 (shop:1.6 vs shop:1.5).
7. Proxy restarted: `/__turnout/health` says `liveRelease: shop:1.5`, read back from the state volume.
8. Demo: 2,000 visitors. Flagsmith: `order_placed` v2 0.131 vs control 0.080, v2 chance to win 99.8%; **`doc_latency_ms` v2 97.6 ms vs control 26.5 ms, v2 chance to win 0.0%** (shop:1.6's seeded 60 ms delay). The preview browser stayed on shop:1.6, not enrolled.
9. `ship --yes` refused: "A guardrail is losing. Add --accept-losing-guardrails to ship anyway, or revert." The console's plan listed the losing guardrail; `POST /api/ship` answered 409 with it.
10. Revert through the console: pause, snapshot, (default already control: skipped), drain, complete. 200 of 200 new visitors on shop:1.5. `check`: "experiment 2's split is drained (0%)", exit 0.
11. Flagsmith's counter after both experiments: 17,910 accepted, 0 rejected.

**Hurdles found on the way:**
- **The simulator washed out the true rates.** One seeded generator shared by 20 concurrent visitors handed out draws in response-time order: with 20 workers, 10% / 13% came out as 11.0% / 11.2% (one worker: 9.7% / 13.8%). Each visitor now has its own stream (`visitorRandom(seed, index)`); 20 workers give 9.1% / 12.4%. Regression test in `test/simulator.test.ts`.
- **Changing a release's seeded delay mid-experiment** mixes two setups into one arm: experiment 2 on the old stack averaged to ~52 ms in both arms. Start a fresh experiment after changing a release.
- **`init` against a just-started Flagsmith** failed with `fetch failed`; it now waits up to 3 minutes, and the docs use `up -d --wait`.
- **On a wiped instance, `init` kept stale keys from `.env`**; it now replaces them when it creates the first admin.
- **The receipt endpoint ignored the preview cookie**, so a preview browser's receipt said shop:1.5 while its pages were shop:1.6. Fixed and tested.
- **Flagsmith's audit-log API** (`/api/v1/projects/<id>/audit/`) returned 0 entries on this open-source instance although the table had 26 rows, and **environment webhooks refuse private addresses** (`core/network.py:8-34`). So the console reads the flag's state instead of listening for changes.
- **Compose found two default files** (`compose.yaml` and Flagsmith's `docker-compose.yml`); the latter is now `compose.flagsmith.yml`.

## 12. Not run yet
- ~~The swing-back made by hand in Flagsmith's own flag editor (spike 9 via the UI).~~ Done 2026-11-18, see below.
- The GitHub Release writer against a real repository (tested against a stub of GitHub's API).
- The CI workflow's smoke job on GitHub's Linux runners.

## Judge mode, live (2026-11-17)
`/judge` drives the real stack through `/api/judge/*`. A full loop from **Start over**: reset → 1,500 visitors → results → Ship → verify → preview → release → 1,500 visitors → results → Revert → verify took about three minutes.
- Experiment 7 (shop:1.5 vs shop:1.4): Flagsmith counted 776 + 724 = 1,500 identities; v2 99.9% chance to win on `order_placed`. Ship; 50 of 50 new visitors on shop:1.5; `check` clean.
- Experiment 8 (shop:1.6 vs shop:1.5, seeded 60 ms delay, input rate 17%): 734 + 766 = 1,500 identities; `order_placed` v2 93.1%; **`doc_latency_ms` 79 ms vs 13 ms, under 0.1% chance to win**. The decision step offered Revert as the primary action; Revert completed; 50 of 50 on shop:1.5; `check` clean.
- Swing-back and swing-forward: the proxy served the new default after 3–4 s.
- Layout checked through Chrome's DevTools device emulation (not just a narrow window, which headless Chrome won't go below ~500 px) at 375, 768 and 1440 px: no horizontal overflow on the judge page, the console or the shop.

**Hurdles found on the way:**
- **Events were being dropped under load.** The Node SDK's event processor defaults (flush every 10 s, a 1,000-event buffer that drops its oldest events while a batch is in flight, a 3 s request timeout) lost 1,000 events in one 1,500-visitor run: Flagsmith counted 1,184 identities, and the proxy's health endpoint showed `undeliveredEvents: 1000` ("This operation was aborted"). Now `flushInterval: 2000, maxBuffer: 6000, requestTimeoutMs: 15000`, within Flagsmith's 2 MB body limit (`experimentation/constants.py:39`); since then counts match exactly. Worth raising with the SDK: the defaults are tight for a server that sees bursts.
- **Visitors sent right after a release land outside the experiment** for up to the proxy's 5 s refresh (912/588 split, 1,211 counted). The visitors step now probes with one uncounted request until the proxy enrols visitors.
- **Re-running `init` after every experiment had finished started a new "1.5 vs 1.4" experiment** while v2 pointed at shop:1.6. `init` now starts the first experiment only when the flag has none.
- **The full console labelled control by the flag's first value** (shop:1.4) instead of the release the rollout serves; fixed (`format.js` `variantList`).
- **The demo rates made shop:1.6's goal inconclusive** (14% vs 13.5%); shop:1.6 now converts at 17%, so it leads on orders while losing the latency guardrail.

## Feature Health and the guard, live (2026-11-17)
- **Feature Health is in the open-source image.** It has a generic Webhook provider (`features/feature_health/providers/webhook/types.py`), created with `POST /api/v1/projects/<id>/feature-health/providers/ {"name":"Webhook"}`, which returns a `webhook_url` with a secret path.
- Posting `{"feature":"shop_release","environment":"Production","status":"unhealthy","reason":{text_blocks,url_blocks}}` to that URL records a `FeatureHealthEvent` and adds Flagsmith's system tag **"Unhealthy"** (`#FFC0CB`) to the flag. A `"healthy"` post removes the tag.
- Webhook URLs *into* Flagsmith are fine; only Flagsmith's outgoing webhooks refuse private addresses.
- **Experiment 10** (shop:1.6 vs shop:1.5, 1,500 visitors): Flagsmith's results showed `doc_latency_ms` at 83 vs 15, with a 0.0% chance to win.
  - The console's watcher posted "unhealthy" within 20 s, and Flagsmith tagged the flag Unhealthy.
  - The event's reason reads "shop:1.6 is losing the doc_latency_ms guardrail: Flagsmith's results as of … 83 on shop:1.6 vs 15 on control; chance to win 0.0%, lift 435.6%", with links to the results page and judge mode.
- **Guard switched on** with `POST /api/guard {"enabled":true}`:
  - It reverted experiment 10 at once: completed, rollout 0%.
  - The ledger entry reads `by: "guard"`, rendered as "Reverted to control (shop:1.5) automatically by Turnout's guard (shop:1.6 losing doc_latency_ms, 0.0% chance to win)".
  - It reported "healthy", so the Unhealthy tag was removed, and 30 of 30 new visitors got shop:1.5.
- **Hurdle:** a guard that refreshes results the moment an experiment starts would use up Flagsmith's one refresh per 5 minutes before any traffic arrives, locking out a person's refresh. It now waits until the experiment has run for 5 minutes.

## First-ever start and reset with the Windows launcher, in a separate Compose project (2026-11-18)
Docker Desktop 29.9.3 (Compose 5.7.0), Windows 11. The demo instance was kept: `.env` and `.turnout/` were copied to a backup and checked file by file (24 files, equal SHA-256), then the main stack was stopped with `docker compose --profile tools stop` (volumes kept). Every command below ran with `COMPOSE_PROJECT_NAME=sytest`, so it got its own containers, networks and volumes.

To look like a fresh clone, `.env` was replaced by `.env.example` and `.turnout/` was removed. The Docker images (Flagsmith, Postgres, `node:24-alpine`) and the build cache were already on this machine, so the times below leave out the image downloads a new user also waits for.

1. **First start:** `cmd /c ".\turnout.bat"` with `TURNOUT_NO_BROWSER=1`. **Exit 0 in 135 s.**
   - `init` created the admin, keys, event store, flag (tagged `release`, permanent), Feature Health provider, metrics and experiment 1 (shop:1.5 vs shop:1.4), and wrote the keys to `.env`.
   - Every service healthy. The launcher's doctor: **29 ok, 0 warnings, 0 failing**.
   - `/judge` answered 200, at Step 1 ("Send simulated visitors").
2. **A short judge flow through `/api/judge/run`:**
   - visitors (1,500): 8.9 s. shop:1.4 743 visitors, 59 orders (7.9%); shop:1.5 757, 93 orders (12.3%).
   - score: 18.4 s. Flagsmith counted 6,415 events, 0 rejected. `order_placed`: v2 98.7% chance to win.
   - ship: refused, because v2 was losing `doc_latency_ms` (see below). Shipped with `acceptLosingGuardrails: true`: 5 steps in 7.2 s.
   - verify: 50 of 50 new visitors on shop:1.5; experiment 1's split drained (0%).
3. **Reset:** `cmd /c ".\turnout.bat reset /yes"`. **Exit 0 in 142 s**, without a prompt.
   - It ran `docker compose --profile tools down -v`, removed `.turnout/`, then the whole start again.
   - Afterwards: experiment 1 running again, the ledger empty, judge mode at Step 1, doctor **29 ok, 0 warnings, 0 failing**. `.env` kept its judge token and got new Flagsmith keys.
4. **Teardown and restore:** `docker compose -p sytest --profile tools down -v` removed every `sytest` container, network and volume. `.env` and `.turnout/` were copied back from the backup and compared: 24 of 24 files equal. `docker compose up -d --wait` brought the demo back in 32 s.
   - The first doctor run warned on the proxy: its last flag refresh had timed out while Flagsmith was starting. The run after it: **29 ok, 0 warnings, 0 failing**.
   - Judge state as before: experiment 21 completed, 21 decisions in the release history, live release shop:1.5.

**Found on the way:**
- **Two copies of the stack can't run side by side on one Docker engine.** Flagsmith's official compose file names the database container `flagsmith_postgres` (`compose.flagsmith.yml:61`), and container names are global. The stopped demo container was renamed for the test and renamed back before the restore.
- **On a fresh stack, the first experiment's latency guardrail read as losing.** `doc_latency_ms`: shop:1.5 11.9 ms against shop:1.4 11.2 ms, a 3.0% chance to win. Turnout treats a guardrail under 5% as losing (`src/flagsmith/experiments.ts:88`), so judge mode's Ship was refused until the loss was accepted. Flagsmith's statistic is fine. A 0.7 ms difference across 1,500 visitors was enough to be detectable. The judge story expects the first experiment to ship cleanly.
- **The console container doesn't stop on SIGTERM.** `docker compose stop` ended it with exit 137 after Docker's 10 s timeout. The proxy has a SIGTERM handler (`src/cli.ts:227`), and the console has none.

## setup.sh and turnout.sh in a Linux userland (2026-11-18)
Both scripts ran in `docker:29-cli` (Alpine Linux, BusyBox, Docker CLI 29.10.0, Compose 5.7.1) with the host's Docker socket. This is a real Linux shell and toolset, not macOS. Homebrew, apt/dnf with sudo, `open -a Docker` and xdg-open still haven't run.

**Against the running demo (read-only):** the project folder was mounted at the path Docker Desktop's engine uses for it (`/run/desktop/mnt/host/c/...`), so Compose's relative bind mounts resolve to the real files.
- `sh setup.sh --check`: exit 0. Docker, engine, Compose 5.7.1, 7 GB for Docker, all three ports "used by Docker", `.env` exists. One warning: no Node.js in the image.
- `sh turnout.sh status`: exit 0. Compose's service table, then doctor: **29 ok, 0 warnings, 0 failing**.

**A whole lifecycle as uid 1234, on a Linux filesystem:** the demo was stopped again, as in the section above. The project (no `.env`, `.turnout/`, `.git` or `node_modules`) was copied into a Docker volume, owned by 1234:1234 with modes 755/644. The volume was mounted at its engine path (`/var/lib/docker/volumes/<name>/_data`), and the scripts ran as `--user 1234:1234` with `COMPOSE_PROJECT_NAME=sytest`.
- `sh setup.sh --check`: exit 0, ".env is missing; turnout.sh creates it". It suggested TURNOUT_UID=1234 / TURNOUT_GID=1234.
- `sh setup.sh --yes`: created `.env` and wrote `TURNOUT_UID=1234` and `TURNOUT_GID=1234` to it. There is no apt or dnf on Alpine, so it printed "Install Node.js with your distribution's package manager".
- `sh turnout.sh` (first start): **exit 0 in 128 s**, doctor 29 ok. The console container ran as `1234:1234`.
- A judge flow through the API: 1,500 visitors; `order_placed` v2 99.9%; this time `doc_latency_ms` was inconclusive (21.5%). Ship: 5 steps in 7.2 s. Verify: 50 of 50 on shop:1.5.
  - **`.turnout/ledger.jsonl`, `RELEASES.md` and the decision snapshot were written as 1234:1234** in a 755 folder.
  - The ledger entry names the snapshot file.
  - This is the uid != 1000 case that used to stop a Ship with the experiment paused.
- `sh turnout.sh status`: exit 0, doctor 29 ok.
- `sh turnout.sh reset --yes`: **exit 0 in 135 s**. It removed the container-written `.turnout/` as the same user, started again, and doctor gave 29 ok.
- `sh turnout.sh stop`: exit 0, no containers left. Then `docker compose --profile tools down -v` removed the test volumes, and the copy was deleted. The demo was renamed back and started. Doctor: 29 ok, 0 warnings, 0 failing, and the judge state was unchanged.

**Bug found and fixed: `setup.sh` reported free ports as used on Alpine.**
- BusyBox's `lsof` ignores `-iTCP:<port> -sTCP:LISTEN` and lists every open file. `setup.sh` took its second row as the port's owner, so it printed "port 8000 is used by 1 (PID /bin/busybox)" for all three ports, with nothing listening. These were warnings, not failures, so `turnout.sh` still started.
- Now only a `(LISTEN)` row with a numeric PID counts, and `ss` is tried when `lsof` finds nothing.
- Checked in Alpine with a BusyBox `nc -l -p 8080` listener:
  - BusyBox `lsof`: 8000 free, 8080 "used by another program" (`nc -z`), 8090 free.
  - The real `lsof` (`apk add lsof`): 8080 "used by nc (PID 23)".
- Regression test: `test/ops.test.ts`, "sh setup.sh: a BusyBox lsof…".

## Seconds from a flag change to new routing (2026-11-18)
Measured on the demo stack after a judge Reset (experiment 22, shop:1.5 vs shop:1.4). Script: `latency.mjs` in the session scratchpad.
- **Probe:** while a judge action ran, a fresh visitor (no cookies, two page loads, like judge mode's verify) went through the proxy at `127.0.0.1:8080` every ~150 ms. It read the `x-turnout-release` debug header.
- **Timing:** each job log line was timed when it first appeared to a 100 ms poll of `/api/judge/job`. All times are on this machine's clock.
- **"Every fresh visitor":** the first visitor after the last one that still got the old release, followed by at least 20 in a row on the new one.

**Swing back / swing forward** (judge API; one PATCH of the environment default, the same edit as the flag editor). There were 14 valid runs:

| | min | median | max |
|---|---|---|---|
| Click → Flagsmith saved the flag | 0.89 s | 0.93 s | 1.58 s |
| Flag saved → every fresh visitor on the new release | 0.09 s | 0.65 s | 4.49 s |
| Click → every fresh visitor on the new release | 1.08 s | 1.58 s | 6.07 s |

- **The first 8 runs were evenly spaced** (about 10 s apart), so they kept nearly the same phase against the proxy's 5 s refresh: 7 of 8 followed within 0.6 s.
- **The last 6 had a random 0–5 s wait first.** Flag saved → every fresh visitor: 0.78, 1.83, 2.21, 2.75, 3.17 and 4.17 s, median 2.48 s. This spread is what the SDK's 5 s environment refresh predicts (`src/flagsmith/flag-source.ts:28`).
- Judge mode's own check reported "after 2 s" to "after 6 s", in whole seconds.
- **Two more swing-backs failed before they started:** HTTP 502 "fetch failed", from the console's request to Flagsmith (see below). The swing-forward after each was then a no-op, so all four are left out.

**A full Ship** through judge mode (n = 1, experiment 22, v2 at 94.5%):
- Click → step 3, "Set the flag's environment default to v2", logged: 4.33 s. Pause and the decision snapshot come first.
- Click → job done: 7.10 s.
- Click → every fresh visitor on shop:1.5: **7.05 s**. Before that, 50/50 between shop:1.4 and shop:1.5.
- The split ends at the drain step (rollout to 0%), so new routing arrived as the job finished.

**Found on the way: the console's requests to Flagsmith sometimes fail with "fetch failed" after 2 to 3 s idle.**
- **Where it shows:** 1 of 30 `GET /api/judge/state` calls made after 2.0–3.8 s idle answered 500 `{"error":"fetch failed"}`. 2 of 10 judge actions started after a random 0–5 s wait answered 502 "fetch failed". This is probably the HTTP 500 the integrator saw once and couldn't explain.
- **Reproduced from inside the console container:** 6 parallel `fetch('http://flagsmith:8000/api/v1/')` calls after a 2.0–3.8 s idle gap, 70 rounds. **49 of 420 failed** (38 `ECONNRESET`, 11 `UND_ERR_SOCKET`). Every failure followed a gap of 2.0–2.9 s. With gaps of about 2 s from a single connection, 80 of 80 succeeded.
- **Likely cause:** Flagsmith's gunicorn closes an idle keep-alive connection after `GUNICORN_KEEP_ALIVE`, 2 s by default (`/usr/local/lib/python3.13/site-packages/common/gunicorn/utils.py:26` in the `flagsmith` container). Node's `fetch` keeps idle connections for 4 s and may reuse one just as the server closes it. The image runs 3 workers × 2 threads (`GUNICORN_WORKERS=3`, `GUNICORN_THREADS=2` in the container's environment).
- **Possible fixes on Turnout's side:** retry a request once when it fails with `ECONNRESET` or `UND_ERR_SOCKET` before any response, at least for GETs. Or set `GUNICORN_KEEP_ALIVE` above 4 in compose.
- **Fixed (2026-11-18), both ways:** `compose.flagsmith.yml` sets `GUNICORN_KEEP_ALIVE: 5` on the API (a marked edit), so the server no longer closes an idle connection before Node does; and `AdminClient` sends a GET once more when it fails with `ECONNRESET`, `UND_ERR_SOCKET` or `EPIPE` (`src/flagsmith/admin.ts`, tested in `test/admin.test.ts`). Writes are never sent twice.

**Also seen: the proxy's environment refreshes time out under load.**
- The proxy asks for the environment document with a 2 s timeout and no retries (`src/flagsmith/flag-source.ts:31-32`).
- Its log has 23 "updateEnvironment failed … aborted due to timeout" lines between 01:16 and 01:36 UTC, while judge jobs, the latency runs and the keep-alive probe were all hitting Flagsmith. The keep-alive probe was the heaviest.
- Each failure delays a flag change by one more 5 s refresh. It also accounts for the 6–10 s outliers here and in the next section.
- **It also happens with light load.** In the 75 s after the final reset, with only the console's own polling and one doctor run, the proxy logged 3 refresh timeouts.
- **Timing the endpoint directly:** `GET /api/v1/environment-document/` (7.2 KB) from this machine, 20 times at 1 s intervals, took a median of 108 ms. One request took 3.6 s, past the proxy's 2 s limit.
- **A possible fix:** with local evaluation, no visitor request waits on this fetch, so a longer timeout just for the environment refresh wouldn't slow visitors. The 2 s limit is the SDK's `requestTimeoutSeconds` (`src/flagsmith/flag-source.ts:31`). The event processor has its own 15 s limit (`:39`).

## Spike 9 through Flagsmith's own flag editor: yes (2026-11-18)
Headless Chrome was driven through the DevTools protocol (`cdo.mjs` and `netsave.mjs` in the session scratchpad). The admin login was read from `.env` and typed into the form, never printed. The demo had shipped experiment 22, so v2 (shop:1.5) was at 100% in Production.
1. **Opened the flag:** logged in at `http://127.0.0.1:8000`, then went to Features → `shop_release`. The **Edit Feature** panel opened on its Value tab: Control Value `shop:1.4` (0%), variant `v2` = `shop:1.5`, Environment Weight 100%.
2. **Swung back from the dashboard:** set v2's Environment Weight to 0 and clicked **Update Feature Value**. The toast said "Success / Updated Feature".
   - The dashboard sent `PUT /api/v1/projects/1/features/1/mv-options/1/` → 200, then `PUT /api/v1/environments/<key>/featurestates/1/` → 200. That is the v1 feature-state endpoint, where Turnout's swing uses `PATCH /api/__future__/environments/<key>/features/<id>/`. Both edit the same environment default.
   - There was no 409 and no change request (none are required in this environment).
   - Fresh visitors through the proxy got **shop:1.4**. Judge mode's state then showed `live: shop:1.4` against the ledger's shop:1.5, the swing-back it detects from the flag.
3. **Timed:** 3 more swing-backs and 4 swing-forwards in the editor, with a 0–5 s random wait before each. From the click to every fresh visitor on the new release: **1.50, 2.03, 2.44, 3.25, 3.62, 5.22, 9.68 s** (n = 7, median 3.25 s). This includes the dashboard's two PUTs.
   - The 9.68 s run fell in a stretch of proxy refresh timeouts (see the section above).
4. **Put back:** v2 at 100% from the editor. Fresh visitors on shop:1.5, and judge state `live: shop:1.5` again.

The dashboard didn't block automation. Its inputs carry `data-test` attributes (for example `featureVariationWeightshop:1.5`), and the save button has the id `update-feature-btn`. The screenshot, `spikes/spike9-flag-editor.png`, shows the editor after the swing-back: weight 0 and the success toast.

## README media, captured from the live stack (2026-11-18)
- **How they were taken:** headless Chrome through the DevTools protocol, at a 1440×900 viewport, after a judge Reset.
  - **The CDP client stays attached for the whole capture.** With no client attached, the page's animation frames stopped. The track's dots then piled up at their start, and a new connection redrew the track.
  - **Judge mode's own API sends the visitors**, because the proxy treats headless Chrome as a bot.
- **Files in `docs/images/`:**

| File | Size | What it shows |
|---|---|---|
| `judge-dashboard.png` | 1440×900, 200 KB | Experiment 25 mid-run: Step 2 of 7, 3,000 visitors counted, a second batch flowing at 391 req/s, dots riding to shop:1.4 |
| `judge-tour.png` | 1440×900, 193 KB | The tour's first beat in its EXPLAIN state ("Every deploy becomes a Flagsmith experiment"), beside the spotlit flow line |
| `judge-results.png` | 1108×828, 203 KB | Experiment 24 (shop:1.6 vs shop:1.5) at Decide: Revert recommended; `order_placed` >99.9%, `doc_latency_ms` 68 ms vs 6.0 ms and losing; Flagsmith's Feature Health showing the flag as Unhealthy |
| `flagsmith-map.png` | 1264×900, 143 KB | The feature map's top: 10 used live, 3 read only, 19 need a public endpoint or account, 2 not used |
| `setup-check.png` | 952×900, 70 KB | /setup: "Everything is in place", 28 OK, 0 warnings, 0 failing |
| `judge-ship.gif` | 960×680, 12.1 s, 369 KB | The track card while Ship runs on experiment 23, with fresh visitors flowing (12 a second). It plays at the capture speed: 95 frames 110 ms apart, the last one held 1.8 s. The 50/50 experiment track drains into one track to shop:1.5 |

- **The GIF encoder:** `gifenc` 1.0.3 for LZW, with `pngjs` 7.0.0 to read the frames. Both were installed in a scratch folder only, not in the project.
  - One global palette: the 64 most common exact colours, plus 191 quantized ones.
  - Colours are matched at full precision. gifenc's `applyPalette` looks colours up by their rgb565 rounding, which turned white into #F8F9FB.
  - Each frame keeps only its changed pixels and makes the rest transparent.
  - The GIF's last frame differs from the captured PNG by 0.16 per channel on average.
- **The GIF shows a real gap.** The ship job ended about 7 s after the click, but the track showed the drained split about 5 s later, on the page's next state poll. A judge watching sees "Experiment 23 · paused" at 50/50 for those seconds.

**Observed while capturing:** with 18,000 visitors in experiment 23, `doc_latency_ms` read as losing for shop:1.5 (lift 1.4%, 2.6% chance to win). With more visitors, the small real difference between shop:1.4 and shop:1.5 becomes detectable. At this point the first experiment's latency guardrail had read as losing in 2 of 4 runs: 1,500 visitors on a fresh stack, and 18,000 here. Recount after the timed tour below: 2 of 5 (losing: the fresh Windows stack, 3.0%, and experiment 23, 2.6%; inconclusive: the Linux run, 21.5%; not losing: the tour; not recorded: the experiment 22 timing runs).

## Judge tour, played for you, timed (2026-11-18)
Headless Chrome at 1440×900 through the DevTools protocol (`autoplay-time.mjs` in the session scratchpad). It chose **Play it for me** on the welcome screen, clicked **Start the judge tour**, and logged the time at each new bubble title. No screenshots and no bubble text were kept, because the sign-in beat can show the admin password. The demo was reset to Step 1 first (experiment 28) and again afterwards.
- **From the click to the last beat ("That's the whole loop"): 531 s (8 min 51 s)**, 42 beats, n = 1.
- The longest waits were the jobs: 3,000 visitors took about 35 s and 41 s, each "Ask Flagsmith who won" about 28 s, Ship about 34 s and Revert about 21 s, each until the next beat.
- The first experiment shipped (no losing guardrail this time); the second was reverted with Flagsmith's Feature Health showing the flag Unhealthy, as the story expects.
- One `GET /api/judge/state` answered 500 during the run (the "fetch failed" issue in the section on routing latency); the page's next poll succeeded and the tour carried on.
- An earlier attempt was discarded: the machine slept part-way through, so its times weren't valid.

## Demo left at Step 1 (2026-11-18)
- Judge Reset after the media capture: experiment 25 was reverted, and experiment 26 (shop:1.5 vs shop:1.4) is running.
- `/judge` shows "Step 1 of 7 · Split, Send simulated visitors".
- Doctor: 29 ok, 0 warnings, 0 failing. The release history has 25 decisions.
- The `turnout-preview` segment override still serves shop:1.5 to preview browsers. Reset doesn't clear it, and Preview at step 6 sets it again.
- After the timed tour above, Judge Reset again: experiment 30 (shop:1.5 vs shop:1.4) is running, at Step 1.

## Review fixes, checked on the live stack (2026-11-18)
After `docker compose up -d --build --wait`, which recreated Flagsmith's API with `GUNICORN_KEEP_ALIVE=5` and the proxy and console from the current `turnout:local` image.
- **Idle keep-alive probe, repeated:** from inside the console container, 6 parallel `fetch('http://flagsmith:8000/api/v1/')` calls after a 2.0–3.8 s idle gap, 20 rounds, with no retry: **0 of 120 failed**. Before the change: 49 of 420.
- **Host header on the other-devices port:** from inside the proxy container, `GET http://console:8091/judge` with `Host: 127.0.0.1:8090` answered **403** with no page token. From this machine, `127.0.0.1:8090/judge` answered 200 and `127.0.0.1:8091/judge` 403 (no judge cookie).
- **Published ports:** Flagsmith `127.0.0.1:8000`, proxy `127.0.0.1:8080`, console `127.0.0.1:8090-8091`.
- **Console log:** no `key=` line with `TURNOUT_CONSOLE_HOSTS` empty.
- Doctor: 29 ok, 0 warnings, 0 failing (the first run right after the restart warned once, as noted in docs/SETUP.md). Judge mode still at Step 1 (experiment 30 running).

## A second app: the landing page, live end to end (2026-11-23)
The landing example ([examples/landing](../examples/landing/README.md)): a static page with a Sign up button, `landing:1` and `landing:2` as two containers, success = `POST /signup` 2xx. Its config was written by `turnout new`. It ran on the same Flagsmith as the shop demo, in its own organisation, project and environment, with `.env` and `.turnout/` backed up first and restored afterwards.
- **Your own project, not ours.** The demo's organisation couldn't take a second project: a free-plan organisation holds one (`MAX_PROJECTS_IN_FREE_PLAN = 1`, `app/settings/common.py:69`; `projects/permissions.py:31-38` of the pinned 2.291.0 image; the Organisation API key got 403). So, as a user would in the dashboard, the admin user created organisation "Landing Co", project "Landing" (id 2), environment "Production", and an Organisation API key for it.
- **`init --project Landing --environment Production`:** "nothing created at that level"; it created a server-side key, connected the event store, created `landing_release` (tagged `release`) with v2 → `landing:2`, the metrics `signup`, `doc_latency_ms`, `server_error`, and started experiment 33 on 100% of identities, v2 50%. No Feature Health provider was added (the project has none, and init says so).
- **First 3,000 visitors: 0 exposures.** The first version of the simulator's `goal` flow viewed the page once and then signed up. The proxy records an exposure only for a returning visitor's page load (`src/proxy/server.ts:130-142`), so none of them counted: Flagsmith had no result and the Experiment Doctor reported "no exposures recorded yet". The flow now views the page twice before signing up, and the landing README says who counts.
- **Second 3,000 visitors** (labelled simulation; inputs control 10%, v2 14%, seed 42), 10.0 s: control 1,515 visitors, 141 sign-ups (9.3%); v2 1,485, 189 (12.7%); 0 page errors.
- **Flagsmith's results** (as of 13:32:04Z): `signup` v2 0.127 (n = 1,485) vs control 0.093 (n = 1,515), lift +36.8%, interval +9% to +65%, **99.5% chance to win**. `doc_latency_ms` 10.7 vs 10.7 (39.2%), `server_error` no events in either release. Experiment Doctor: exposures, tracking and sample ratio (p = 0.5839) pass.
- **Decision:** Turnout recommended ship (interval clears zero). `ship --yes` paused, snapshotted, set the default to `landing:2`, drained the rollout to 0% and completed experiment 33. Browser-like visitors, new and returning, all got `landing:2` afterwards (10 of 10).
- **Seen along the way:** the proxy's Flagsmith SDK logged a few `updateEnvironment failed` timeouts (6 in the first minutes, 3 in two minutes after the ship) while a direct fetch of the environment document took 242 ms; routing and event delivery weren't affected (no undelivered events logged). Not investigated further.
- Afterwards: `.env` and `.turnout/` restored from the backup, the landing containers removed, the shop stack rebuilt and restarted with the default config.
- The shop's own judge story was at step 4 (experiment "shop:1.6 vs shop:1.5" completed) before and after; judge mode's Reset started "shop:1.5 vs shop:1.4" (running), so `/judge` is at **Step 1 of 7**. Doctor: 29 ok, 0 warnings, 0 failing (one warning on the run straight after the restart, gone on the next).

## Server-mode stress tests on the VM (2026-11-24)

Azure VM, 2 vCPU, 7.7 GiB RAM, Ubuntu, Docker 29.10.0, Compose v5.8.0; Flagsmith 2.291.0; public at https://172-198-62-67.sslip.io with the autopilot on. All times UTC.

**Found first: after ~10 hours of autopilot, Flagsmith was "unhealthy".** Three causes, each measured and fixed:

| Cause | Measured | Fix |
|---|---|---|
| Flagsmith image's health check, `flagsmith healthcheck tcp`, starts a Python/Django process every 2 s with a 2 s timeout | That process alone took ~35% CPU per run; under any load it timed out, so the container flapped to unhealthy | Server overlay runs the same check every 30 s (15 s timeout, every 3 s while starting). After: Flagsmith ~0% CPU idle, healthy throughout |
| The autopilot read the judge state (several admin API calls) every 1 s while waiting | Kept Flagsmith's web process busy around the clock | Reads at most every 30 s while waiting (test: autopilot.test.ts) |
| Flagsmith's SDK event table only grows ("Flagsmith never deletes events") | 530,572 events, 228 MB after 10 h; results queries ran up to 37 s, 7 at once | `event-pruner` service deletes events older than 6 h hourly (`TURNOUT_EVENT_RETENTION_HOURS`); first run deleted 210,711 |
| 20 simulated visitors in flight at once | 1,130+ events lost in 3 min (`not_delivered`, events POST aborted after 15 s) | Server mode sends 5 at once (`TURNOUT_DEMO_CONCURRENCY`); then 0 lost |

**Then the tests:**

| Test | Result |
|---|---|
| `sudo systemctl reboot` | SSH back after 27 s; public `/judge` 200 after 50 s; shop 200 after 51 s; `turnout.sh status`: **35 ok, 0 warnings, 0 failing**, no manual step; all 10 containers healthy, restart count 0; autopilot resumed |
| Flagsmith (web + task processor) stopped, 150 page loads through the public HTTPS URL | Before fix: 150/150 served, but mean 4.4 s, max 10.0 s. Cause: the SDK's lookups of the stopped host hang ~5 s and fill Node's 4-thread DNS pool, so resolving `shop-1-4` waited behind them. Fix: the proxy caches release hostname lookups. After: **100/100 served, mean 86 ms**, max 5.2 s (the first request after a proxy restart, before the cache had an entry) |
| 5,000 simulated visitors in one job, `docker stats` every 3 s | 37 s; **0 events lost**; Flagsmith stayed healthy. Peak memory: flagsmith 582 MiB, postgres 302 MiB, task processor 256 MiB, proxy 118 MiB, console 90 MiB, each shop ~31 MiB, caddy 16 MiB (stack ≈ 1.45 GiB; host 2.2 GiB used of 7.7) |
| Ship during traffic: a new browser visitor every ~0.1 s (debug header names the release) through release → 1,000 visitors → score → ship | Ship took 11 s. Before: 57 shop:1.5 / 63 shop:1.6. During: 54 / 22. **From the moment Ship finished: 263 of 263 new visitors on the winner (shop:1.5), 0 left behind.** Flagsmith's pick was control: shop:1.6 lost the latency guardrail (its 60 ms test fault) |
| Autopilot reset | Deletes nothing: it reverts a running experiment (decision snapshot + ledger entry), sets the default back to shop:1.4 and starts a new experiment. Past experiments stay in Flagsmith; the ledger and snapshots stay on disk. Raw events older than 6 h are pruned; Flagsmith's stored results for old experiments are kept until someone refreshes them |
| Is every public number labelled simulated? | Yes: a fixed "Simulated visitors" badge in the header, "Every visitor here is simulated" in the footer, and "simulated visitors sent" on the counter |

Not done here (needs people): the 10-developer cold-start test against docs/PLUG_AND_PLAY.md.

## Event loss under load: the cause, the fix, and the measured result (2026-11-24)

Same VM (2 vCPU). Each run: 3,000 simulated visitors via `turnout demo --concurrency N`, autopilot off. Ground truth, not log lines: the proxy counts every event it hands to the SDK, by name (`/__turnout/health` with the debug token), and the run's rows in Flagsmith's `experimentation_sdkexperimentationevent` are counted per event, with duplicates (same identifier, event, timestamp and value).

**What the earlier "1,130 lost at 20 concurrent" was.** Flagsmith was saturated (the 2 s Django health check, the autopilot's once-a-second state reads, 37 s results queries over an unpruned table), events POSTs timed out after 15 s, and Turnout's undelivered counter counted every failed *attempt*, including ones the SDK's retry later delivered. With those three fixed (above), 20 concurrent lost nothing, so the simulator limit of 5 was reverted to the default 20.

**The real remaining cause: the SDK's buffer.** `@flagsmith/nodejs` 9.4.0 posts its whole buffer as one batch, one batch at a time, and while a batch is in flight a full buffer drops its oldest events, reported only as a log warning. Turnout's buffer can't grow much: the SDK never splits a batch, and Flagsmith rejects a body over 2 MiB (`experimentation/constants.py:39`); the largest event Turnout can send is 281 bytes, so 7,000 is the ceiling. Neither Flagsmith's events endpoint (validates each event, then one `bulk_create`) nor gunicorn (3 workers × 2 threads) was the bottleneck: the drops happened when one batch was slow (4–10 s) while the proxy produced ~700 events/s.

| Configuration | Runs (concurrency) | Result |
|---|---|---|
| SDK flush 2 s, buffer 6,000, drops invisible | 20, 50, 100, 200 | 100: 119 of 5,407 page-speed events missing (2.2%), `undelivered` 0, so nobody would have known |
| Flush 1 s, buffer 7,000, drops counted | 20, 50, 100, 100, 200, then 50 ×6 | 1 of 11 runs lost events: 50 concurrent, 2,689 dropped, now reported by `/__turnout/health` and doctor |
| **Plus Turnout's hold-back queue** (its own events wait while the SDK buffer is over 6,500, fed in as it empties; cap 100,000, then counted) | 20, 50, 50, 50, 100, 100, 200, 200 | **0 lost, 0 dropped in every run; stored rows equal the proxy's counts exactly** (121,678 events in 72 batches). These runs did have slow batches (9 over 5 s, slowest 10.7 s), the condition that dropped events before. One identical row pair in the last run is two real page loads (counts still match; no batch failed, so nothing was retried) |

Unit test: a real SDK against an events endpoint that holds a batch for 1.5 s while 25,000 events are tracked: all 25,000 arrive; with the hold-back disabled the same test fails.

## `turnout compare` end to end (2026-11-24)

Windows 11, Docker Desktop 29.9.3, the demo stack already running (ports 8000, 8080, 8090, 8091 taken). Two nginx sites ("Version ONE" on :3001, "Version TWO" on :3002). From an empty folder: `turnout compare localhost:3001 localhost:3002`, no questions.

| Check | Result |
|---|---|
| Nothing to running, image built from the checkout (it can't be pulled: private) | 152 s; doctor 27 ok, 0 failing; app on 8081, console on 8092, Flagsmith on 8001 (each the next free port) |
| Split over 200 new visitors | 86 / 114 (`--split 50`: half get the new version) |
| One visitor, 20 more page loads | 20 / 20 on the same version |
| Experiment with no goal | metrics `doc_latency_ms` (decrease, primary) and `server_error` (not_increase); hypothesis "v2 loads pages faster without more errors" |
| Console first card | Open your site → 127.0.0.1:8081, Flagsmith dashboard → :8001, "No goal yet: judged on page speed" |
| Run again, same arguments | resumed in 55 s, 27 ok |
| `turnout down`, `turnout reset --yes` | stopped; wiped |

Bugs the end-to-end run found and fixed: PowerShell 5.1 made git's stderr fatal; `$A` overwrote the argument list `$a` (PowerShell names ignore case); `-w /work` broke the image's start (also in README and SETUP); a stale `turnout:local` was reused (now always rebuilt, cached); `--split 50` put only 25% on the new version; doctor expected a count-up goal for a speed-only experiment; the "Check:" line was blank.
