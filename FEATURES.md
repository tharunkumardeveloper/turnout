# Turnout features

Turnout is a reverse proxy in front of your web app. It turns every release into a Flagsmith experiment without any change to the app's code. When the experiment ends, it ships or reverts the release on the same flag.

## One command for your app
- **`turnout compare <live> <new> [<new2> …]`**: two versions make an A/B test, three an A/B/C test, and so on (an even split, each new version compared with the first). URLs, Docker images, or git branches (each built from its Dockerfile, the port from `EXPOSE`). No questions: a bundled Flagsmith, the flag, the experiment, the proxy and a check, then one page with **Open your site**.
- **No goal needed**: a version is judged on page speed with server errors as the guardrail; `--goal "POST /signup"` adds a conversion (a 2xx or a 303 redirect counts; `"POST /signup 201"` to be exact), and the page suggests goals from the requests it sees.
- **`--env-file .env.turnout`**: your app's settings (database URL, keys), passed to every version Turnout starts (images and branches). Without it, the `.env` in your folder is used.
- **`--split 10`**: the share of visitors who get each new version (default: everyone, split evenly). Changed versions or settings start a new experiment.
- **Fixes itself**: busy ports are skipped; a private image is built from the checkout; a crashing version stops the run in seconds with its log lines.
- **`turnout deploy <domain>`**: the Caddy or Nginx lines to put your own web server in front. `down`, `reset`, `open`, `status`.
- **Installers**: `install.sh` (macOS, Linux) and `install.ps1` (Windows) put `turnout` on your PATH.

## Routing and identity
- **Zero app code.** Turnout routes each visitor to one release (for example `shop:1.4` vs `shop:1.5`) using a Flagsmith multivariate flag whose variant values are release labels.
- **One identity per visitor.** Each visitor gets a random first-party ID cookie (`tn_id`, kept for a year). It never holds a name, email or IP address.
- **Local flag evaluation.** The Node SDK evaluates the flag in-process, so routing adds no network call.
- **Allowlisted releases only.** The proxy can only reach releases listed in `turnout.config.yml`.
- **Safe fallback.** If Flagsmith hasn't loaded, takes more than 150 ms, has the flag off, or returns an unknown value, the visitor gets the live release. The live release is remembered across restarts.
- **Bots** are always served the live release and are never counted.
- **Release header.** The proxy sends the app an `X-Turnout-Release` header so the app knows which release served the request. Preview and debug requests also show a footer badge.

## Measurement (from HTTP, no SDK)
- **Exposures** are recorded from a visitor's first page load in a browser (so one-page visits count), using the same evaluation that routed the request.
- **Goals as HTTP rules.** A goal is written as a rule, such as `POST /checkout` returning 2xx → `order_placed`.
- **Funnel metrics.** Secondary metrics such as `add_to_cart` are tracked but never act as guardrails.
- **Built-in guardrails.** Every page load sends `doc_latency_ms` and `server_error`.
- **Event header.** An app can name events itself in a response header, `X-Turnout-Event: signup, plan_chosen;value=49`.
- **No lost events under load.** Turnout holds its own events back while the Flagsmith SDK's buffer is full (the SDK drops events then), and counts any drop so health and doctor show it. 0 of 121,678 lost at up to 200 concurrent visitors.
- **Counting rule.** A visitor counts from their first page load in a browser, so bounces are in the data. Without the cookie, API calls, assets, scripts and Turnout's own probes never become identities.
- **Single-page apps.** Goals go on API calls or the event header; verified on a Node SPA.
- **Flagsmith does all the statistics.** Lift, credible interval and chance to win come from Flagsmith's Bayesian engine. Turnout shows them exactly as returned.

## Decisions
- **Ship winner.** Ship runs five steps:
  1. Pause the experiment.
  2. Save a snapshot of the results.
  3. Set the flag's default to the winner.
  4. Drain the rollout to 0%.
  5. Complete the experiment.

  Each step shows its API call, is read back from Flagsmith afterwards, and is safe to re-run. Nobody is left behind on an old split.
- **Revert.** Runs the same sequence with control as the winner.
- **Swing back.** After a ship, one default edit moves everyone to another release. You can make it in Flagsmith's flag editor or with a console button.
- **Guardrail warning.** If the winner is losing a guardrail, Ship shows it in red and needs an explicit "ship anyway". A loss needs under 5% chance to win, more than 5% relative harm and, for page speed, at least 20 ms, so tiny differences never trip it. Warn at 5% (a person looks) but auto-revert only at 1% (nobody looks).
- **Keep running.** When Flagsmith's credible interval crosses zero, Turnout recommends **Keep running** instead of a ship.
- **Winner pre-selection.** The winner is pre-selected using the results page's own rule. A person still confirms it.

## Guarded releases
- **Feature Health.** Turnout reports the release flag's health to Flagsmith's Feature Health, through its Webhook provider. The flag shows as **Unhealthy** in Flagsmith's own dashboard, with the reason.
- **Guard** (opt-in, `TURNOUT_GUARD=revert`):
  - It reverts automatically when a guardrail's chance to win drops to 1% or below, with at least 100 identities.
  - It never ships on its own.

## Release lifecycle on one flag
- **`turnout preview <release>`.** A segment override (`turnout-preview`) shows the release to your team's browsers only, kept out of the experiment's data.
- **`turnout release <release> --hypothesis "…"`.** Starts the next experiment: today's release becomes control and the new one becomes v2.
- **`release --aa`.** Runs an A/A test (the same release on both sides) to check the setup. It also gives a launch estimate.
- **Release ledger.**
  - Every decision is written to `.turnout/ledger.jsonl` and `.turnout/RELEASES.md`: hypothesis, results, decision, any guardrail you accepted, and the snapshot path.
  - It can also post to GitHub Releases (`shop:1.6` → `v1.6`).

## CLI
| Command | What it does |
|---|---|
| `compare` | **The main path**: your versions (URLs, images or branches) to a running A/B or A/B/C test, with no questions (see the top of this page) |
| `new` | What `compare` runs underneath: writes the config and compose file for your app (asks four questions when run by hand) |
| `init` | Sets up the flag, metrics, experiment and Feature Health in Flagsmith. It works with your own Flagsmith via `--project/--environment` |
| `doctor` | Checks the whole setup and says what's missing (35 checks in server mode) |
| `check` | **Experiment Doctor** for any Flagsmith experiment, proxy or not. It finds leftover splits and wiring problems. Also available as a GitHub Action |
| `ship "<experiment link>"` | Ship or revert any Flagsmith experiment from its link, with a plan shown first |
| `preview`, `release`, `demo`, `code-refs` | Preview a release, start an experiment, run the demo, submit Code References to Flagsmith |

## Console and judge mode
- **Console** (`:8090`), the page `turnout compare` opens.
  - **Run a test, one button**: pick A/A, A/B or A/B/C and check the preview; one button starts the test in Flagsmith, sends simulated shoppers and asks Flagsmith for its results, waiting out Flagsmith's 5-minute refresh limit when it must. For your own app it only starts the test (no simulated shoppers).
  - **Try it with your app** (starts with `turnout.bat` / `sh turnout.sh`, local only): one, two or three versions given as Dockerfiles, public git repos or images; Turnout builds and runs them locally behind a proxy of its own (flag `tryit_release`), shows previews, and opens judge mode for them at `/try`. One version is an A/A test, two an A/B, three an A/B/C. Local only (Docker socket); never on a server.
  - **Refresh guard**: Flagsmith recomputes results at most once every 5 minutes, so the console holds a refresh back while no new visit has arrived since the start or the last results.
  - **Open your site: be a visitor.** Your browser gets a version like any visitor; **Your visits** lists where it landed before the test, in it and after the decision. **Pin this browser** to one version: a Flagsmith identity override for your visitor id (outside the test).
  - **Traffic map**: every routed request rides to its version; ghost dots always move along the tracks the flag routes to now; a **YOU** pin marks your version.
  - Decide (Ship, Revert, Keep running, with the Flagsmith calls shown first), Flagsmith's results, the release history, and a **Sign in to Flagsmith** box. The menu's **Flagsmith ↗** opens Flagsmith itself.
  - A **tour** of its own (the same engine as judge mode's).
- **Judge mode** (`/judge`), the demo shop's guided page.
  - One desktop screen, no scrolling: four steps with one green button on the left; the versions (live previews) and two tabs on the right: **What Flagsmith measured** (a column per version, Flagsmith's call against A, the verdict in one sentence) and **In Flagsmith** (the route each shopper takes with your YOU pin, the flag and its variants, the experiment, links into Flagsmith and its login).
  - **Pick the kind of test**: A/A (the same shop twice; the copy, A′, has a dashed outline), A/B, A/B/C. A click previews it; **Start** runs it.
  - **Be a visitor** and **Pin my browser**, as in the console.
  - A/B/C decisions: the best new version that is safe and clearly better ships; one that fails a safety check (C, slower pages) is named and left out. A safety check within the margin reads "slightly worse", never as a failure.
  - **Interactive tour**: it walks you through one whole test by clicks (pick a kind, start, send shoppers, ask Flagsmith, decide, look in Flagsmith, be a visitor) and waits while each step runs. **Play it for me** runs one whole test.
- **What we use** (`/flagsmith`): the four rounds of a Flagsmith experiment, each with the Flagsmith features Turnout uses for it and their live values, then every feature, menu and integration with filters and a search.
- **Demo shop.** Three releases, each with its own look:
  - 1.4 Classic (blue)
  - 1.5 Express (green, one-page checkout)
  - 1.6 Bold (charcoal and orange, with a labelled 60 ms test fault that trips the guardrail)
- **Simulated visitors.** Always labelled. Judge mode's shoppers are the demo's; for your own app, `turnout simulate` sends visitors that explore your site like people (links page by page, bounces, your forms filled in and submitted when they post to your goal), in a separate Flagsmith environment, for any number of versions.

## Server mode (public deployment)
- **One command.** `sh turnout.sh server <hostname>` deploys with Caddy and automatic Let's Encrypt HTTPS.
- **Read-only public console** at `/judge/console`: the traffic map, Flagsmith's results and the decisions, no buttons.
- **Blind rounds** on the public page: random hidden rates per round, revealed next to Flagsmith's call after the decision, with a scoreboard.
- **Watch-only public judge page.** The same judge page and tour, with no buttons; the current step says what the autopilot does next. It refuses every write, and rests while nobody has the page open.
- **Autopilot** (on by default in server mode):
  - Runs the full story on a loop: visitors → results → decision → verify → preview → next release → reset.
  - Any action from the private console pauses it for 10 minutes.
- **Private ports.** Flagsmith, the console and the admin ports are not reachable from outside.
- **Restarts.** The stack restarts automatically after a reboot.

## Setup and portability
- **Start scripts.** `turnout.bat` and `turnout.sh` take `start`, `demo`, `status`, `stop`, `reset [--yes]` and `server <host>`. `setup.bat` and `setup.sh` install prerequisites.
- **Runs on top of Flagsmith.** It is an overlay on Flagsmith's official self-hosted Docker Compose, or it can use your existing Flagsmith.
- **Works with any HTTP app.** Containers or apps on your machine (`host.docker.internal`). Verified on four app types. See [docs/PLUG_AND_PLAY.md](docs/PLUG_AND_PLAY.md).
- **Other ways to run it.** GitHub Codespaces and a devcontainer are supported. The Docker image is `ghcr.io/tharunkumardeveloper/turnout`.

## Security
- **Split keys.**
  - The proxy holds only the server key.
  - The admin key lives in the console and CLI.
  - No client key is ever published.
- **Split Docker networks.** The proxy can't reach Postgres or the console's admin traffic.
- **Open-proxy protection.** `//host`, absolute URLs and backslash request targets are rejected with a 400. WebSocket upgrades get a 501.
- **Console protection.**
  - The console is loopback-only, with a DNS-rebinding guard.
  - Every API call needs a per-boot token.
  - Actions are refused if the experiment changed since the page loaded.
- **Preview cookie.** It holds an HMAC of the preview token, not the token. Rotating the token revokes every preview browser.
- **Caching.** Responses carry `Cache-Control: private` and `Vary: Cookie`. Turnout's cookies are stripped before requests reach the app.

## Quality
- **Tests.** 660 tests (659 pass, 1 skipped on purpose) on Node's built-in test runner.
- **Evidence.** Results measured on Flagsmith 2.291.0 are recorded in `spikes/RESULTS.md`.

## Not built yet
- MongoDB, Postgres and MySQL are the throwaway databases Try it offers; others (Redis, Elasticsearch) are not
- Several experiments running at once
- WebSocket routing
- A per-visitor opt-out
- Audiences on traits other than `preview`
- SPA in-browser navigations as page views
- A shareable one-page decision report
