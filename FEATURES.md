# Turnout features

Turnout is a reverse proxy in front of your web app. It turns every release into a Flagsmith experiment without any change to the app's code. When the experiment ends, it ships or reverts the release on the same flag.

## One command for your app
- **`turnout compare <live> <new> [<new2> …]`**: two versions make an A/B test, three an A/B/C test, and so on (an even split, each new version compared with the first). URLs, Docker images, or git branches (each built from its Dockerfile, the port from `EXPOSE`, your `.env` passed). No questions: a bundled Flagsmith, the flag, the experiment, the proxy and a check, then one page with **Open your site**.
- **No goal needed**: a version is judged on page speed with server errors as the guardrail; `--goal "POST /signup"` adds a conversion, and the page suggests goals from the requests it sees (with the right status, e.g. a form post's 303).
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
- **Exposures** are recorded when a returning visitor loads a page, using the same evaluation that routed the request.
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
| `new` | Asks four questions (which Flagsmith, which releases, the success rule, % of traffic) and writes the config and compose file for your app |
| `init` | Sets up the flag, metrics, experiment and Feature Health in Flagsmith. It works with your own Flagsmith via `--project/--environment` |
| `doctor` | Checks the whole setup and says what's missing (35 checks in server mode) |
| `check` | **Experiment Doctor** for any Flagsmith experiment, proxy or not. It finds leftover splits and wiring problems. Also available as a GitHub Action |
| `ship "<experiment link>"` | Ship or revert any Flagsmith experiment from its link, with a plan shown first |
| `preview`, `release`, `demo`, `code-refs` | Preview a release, start an experiment, run the demo, submit Code References to Flagsmith |

## Console and judge mode
- **Console** (`:8090`).
  - Shows live traffic, results, the Ship and Revert buttons, the release history, and a Flagsmith feature map (what's used and why).
  - The `/setup` page shows what's missing.
- **Judge mode** (`/judge`).
  - One desktop screen, no scrolling: four steps with one green button on the left; the versions (live previews) and Flagsmith's results on the right, one column per version with Flagsmith's call against A, and the verdict in one sentence.
  - **Pick the kind of test**: A/A (the same version twice: a fairness check), A/B, A/B/C (one experiment, every new version against A). Switching mid-test asks first.
  - A/B/C decisions: the best new version that is safe and clearly better ships; one that fails a safety check (C, slower pages) is named and left out.
  - **Tour**: ten highlighted stops with a Next button, under two minutes, on the first visit and from the Tour button. **Play it for me** runs one whole test.
- **Demo shop.** Three releases, each with its own look:
  - 1.4 Classic (blue)
  - 1.5 Express (green, one-page checkout)
  - 1.6 Bold (charcoal and orange, with a labelled 60 ms test fault that trips the guardrail)
- **Traffic simulator.** Simulated visitors, always labelled as simulated.

## Server mode (public deployment)
- **One command.** `sh turnout.sh server <hostname>` deploys with Caddy and automatic Let's Encrypt HTTPS.
- **Watch-only public judge page.** It shows a welcome card and a narrated tour, has no action buttons, and refuses every write.
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
- **Tests.** 649 tests (648 pass, 1 skipped) on Node's built-in test runner.
- **Evidence.** Results measured on Flagsmith 2.291.0 are recorded in `spikes/RESULTS.md`.

## Not built yet
- Several experiments running at once
- WebSocket routing
- A per-visitor opt-out
- Audiences on traits other than `preview`
- SPA in-browser navigations as page views
- A shareable one-page decision report
