# Development

## Layout

```
README.md                  what Turnout is, the quick start, the evidence
compose.yaml               includes the two files below, so plain `docker compose` works in any shell
compose.flagsmith.yml      Flagsmith's official docker-compose.yml with five edits, listed in its header (pinned 2.291.0)
compose.turnout.yml     overlay: proxy, console, three shop releases, a `cli` service (profile tools); networks
turnout.config.yml      routing config for the demo
Dockerfile                 Turnout image: proxy, console, CLI
.env.example               every setting, in sections; ops.test.ts fails if code reads one that isn't listed
setup.bat, setup.sh        check and install what the demo needs (Windows; macOS and Linux)
turnout.bat, .sh        start, demo, status, stop, reset [--yes]; .bat files keep CRLF line endings
action.yml                 reusable GitHub Action: check, and Code References with an admin key
.github/workflows/ci.yml   typecheck and tests; a compose smoke job (init → demo → check)
src/
  cli.ts                   entry point: turnout <command> [--api-url --server-key --admin-key]
  config.ts                config loading, validation, HTTP rule matching
  decide.ts                Ship winner / Revert: guardrail check, steps, ledger entry (shared by CLI and console)
  ledger.ts                .turnout/ledger.jsonl, RELEASES.md and the GitHub Release section
  health.ts                Feature Health reports and the guard (the console's watcher)
  proxy/server.ts          reverse proxy: origin-form targets only, identity cookie, routing with a 150 ms deadline,
                           live-release fallback, exposures, events, /__turnout/{receipt,preview,health}
  proxy/feed.ts            live traffic feed (internal port 8081) for the console, bounded
  flagsmith/admin.ts       Admin API client
  flagsmith/experiments.ts results, Flagsmith's winner rule, guardrails, Ship/Revert plans with read-back
  flagsmith/flag-source.ts Node SDK adapter (local evaluation, events, readiness)
  flagsmith/receipts.ts    per-visitor receipts from the events endpoint's answers
  flagsmith/feature-map.ts the /flagsmith page's data: every Flagsmith menu and integration, with live values
  flagsmith/code-refs.ts   scan the checkout for the flag's name; submit Code References
  commands/                init, doctor, check, preview, release, and status/ship/revert (ship.ts)
  console/server.ts        console API (per-boot token; holds the admin key); :8090 for this machine, :8091 for
                           other devices (judge cookie always required there)
  console/judge.ts         judge mode's API: /api/judge/state and the jobs behind each step
  console/ui/              front end, no build step:
                             index.html, app.js, map.js, guard.js                    the full console (/)
                             judge.html, judge.js, judge-format.js, judge.css,       judge mode (/judge)
                               track.js, track.css, fx.js
                             tour.js, tour-plan.js, tour.css                         the judge tour
                             setup.html, setup.js, setup.css                         /setup (doctor)
                             flagsmith.html, flagsmith.js, flagsmith.css             /flagsmith (feature map)
                             style.css                                               shared by every page
                           format.js                                               shared by / and /judge
demo/shop/                 Ridgeline Supply Co., run as shop:1.4, 1.5 and 1.6 (no Flagsmith code; own Dockerfile)
demo/simulator/            labelled simulated visitors with known true conversion rates
spikes/                    checks against a real Flagsmith; answers and live measurements in spikes/RESULTS.md
test/                      node:test suites (below)
docs/
  SETUP.md                 the scripts, by-hand commands, doctor, other devices, Linux, ports and networks
  JUDGE_MODE.md            judge mode, the tour and the full console
  CLI.md                   every command and option
  FLAGSMITH.md             every Flagsmith feature used, with file:line, and what we found on the pinned image
  images/                  README screenshots and the Ship GIF, captured from the live stack
```

`docs/planning/` (idea history, judge panels, evaluations) and `docs/flagsmith-kb/` (notes on Flagsmith's docs) are kept locally and ignored by git.

## Running the demo from scratch

Needs Docker (Compose 2.20+, about 8 GB of memory for containers) and, for development, Node 24+. TypeScript runs directly through Node's type stripping, so there is no build step. The start scripts do all of this; [SETUP.md](SETUP.md) explains each part.

```bash
cp .env.example .env
docker compose up -d --wait flagsmith          # Flagsmith on 127.0.0.1:8000, once healthy
docker compose run --rm cli init               # admin, keys, tagged flag, metrics, experiment → .env
docker compose up -d --build                   # proxy :8080, console :8090, shop 1.4, 1.5 and 1.6
docker compose run --rm cli doctor             # everything in place? (also http://127.0.0.1:8090/setup)
docker compose run --rm cli demo               # 2,000 labelled simulated visitors
docker compose run --rm cli status --refresh   # Flagsmith's results (one refresh per 5 min)
docker compose run --rm cli ship               # Ship winner, after showing the plan
docker compose run --rm cli preview shop:1.6   # then open /__turnout/preview?token=<TURNOUT_PREVIEW_TOKEN>
docker compose run --rm cli release shop:1.6   # the next experiment; shop:1.6 has a seeded delay
docker compose run --rm cli revert             # after the guardrail shows it losing
docker compose run --rm cli check              # splits left behind on any flag
docker compose run --rm cli code-refs          # needs a repository URL; see docs/CLI.md
```

Or open <http://127.0.0.1:8090/judge> and run the same story from the browser.

To reset everything: `sh turnout.sh reset --yes` (`turnout.bat reset /yes`), or `docker compose --profile tools down -v` and then delete `.turnout/`.

After changing code, rebuild the images: `docker compose --profile tools build cli`, then `docker compose up -d --build --wait`.

## Testing

```bash
npm install
npm test             # all suites; no Flagsmith or Docker needed
npm run typecheck    # npx tsc --noEmit
node --check src/console/ui/judge.js   # the UI files are plain JavaScript; check each one you change
node spikes/04-local-eval.ts   # against a running Flagsmith after init (the spikes use localhost:8000)
node spikes/07-round04.ts
```

- `test/fake-flagsmith.ts` is an in-memory Flagsmith for Ship and Revert. It also answers `POST …/results/refresh/`; set `state.refreshAnswer` to inject a 429 or 400. `test/fake-admin.ts` and `test/judge-fixtures.ts` serve the other suites.
- `test/decide.test.ts` and `test/ship-command.test.ts` cover `decide()` and the `status`, `ship` and `revert` commands, including the guardrail prompts.
- `test/ops.test.ts` checks the compose files (published ports, networks, users, the variables passed to each service), the CI workflow, the scripts' line endings and argument handling, and that `.env.example` lists every variable `src/` and `demo/` read. Its `.bat` test runs on Windows only and its `sh` tests need `sh`.
- `test/admin.test.ts` drops sockets without an answer, the way Flagsmith's gunicorn closes an idle keep-alive connection: a read is sent once more, a write never is.
- `test/*-ui.test.ts` test the front end's pure helpers (`format.js`, `judge-format.js`, `tour-plan.js`) and its markup.

## How fresh the console's numbers are

The console keeps some Flagsmith reads briefly and shares a read already in flight, so many open pages don't multiply the calls to Flagsmith:

| What | Kept for |
|---|---|
| `/api/state` and judge mode's `/api/judge/state` | 1.5 s |
| Which experiment is the latest | 10 s, so a `turnout release` run in a terminal shows up within about 10 s |
| Flagsmith's event counter | 1 s |
| `/api/doctor` | 15 s; `?fresh=1` skips it (the setup page's **Check again** uses it) |
| The `/flagsmith` feature map | 30 s |

Ship, Revert, a results refresh and every judge-mode job drop everything kept. In tests, `ConsoleOptions.cacheMs` and `JudgeOptions.stateCacheMs` set the times (0 turns it off).

## Conventions

- TypeScript limited to erasable syntax (no enums, no parameter properties); relative imports end in `.ts`.
- No new npm dependencies. The two at runtime are the Flagsmith Node SDK and `yaml`.
- Every Flagsmith fact in code comments and docs cites the file and line in Flagsmith's source at the pinned image.
- `.bat` files keep CRLF and `.sh` files LF (`.gitattributes`).
