<div align="center">

<img src="src/console/ui/favicon.svg" width="72" height="72" alt="">

# Turnout

**Test a whole new version of your website on real visitors, then move everyone to the winner with one click.<br>No changes to your app's code. Built on self-hosted Flagsmith.**

[![Flagsmith](https://img.shields.io/badge/Flagsmith-self--hosted%20%C2%B7%20Experimentation-6633ff)](https://github.com/Flagsmith/flagsmith)
[![Node.js 24](https://img.shields.io/badge/Node.js-24-5fa04e?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-no%20build%20step-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ed?logo=docker&logoColor=white)](https://docs.docker.com/compose/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-event%20store-4169e1?logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![Tests](https://img.shields.io/badge/tests-600%2B%20passing-15803d)](#development)
[![License: BSD-3-Clause](https://img.shields.io/badge/license-BSD--3--Clause-blue)](LICENSE)

[**Live demo**](https://172-198-62-67.sslip.io/judge) · [Quick start](#quick-start) · [Step-by-step setup](#step-by-step-setup) · [How Flagsmith is used](#how-flagsmith-is-used)

<img src="docs/images/judge-ship.gif" width="860" alt="Judge mode: an A/B/C test on the demo shop. Shoppers go through, Flagsmith's results arrive, B ships and C is stopped by its slower pages">

</div>

## In plain words

You have the version of your website everyone uses today, and a new one you think is better. Turnout answers **"is it really better?"** with real visitors, and then switches everyone over safely.

Think of Turnout as a **receptionist at your website's front door**:

1. A visitor arrives. Turnout asks **Flagsmith**: *which version should this person see?*
2. Turnout sends them there, and keeps them on the same version every time they come back.
3. It watches what happens (pages loaded, how fast, sign-ups or orders) and tells Flagsmith.
4. **Flagsmith** works out which version is better, with its own statistics.
5. You press **Ship winner** (everyone gets the better one) or **Revert** (everyone goes back). One flag change, no redeploy.

```mermaid
flowchart LR
    V([Visitors]) --> T[Turnout proxy]
    T -- "which version?" --> F[(Flagsmith<br>flag + experiment)]
    T --> A[Version A<br>today's site]
    T --> B[Version B<br>the new one]
    T -. "page views, speed, sign-ups" .-> F
    F -- "B wins: 97% sure" --> D{You decide}
    D -- "Ship winner" --> F
```

It works for any website in any language: a shop, a sign-up page, a dashboard. You build the versions; Turnout never edits them.

**Why not just Flagsmith?** Flagsmith decides who sees what and does the maths, but normally your app's code has to ask it, which works for one button, not for two whole releases. Turnout is that missing front door. **Why not a canary tool?** Tools like Argo Rollouts or Flagger shift traffic to protect uptime and judge a release on errors. Turnout asks a product question, *does the new release get more sign-ups?*, and keeps errors and speed as safety checks.

## Track 03: why this exists

Turnout is what we wished existed while setting up Flagsmith's Experimentation on our own server. Each piece answers a problem we hit:

| We hit | So Turnout… |
|---|---|
| An experiment is app code at each touchpoint (`getExperimentFlag`, `trackEvent`, a visitor id). A whole new release has no single line to wrap. | Routes every request at the door, by one multivariate flag, and turns plain HTTP into Flagsmith events: no app code. |
| After ending an experiment and setting the flag's default, 144 of 300 visitors were still on the old split until the next experiment started. | **Ship winner** drains the split first: 300 of 300 on the winner ([details](docs/FLAGSMITH.md#ending-an-experiment-what-the-docs-say-and-what-the-pinned-image-does)). |
| The Node SDK dropped events tracked faster than one batch round-trip (28% in a minimal reproduction). | Holds its own events back while the SDK's buffer is full: 0 of 121,678 lost ([reproduction](spikes/sdk-buffer-repro/)). |
| Results recompute at most once every 5 minutes, and a Refresh before any visit wastes that window. | Asks only after visitors' events are in, and holds a pointless refresh back. |
| Outgoing webhooks refuse private addresses, so a self-hosted console can't receive them. | Reports health through Flagsmith's Feature Health provider instead. |
| Getting a test running took a dozen manual steps. | `turnout compare` (one command), a setup check, installers for every OS, and *Try it with your app* from the console. |

## Track 01: the experiment

| | |
|---|---|
| **Hypothesis** | The one-page checkout (1.5 Express) gets more orders than the 3-step checkout (1.4 Classic), without slower pages or more errors. |
| **Versions behind a flag** | `shop_release`, multivariate: `control` → 1.4, `v2` → 1.5 (and `v3` → 1.6 in the A/B/C test). |
| **Metric from real events** | `order_placed`: the proxy's event when `POST /checkout` answers 2xx. Safety checks: page load time and server errors. `add_to_cart` is watched too. |
| **Result** | Flagsmith: 1.5 at 20.3% against 10.1%, >99.9% chance to win, page speed unchanged; shipped with one flag change, then 50 of 50 new visitors on 1.5. In the A/B/C test, 1.6 sells a little more but its pages are 2.8× slower, so it's out. |
| **Honest about it** | Those shoppers are simulated (labelled) at rates we set. On the live demo, blind rounds draw the rates at random and hide them; the page reveals them next to Flagsmith's call and keeps a scoreboard. Real visitors who press *Be a visitor* count in a separate experiment, `shop_release_live`, whose goal is `add_to_cart` (it fires early enough for a few days of traffic) with `order_placed` watched. |

## See it in 2 minutes

Open the **[live demo](https://172-198-62-67.sslip.io/judge)**: it runs real Flagsmith experiments by itself on a demo shop with three versions (1.4 Classic, 1.5 Express with a one-page checkout, 1.6 Bold with deliberately slower pages). Simulated shoppers are always labelled.

- **Watch a test happen:** start, send shoppers, ask Flagsmith, decide, in four steps on one screen.
- **Blind rounds:** each round's true order rates are drawn at random and hidden (better, worse or the same). After the decision the page reveals them next to Flagsmith's call, and a scoreboard counts how often Flagsmith was right. When 1.6 is tested, its slower pages trip the safety check.
- **Look inside Flagsmith:** the *In Flagsmith* tab shows the flag, its split and the route each shopper takes.
- **Be a visitor:** press it, and Flagsmith gives you a version like any shopper. The route marks where you landed.
- **The console, read-only:** [/judge/console](https://172-198-62-67.sslip.io/judge/console) shows the live traffic map, Flagsmith's results and the decisions the autopilot makes.

On your own machine, judge mode is interactive: a guided tour tells you what to click at each step.

## Quick start

You need **Docker** ([Docker Desktop](https://www.docker.com/products/docker-desktop/) on Windows and macOS) with about 4 GB of memory for it, and **Git**.

```sh
git clone https://github.com/tharunkumardeveloper/turnout-practice.git turnout
sh turnout/install.sh                                         # macOS, Linux
powershell -ExecutionPolicy Bypass -File turnout\install.ps1  # Windows
```

Open a **new** terminal, then either try the demo or point it at your app:

```sh
turnout demo                                          # the demo shop and judge mode
turnout compare localhost:3001 localhost:3002         # your two running versions
```

`compare` starts its own Flagsmith, creates the flag and the experiment, starts the proxy, checks everything and opens the console. Every new browser is a new visitor.

## Step-by-step setup

<details>
<summary><b>1. Install Turnout (Windows)</b></summary>

1. Install **Docker Desktop**, start it, and wait until it says *Engine running*. In *Settings → Resources* give it at least 4 GB of memory.
2. Install **Git for Windows** if you don't have it.
3. Open **PowerShell** and run:
   ```powershell
   git clone https://github.com/tharunkumardeveloper/turnout-practice.git turnout
   powershell -ExecutionPolicy Bypass -File turnout\install.ps1
   ```
   This adds `turnout` to your PATH and shows what your machine has.
4. **Close PowerShell and open a new one**, so the new PATH applies. `turnout help` shows every command.

The first run builds Turnout's image from your checkout (about a minute, once).
</details>

<details>
<summary><b>1. Install Turnout (macOS, Linux)</b></summary>

1. Install Docker (Docker Desktop on macOS; Docker Engine with the Compose plugin on Linux) and start it.
2. Run:
   ```sh
   git clone https://github.com/tharunkumardeveloper/turnout-practice.git turnout
   sh turnout/install.sh
   ```
3. Open a new terminal. `turnout help` shows every command. On Linux, your user must be able to run `docker` (the `docker` group).
</details>

<details>
<summary><b>2. Try the demo shop</b></summary>

```sh
turnout demo
```

Your browser opens the console at <http://127.0.0.1:8090>. Turn on the **Judge mode** switch (next to **Tour**) for the step-by-step view, then follow the tour, or:

1. Pick **A/A**, **A/B** or **A/B/C** at the top. You see a preview of the versions first; nothing starts yet.
2. Press the green button in each step: **Start**, **Send shoppers**, **Ask Flagsmith**, then **Ship** or **Roll back**.
3. Open the **In Flagsmith** tab to see the flag, the split and the login for Flagsmith's own dashboard. At <http://127.0.0.1:8001> that dashboard has Turnout's tour on top: press **✦ Turnout tour**.
4. Press **Be a visitor** to get a version yourself, or **Pin my browser** to always get one (a Flagsmith identity override).

With the switch off, the console: pick A/A, A/B or A/B/C in **Run a test** and press its one button (it starts the test, sends simulated shoppers and asks Flagsmith for the results). `turnout demo stop` stops it; `turnout demo reset` starts from scratch.
</details>

**Step by step in a terminal:** [docs/TERMINAL.md](docs/TERMINAL.md). **Everything to check, UI and terminal:** [docs/TESTING.md](docs/TESTING.md).

<details>
<summary><b>2½. Try it with your app, from the console (no command line)</b></summary>

Try it starts with everything else (`turnout.bat` / `sh turnout.sh`), **on your machine only**: it builds and runs code over the Docker socket, so a public server never runs it. Then, on the console, press **Try it with your app** and give one, two or three versions, each as:

- **your project folder** (press **Choose project folder**; it needs a Dockerfile at its top. Turnout sends the folder with it, leaving out `node_modules` and `.git`. A folder with several Dockerfiles, such as `Dockerfile` and `Dockerfile.teal`, fills A and B by itself),
- or paste **anything** and Turnout works out what it is: a Dockerfile that copies no files, a **GitHub link**, or an **image** name (`nginx:alpine`, `myapp:1.1`),
- or **choose a file**: a Dockerfile, or an image saved with `docker save -o app.tar myapp:1.1`.

The only thing your app needs is a working Dockerfile. Turnout never asks you to change your app or convert it to a format of its own.

One version makes an A/A test (the same app twice, a fairness check), two an A/B test, three an A/B/C test. Turnout builds them on your machine, runs them behind a proxy of its own on a flag of its own (`tryit_release`), shows a live preview of each, and opens **your app's console** at <http://127.0.0.1:8090/app>: the same console (traffic, Flagsmith's results, Run a test, Decide) for your versions. Each version is also on its own preview address (A `:8086`, B `:8087`, C `:8088`), never counted. Optional: a goal (`POST /signup`, `GET /pricing.html`), the conversion rate simulated visitors use per version, and **settings for your app** (`KEY=value` lines, such as a database URL; your machine is `host.docker.internal`). **Use an example** fills in two small pages, so you can watch it work without an app of your own. Local only: it builds and runs code, so it never exists on a public server.
</details>

<details>
<summary><b>3. Test your own app</b></summary>

Go to your project's folder and give Turnout your versions. The first one is **A**, what everyone gets today.

| You have | Run |
|---|---|
| Two versions already running | `turnout compare localhost:3001 localhost:3002` |
| Two Docker images | `turnout compare myapp:1.0 myapp:1.1 --port 3000` |
| Three versions: an A/B/C test | `turnout compare myapp:1.0 myapp:1.1 myapp:1.2 --port 3000` |
| Two git branches, each with a Dockerfile | `turnout compare main new-checkout` |

Options:

- `--goal "POST /signup"`: the request that counts as success. A 2xx answer or a 303 redirect counts; add a status to be exact (`"POST /signup 201"`). No goal: versions are judged on page speed. The console lists the requests it sees, with the exact `--goal` for each.
- `--port 3000`: the port your app listens on inside its container (default: the Dockerfile's `EXPOSE`).
- `--env-file .env.turnout`: your app's settings (database URL, keys). Without it, the `.env` in your folder is used. Passed to every version Turnout starts (images and branches).
- `--split 10`: 10% of visitors get each new version; the rest stay on A. Default: everyone, split evenly.

When it's ready the console opens at <http://127.0.0.1:8090> (the next free port if that one is busy):

1. **Run a test:** pick A/A, A/B or A/B/C, check the preview, press Start.
2. **Open your site: be a visitor.** Each new browser or private window gets one version and keeps it. *Your visits* lists what you got before, during and after the test.
3. **Decide:** when Flagsmith is sure, the best version that passes every safety check is pre-selected. Ship or Revert shows the Flagsmith calls first.

`turnout down` stops (data kept), `turnout reset` wipes, `turnout open` reopens the console, `turnout status` checks everything.
</details>

<details>
<summary><b>4. No visitors yet? Simulate them</b></summary>

```sh
turnout simulate --visitors 500
```

Pretend visitors explore your site the way a person would: they load the home page, follow a few of its links (a quarter leave after one page), and at a hidden rate per version they make your goal. When a page has a form that posts to your goal, they fill it in (a made-up email, name and so on) and submit it. They go to a separate Flagsmith environment, *Demo (simulated)*, with its own console, so they never touch your real experiment; the hidden rates are revealed at the end. They are real requests to your app, so with a goal it asks first.
</details>

<details>
<summary><b>5. Go live</b></summary>

Run `turnout compare` on the server that takes the traffic, then `turnout deploy your-domain.com` for the lines to add to your web server:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

or, for Caddy, `reverse_proxy 127.0.0.1:8080`. Visitors keep your domain; the console stays private (open it over `ssh -L`).
</details>

<details>
<summary><b>Troubleshooting</b></summary>

- **"Docker isn't running":** start Docker Desktop and wait for *Engine running*.
- **A port is busy:** Turnout picks the next free one and says so.
- **A version doesn't answer:** its last log lines are printed. If it needs a database, pass its settings with `--env-file`, or run the versions yourself and give their URLs.
- **Out of memory:** Flagsmith and its database need about 1.5 GB; give Docker 4 GB.
- **"Flagsmith refused the refresh":** Flagsmith recomputes an experiment's results at most once every 5 minutes. Turnout holds a refresh back until new visits have arrived, so the window is never spent on nothing; the one-button run asks only after its visitors' events are in.
- **Something else:** `turnout status`, or <http://127.0.0.1:8090/setup>, compares what's expected with what's there (28 checks).
</details>

## How Flagsmith is used

Flagsmith runs self-hosted next to Turnout (its official Docker Compose file, Experimentation switched on, its own event store). Turnout computes no statistics: every number on its pages comes from Flagsmith's API. The console's *What we use* page shows each feature live.

| Round | Flagsmith feature | What it does in Turnout |
|---|---|---|
| Create a flag | **Multivariate flag**, local evaluation | One flag per app; each variant's value names a version. The proxy evaluates it in-process with the server-side key. |
| Pick a metric | **Metrics and events**, event store | Plain HTTP becomes Flagsmith events: page loads, page speed, server errors and the goal request. |
| Split the traffic | **Experiments**, Bayesian results | Each test is a Flagsmith experiment (A/A, A/B, A/B/C). Its chance to win and credible interval decide Ship, Keep running or Revert. |
| | **Segments**, **identity overrides** | A preview segment shows the next version to your team; *Pin my browser* is an identity override for your visitor id. Both stay out of the test. |
| Ship the winner | **Environment default**, rollout | Ship and Revert set the flag's default and drain the split: everyone moves with one flag change. |
| | **Feature Health**, tags, Code References | A losing safety check marks the flag Unhealthy in Flagsmith's dashboard; an opt-in guard can revert by itself. |

Every Flagsmith fact, with its source file and line: [docs/FLAGSMITH.md](docs/FLAGSMITH.md).

## Features

| | |
|---|---|
| **Your app** | `turnout compare` for URLs, images or git branches, any number of versions; goals optional; `--env-file`; installers for Windows, macOS and Linux; `turnout deploy` |
| **Guided** | Judge mode with an interactive tour; a console tour; one button runs a whole test; *Try it with your app* (Dockerfiles, git repos or images); *Be a visitor* with a YOU pin; *Pin my browser* (identity override) |
| **Measuring** | Sticky visitor ids, bots never counted, bounces counted, goals from HTTP or one response header; 0 of 121,678 events lost under load |
| **Deciding** | Flagsmith's results as returned; keep running while unsure; safety checks with a sensible margin (20 ms for page speed); A/A fairness checks |
| **Releasing** | Ship and Revert that reach everyone; swing back with one edit; preview for your team; a release ledger and GitHub Releases |
| **Tools** | `doctor` and `/setup` (28 checks); `check`, an Experiment Doctor for any Flagsmith experiment (also a GitHub Action); server mode with HTTPS and an autopilot |

Everything, one line each: [FEATURES.md](FEATURES.md). How each part works: [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md).

## Proof

| | Result |
|---|---|
| Your app, from an empty folder | `turnout compare` running in under 3.5 minutes; sign-ups counted end to end; after Ship, 100 of 100 new visitors on the winner |
| Shipping under live traffic | 263 of 263 later visitors on the winner; 0 left behind |
| Flagsmith down | 100 of 100 pages still served, 86 ms average |
| Under load | 0 of 121,678 events lost at up to 200 visitors at once |
| Any app, automatically | 12 sample apps (HTML, Vite, Next.js ×2, Express, Flask, Django, Go, PHP, no Dockerfile, needs a database, needs a setting): builds 12/12, goals 11/12, counts match Flagsmith 12/12, ships 12/12 (`npm run scoreboard`, [scoreboard/](scoreboard/README.md)) |
| A server, rebooted | back by itself in 50 s, every check passing |

Raw logs and numbers: [spikes/RESULTS.md](spikes/RESULTS.md). Not claimed: production users, or any simulated number as evidence about real people.

## Good to know

- **Real results take real visitors:** a few hundred per version. Ten clicks prove the wiring, not the winner.
- **Both versions share your database** (as in blue/green): the new one must not break the old one's data.
- **Page-level:** a single-page app's in-browser navigations aren't new visits; put the goal on an API call or the `X-Turnout-Event` header.
- **One experiment per flag at a time** (Flagsmith's rule). **Built on a beta**: versions are pinned.
- **A new hop in your traffic path**, and a first-party id cookie (a cookie notice may apply in the EU).

## Development

`npm test` runs the unit and integration tests (Node's built-in runner; Node 24 runs the TypeScript directly, no build step). `npx tsc --noEmit` typechecks. Layout and conventions: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## License

[BSD-3-Clause](LICENSE), matching Flagsmith.
