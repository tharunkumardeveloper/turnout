<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/header-light.png">
  <img src="docs/images/readme/header-dark.png" width="100%" alt="Turnout: A/B test whole website releases on self-hosted Flagsmith. Visitors pass through the Turnout proxy, which asks Flagsmith for a version and sends each one to A (v1.4, what's live) or B (v1.5); Flagsmith is 99% sure B wins, so it ships.">
</picture>

[**▶ Demo video (2:50)**](https://www.youtube.com/watch?v=uoJtfs4HVrE) · [**Live demo**](https://172-198-62-67.sslip.io) · [Get started](#get-started) · [Features](#features) · [How Flagsmith is used](#how-flagsmith-is-used) · [Proof](#proof)

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/tharunkumardeveloper/turnout?quickstart=1)
[![CI](https://github.com/tharunkumardeveloper/turnout/actions/workflows/ci.yml/badge.svg)](https://github.com/tharunkumardeveloper/turnout/actions/workflows/ci.yml)
[![Installs](https://img.shields.io/github/downloads/tharunkumardeveloper/turnout/total?label=installs&color=6633ff "Downloads of the Release archives, which is what the one-line installers fetch (this includes the author's and reviewers' own test installs)")](https://github.com/tharunkumardeveloper/turnout/releases)
[![License: BSD-3-Clause](https://img.shields.io/badge/license-BSD--3--Clause-blue)](LICENSE)

</div>

A Flagsmith experiment normally lives in your app's code: `getExperimentFlag` and `trackEvent` at every touchpoint. That works for one button, not for *"is our redesign, or release 1.5, better than what's live?"* **Turnout puts the experiment at the front door instead:** two versions of your site behind one URL, a Flagsmith flag routing each visitor, plain HTTP turned into Flagsmith events, and Flagsmith Experimentation deciding the winner. Ship or Revert is one flag change. Your app never changes, in any language.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/numbers-light.png">
  <img src="docs/images/readme/numbers-dark.png" width="100%" alt="105 of 111 blind rounds decided right. 14 bad releases shipped by a 95% rule alone, 1 by Turnout. 0 of 68,141 events lost under load. 39 of 53 public GitHub repos built, tested and shipped from a link.">
</picture>

## Track 03 at a glance

| Track 03 asks for | Turnout |
|---|---|
| **Self-hosted Flagsmith** | Flagsmith's official Docker Compose file, pinned to 2.291.0, with Experimentation and its PostgreSQL event store: started and configured by one command, and running the [live demo](https://172-198-62-67.sslip.io) on a VM |
| **Integrations and plugins** | A Feature Health provider (a losing version shows Unhealthy in Flagsmith), Code References, a [GitHub Action](action.yml) with a job summary and one PR comment, and a tour inside Flagsmith's own dashboard |
| **Developer tools** | The `turnout` CLI (`compare`, `browsers`, `results`, `ship`, `revert`, `simulate`), a 28-check setup check, the Experiment Doctor with a sample-ratio check, a live console, and *Try it with your app* from GitHub links |
| **Easy for others to reuse** | One-line installers for Windows, macOS and Linux, Codespaces, a public image on GitHub Container Registry, an [agent skill](skills/turnout-experiment/SKILL.md), and 39 of 53 real GitHub repos run end to end ([each failure's reason listed](scoreboard/github-run.json)) |

### Why not split traffic at my CDN or load balancer?

You can, and Turnout can sit behind one. A weighted split (nginx `split_clients`, a load balancer's weighted target groups, a CDN rule) sends traffic to two versions and stops there: it doesn't know which visitor ordered, how sure you can be that one version is better, or whether the new one is slower or failing. Turnout adds the parts a split leaves out:

- Each visitor stays on one version, and their requests become Flagsmith events under the same identity.
- Flagsmith Experimentation decides, with a chance to be best and a credible interval.
- Page speed and server errors are checked before anything ships.
- Ship or Revert is one flag change, not an infrastructure edit and reload.

### What it measures, and what it doesn't

**Measures:** any request as the goal (`POST /signup`, `GET /thank-you`), page loads, server response time, server errors and, with `--browser-speed`, page speed from visitors' browsers.

**Doesn't measure on its own:** actions that never reach your server, conversions completed on another domain (an external checkout) unless the visitor returns to a page on your site, and one person across devices (identity is a cookie). Those need your app to send the event itself.

### Track 01: the experiment

- **Hypothesis:** shop 1.5 or 1.6 raises orders without hurting page speed or errors.
- **Flag:** `shop_release`, one multivariate flag: control 1.4, v2 1.5, v3 1.6, split evenly (Flagsmith experiment 375).
- **Metrics:** `order_placed` (goal), `doc_latency_ms` and `server_error` (safety), `add_to_cart`.
- **Result (2,100 visitors):** orders 10.8% on 1.4, 19.5% on 1.5 (+82%, interval +35% to +129%), 22.4% on 1.6 (+108%). But 1.6 was 45% slower (interval +39% to +52%), so it failed the safety check.
- **Decision:** shipped 1.5, the version that won on orders and held page speed (+1.3%, interval −4% to +6%). A 95% rule alone would have shipped 1.6.

## Get started

**1. Docker.** [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows, macOS) or Docker Engine (Linux), running, with about 4 GB of memory for it.

**2. Install, one line.** It downloads the tagged release and adds the `turnout` command:

**Windows** (PowerShell)
```powershell
irm https://raw.githubusercontent.com/tharunkumardeveloper/turnout/main/install.ps1 | iex
```
**macOS, Linux**
```sh
curl -fsSL https://raw.githubusercontent.com/tharunkumardeveloper/turnout/main/install.sh | sh
```

**3. Run it.**

The demo shop and the guided demo, at <http://127.0.0.1:8090>:
```sh
turnout demo
```
Or your own two running versions:
```sh
turnout compare localhost:3001 localhost:3002
```

`demo` starts self-hosted Flagsmith, creates the flag, metrics and experiment, starts the proxy and opens the console (about 2 minutes the first time). In the console, turn on **Guided demo** and press the green button in each step: Start, Send shoppers, Ask Flagsmith, Ship. `turnout uninstall` removes everything it set up.

<sub>Nothing to install: the [live demo](https://172-198-62-67.sslip.io), or [Codespaces](https://codespaces.new/tharunkumardeveloper/turnout?quickstart=1) (a 4-core codespace runs the same demo). Rather clone than pipe a script? See [Step by step](#step-by-step).</sub>

### Live demo or your machine?

The [live demo](https://172-198-62-67.sslip.io) shows the whole loop in a minute with nothing installed: run a test yourself, one button at a time. **For every feature, run it locally:** a shared public server can't run strangers' code or hand out Flagsmith's admin login.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/compare-light.png">
  <img src="docs/images/readme/compare-dark.png" width="100%" alt="Live demo and your machine both have: guided A/A, A/B and A/B/C tests you run yourself, blind rounds and the live traffic map, Be a visitor, and every Flagsmith feature Turnout uses (read-only on the live demo). Only your machine has: Flagsmith's dashboard with Turnout's tour inside it, Try it with your app from GitHub links, turnout compare on your own site with browsers and simulate, and Preview, Pin my browser and the guard. Install: one line, then turnout demo.">
</picture>

## See it

<table>
<tr>
<td width="50%" valign="top"><img src="docs/images/judge-ship.gif" alt="The live demo, run by a visitor: an A/B test, 1,400 shoppers, Flagsmith's call, Ship, the check that everyone gets 1.5, then the full console with each version's page and the live traffic map"><br><b>The live demo, run by a visitor.</b> Start, shoppers, Flagsmith's call, Ship; then the full console: every version and the live traffic.</td>
<td width="50%" valign="top"><img src="docs/images/try-it.gif" alt="Try it with your app: two GitHub links with no Dockerfile become versions A and B, built, started and put in a Flagsmith experiment"><br><b>Your app from a GitHub link.</b> Two links, no Dockerfile: Turnout builds them and starts the A/B test.</td>
</tr>
<tr>
<td width="50%" valign="top"><img src="docs/images/traffic.gif" alt="The console with Guided demo off: the test step by step at the top left; picking A/B shows its versions, Start and Send shoppers, and the traffic map shows every visitor sent to A or B by the Flagsmith flag"><br><b>The console: every visitor, live.</b> The test runs step by step on the left; the map follows it, each dot sent to a version by the flag.</td>
<td width="50%" valign="top"><img src="docs/images/flagsmith-tour.gif" alt="Turnout's tour inside Flagsmith's own dashboard: the flag, experiments, results and metrics"><br><b>Inside Flagsmith.</b> Everything Turnout does is a real Flagsmith object; its tour walks through them.</td>
</tr>
</table>

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/how-light.png">
  <img src="docs/images/readme/how-dark.png" width="100%" alt="1. A visitor arrives: Turnout gives them a stable id. 2. Flagsmith picks the version: one multivariate flag, evaluated locally. 3. Turnout serves it, the same version on every visit. 4. HTTP becomes events: page loads, speed, errors and the goal go to Flagsmith. 5. Flagsmith decides: ship, keep running or revert; Ship is one flag change.">
</picture>

The same experiment written with the SDK inside the demo shop took **45 lines of app code and hit two silent traps** ([with vs without](examples/with-sdk/README.md)); with Turnout the shop has 0 lines and the config 12. Unlike canary tools (Argo Rollouts, Flagger), which judge a release on errors, Turnout asks the product question, *does it get more sign-ups?*, and keeps errors and speed as safety checks. More: [How it works](docs/HOW_IT_WORKS.md).

## Features

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/features-light.png">
  <img src="docs/images/readme/features-dark.png" width="100%" alt="Run a test: turnout compare on URLs, images or git branches; Try it with your app from GitHub links; A/A, A/B and A/B/C. Measure: the goal from any HTTP request, server speed and errors, page speed in real browsers, bots never counted. Decide: Flagsmith's Bayesian result as returned; ships at 95% only if the interval clears zero; safety checks and how many more visitors. Release: Ship or Revert in one flag change, a preview segment, Pin my browser, Feature Health. See it: live traffic map, guided demo and tours, a 28-check setup check, every Flagsmith feature read live. Automate: a GitHub Action with a PR comment, an agent skill, server mode with HTTPS, turnout deploy. Install: one line on Windows, macOS and Linux, Codespaces, a GHCR image, turnout uninstall. Prove it: blind rounds, simulated shoppers and real Chrome visits, the Experiment Doctor with SRM.">
</picture>

Every feature, one line each: [FEATURES.md](FEATURES.md). Every command: [docs/CLI.md](docs/CLI.md).

## How Flagsmith is used

Self-hosted Flagsmith 2.291.0 from its official Docker Compose file ([compose.flagsmith.yml](compose.flagsmith.yml)), Experimentation on, its event store on PostgreSQL. **Turnout computes no statistics:** every number on its pages comes from Flagsmith's API.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/loop-light.png">
  <img src="docs/images/readme/loop-dark.png" width="100%" alt="The Flagsmith experiment loop, run by Turnout. Round 01, create a flag: multivariate flag, local evaluation, tags. Round 02, pick a metric: metrics, events, event store. Round 03, split the traffic: experiments, segments, identity overrides. Round 04, ship the winner: Bayesian results, environment default, Feature Health.">
</picture>

Also the Admin API (everything is created automatically) and Code References. Every Flagsmith fact with its source file and line: [docs/FLAGSMITH.md](docs/FLAGSMITH.md); every feature with its live value: the [Flagsmith features page](https://172-198-62-67.sslip.io/judge/flagsmith).

## Proof

**A real release, measured.** Gitea 28.0.0's release notes promise a faster repo page. Turnout ran 1.27.3 and 28.0.0 side by side with 940 real headless-Chrome visits and let Flagsmith decide: the server answers **13.8% faster** (100% sure), but the page's main content appears **no sooner** (+5.5%, interval −3% to +14%). [Method and raw numbers](docs/FINDING_GITEA.md).

**Flagsmith's calls, graded.** In 111 blind rounds on the live demo (true rates drawn at random and hidden), Flagsmith called 36 of 38 real differences, never in the wrong direction, and made 2 false calls in 28 rounds with no difference. Shipping whenever it was 95% sure would have shipped 14 bad releases; Turnout's interval and page-speed checks shipped 1. [The write-up](docs/BLIND_ROUNDS.md).

| Test | Result |
|---|---|
| Shipping under live traffic | a new visitor every 0.1 s: after Ship, 514 of 514 on the winner |
| Under load | 0 of 68,141 events lost, up to 200 visitors at once, counted in Flagsmith's own table |
| Flagsmith down | 100 of 100 pages still served (173 ms average, 170 ms with it up) |
| Any app | 12 sample apps (HTML, Vite, Next.js, Express, Flask, Django, Go, PHP…): 12 of 12 ship ([scoreboard](scoreboard/README.md)) |
| Real GitHub repos, pasted as links | 39 of 53 build, run, get Flagsmith results and ship; each failure's reason in [github-run.json](scoreboard/github-run.json) |
| A server, rebooted | every container back by itself, every check passing |

All measured during Toggle Wars; raw logs in [spikes/RESULTS.md](spikes/RESULTS.md). The demo's shoppers are simulated and labelled; real visitors on the live shop count in a separate experiment. Tried it? [Tell us how it went](https://github.com/tharunkumardeveloper/turnout/issues/new?template=tried-turnout.yml).

### Built on Flagsmith, given back to Flagsmith

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/upstream-light.png">
  <img src="docs/images/readme/upstream-dark.png" width="100%" alt="Flagsmith #9120: completing an experiment kept the old split (2.291.0); already fixed in 2.295.2, and Flagsmith rewrote its docs after the report (#9141). Node SDK #330 and PR #331: events dropped under load; the PR reports every drop. Node SDK #332: self-hosted events went to Flagsmith Cloud unless eventsApiUrl is set.">
</picture>

[Flagsmith#9120](https://github.com/Flagsmith/flagsmith/issues/9120) (docs: [#9141](https://github.com/Flagsmith/flagsmith/pull/9141)) · [flagsmith-nodejs-client#330](https://github.com/Flagsmith/flagsmith-nodejs-client/issues/330), fix [PR #331](https://github.com/Flagsmith/flagsmith-nodejs-client/pull/331) · [#332](https://github.com/Flagsmith/flagsmith-nodejs-client/issues/332). Turnout works around each one on 2.291.0: Ship drains the split, events wait while the SDK's buffer is full, and the events address is set to your instance.

## Step by step

<details>
<summary><b>Install from a clone instead</b> (or check your machine first)</summary>

```sh
git clone https://github.com/tharunkumardeveloper/turnout.git turnout
```
Then on **macOS, Linux**:
```sh
sh turnout/install.sh
```
Or on **Windows**:
```powershell
powershell -ExecutionPolicy Bypass -File turnout\install.ps1
```

Open a new terminal, then `turnout help`. Not sure your machine is ready? `sh turnout/setup.sh` (macOS, Linux) or `turnout\setup.bat` (Windows) checks Docker, Compose, memory and ports. On Linux your user must be able to run `docker`.
</details>

<details>
<summary><b>The demo, step by step</b></summary>

`turnout demo` opens <http://127.0.0.1:8090>. With **Guided demo** on:

1. Pick **A/A**, **A/B** or **A/B/C**. A preview of the versions shows first.
2. Press the green button in each step: **Start**, **Send shoppers**, **Ask Flagsmith**, then **Ship** or **Roll back**.
3. The **In Flagsmith** tab shows the flag, the split and the login for Flagsmith's dashboard at <http://127.0.0.1:8001>, where **✦ Turnout tour** walks through it.
4. **Be a visitor** gets you a version; **Pin my browser** always gives you one.

`turnout demo stop` stops it; `turnout demo reset` starts over. In a terminal only: [docs/TERMINAL.md](docs/TERMINAL.md). Everything to check: [docs/TESTING.md](docs/TESTING.md).
</details>

<details>
<summary><b>Test your own app</b></summary>

From your project's folder; the first version is **A**, what everyone gets today:

| You have | Run |
|---|---|
| Two versions running | `turnout compare localhost:3001 localhost:3002` |
| Two Docker images | `turnout compare myapp:1.0 myapp:1.1 --port 3000` |
| Three versions (A/B/C) | `turnout compare myapp:1.0 myapp:1.1 myapp:1.2 --port 3000` |
| Two git branches with Dockerfiles | `turnout compare main new-checkout` |

- `--goal "POST /signup"`: the request that counts as success (a 2xx or 303). No goal: judged on page speed. The console lists the requests it sees, with the exact `--goal` for each.
- `--split 10`: 10% get each new version. `--env-file .env.turnout`: your app's settings. `--browser-speed`: page speed from visitors' browsers.

The console opens at <http://127.0.0.1:8090>: run a test, open your site as a visitor (each new browser is a new visitor), decide. `turnout status` checks everything; `turnout down` stops, keeping data; `turnout reset` wipes.
</details>

<details>
<summary><b>Try it with your app, from the console</b> (local only)</summary>

Press **Try it with your app** and give one, two or three versions: a **GitHub link**, your **project folder**, a **Docker image** or a saved image file. A Dockerfile is optional; Turnout writes one for Node, Python, Go, PHP, Ruby, Java and static sites. It builds them, runs them behind its own proxy and flag (`tryit_release`), and opens your app's console at <http://127.0.0.1:8090/app>. It runs code over the Docker socket, so paste only repositories you would run yourself ([what it can do](docs/HOW_IT_WORKS.md#try-it-with-your-app-what-it-can-do-on-your-machine)), and it never runs on a public server.
</details>

<details>
<summary><b>No visitors yet?</b></summary>

- `turnout browsers --visits 200`: real headless-Chrome visits, labelled automated, so Flagsmith compares page speed in minutes.
- `turnout simulate --visitors 500`: pretend shoppers who browse, follow links and fill in your goal's form at a hidden rate per version, revealed at the end.

Both go to a separate Flagsmith environment, *Demo (simulated)*, never your real experiment.
</details>

<details>
<summary><b>Go live</b></summary>

Run `turnout compare` on the server that takes the traffic, then `turnout deploy your-domain.com` for your web server's lines (nginx `proxy_pass http://127.0.0.1:8080;`, or Caddy `reverse_proxy 127.0.0.1:8080`). Visitors keep your domain; the console stays private (open it over `ssh -L`). The live demo runs this way: [docs/JUDGE_MODE.md](docs/JUDGE_MODE.md).
</details>

<details>
<summary><b>Troubleshooting and good to know</b></summary>

- **Docker isn't running:** start Docker Desktop and wait for *Engine running*. **Out of memory:** give Docker 4 GB.
- **A port is busy:** Turnout picks the next free one and says so.
- **A version doesn't answer:** its last log lines are printed; pass its settings with `--env-file`.
- **Anything else:** `turnout status`, or <http://127.0.0.1:8090/setup> (28 checks).
- **Real results take real visitors:** a few hundred per version. Both versions share your database, as in blue/green. A single-page app's in-browser navigations aren't new visits: put the goal on an API call. One experiment per flag at a time (Flagsmith's rule). A first-party id cookie may need a cookie notice in the EU.
</details>

## Tech stack

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/stack-light.png">
  <img src="docs/images/readme/stack-dark.png" height="64" alt="Flagsmith, Node.js, TypeScript, JavaScript, Docker, PostgreSQL, Caddy, GitHub Actions, Azure">
</picture>

Node.js 24 running TypeScript directly (no build step) with two runtime dependencies (`@flagsmith/nodejs`, `yaml`); a console in plain HTML, CSS and JavaScript modules; Flagsmith 2.291 and its PostgreSQL event store in Docker Compose; Caddy for HTTPS on the Azure VM that hosts the live demo; GitHub Actions for CI and the reusable Action.

## Development

`npm test` runs 700 tests on Node's built-in runner; `npx tsc --noEmit` typechecks; CI also runs the full server stack. Layout and conventions: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

**How it was built:** much of the code, the tests and the documentation was written with Claude Code (Anthropic's coding assistant), working from my design and direction; commits it co-wrote carry a `Co-Authored-By: Claude` line. I reviewed what it wrote and can explain every part.

## License

[BSD-3-Clause](LICENSE), matching Flagsmith.
