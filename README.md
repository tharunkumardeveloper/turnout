# Turnout

**Test a whole new version of your website on real visitors, and switch everyone to the better one, without changing a line of its code.** Turnout sits in front of your site and uses Flagsmith to decide, measure and roll out.

**Live demo, running by itself:** <https://172-198-62-67.sslip.io/judge> (read-only; no sign-in)

![Judge mode: an A/B/C test on the demo shop. Simulated shoppers go through, Flagsmith's results arrive, B ships and C is stopped by its slower pages, then 50 new shoppers all get B](docs/images/judge-ship.gif)

## In plain words

Think of Turnout as a receptionist at your website's front door.

1. A visitor arrives at your one address. Turnout asks **Flagsmith**: version A or version B?
2. Turnout sends them there, and keeps them on that version every time they come back.
3. It watches what happens (pages loaded, how fast, sign-ups or orders) and reports it to Flagsmith as events.
4. **Flagsmith** works out which version is better, with its own statistics.
5. You press **Ship winner** (everyone gets the better version) or **Revert** (everyone goes back). One click, nobody left behind.

You build the two versions; Turnout never edits your site. It works for any website in any language: a shop, a sign-up page, a dashboard.

**Why not just Flagsmith?** Flagsmith decides who sees what and does the maths. But something has to stand at the door and actually send each visitor to a version. Normally that's code inside your app, which works for one button, not for two whole releases. Turnout is that missing piece: *Flagsmith decides who sees what; Turnout makes that decision real for whole releases, without changing your app.*

**Why not a canary tool?** Canary and blue/green tools (Argo Rollouts, Flagger, a load balancer's weights) shift traffic to protect uptime: they judge a release on errors and latency. Turnout keeps each visitor on one version and asks a product question, *does the new release get more sign-ups or orders?*, with Flagsmith's Bayesian results, while errors and page speed stay as safety checks.

## See it in 2 minutes

Open the [live demo](https://172-198-62-67.sslip.io/judge). A short tour starts on the first visit. Then the page runs real Flagsmith experiments by itself on a demo shop, with simulated shoppers (always labelled), on one screen:

- **Left: the test in four steps.** Start the test, send shoppers, ask Flagsmith, decide. The current step says what the autopilot does next.
- **Right: the versions and Flagsmith's numbers.** A live preview of each version (1.4 Classic, blue, a 3-step checkout · 1.5 Express, green, a one-page checkout · 1.6 Bold, which sells a little more but has deliberately slower pages), and a table of what Flagsmith measured: orders as the goal, page speed and server errors as safety checks, each with Flagsmith's call against A.
- **The story it plays:** 1.5 Express beats 1.4 Classic on orders and ships to everyone with one flag change. Then 1.6 Bold is tested against 1.5: it gets more orders, but its pages are slower, so the safety check stops it and everyone stays on 1.5. After each decision, 50 brand-new shoppers check that everyone really gets the result.
- **The Versions menu** opens each version on its own (never counted), or the plain shop link, where you get a version the way a real visitor does.

## Try it with your app (about 5 minutes)

You need Docker (Docker Desktop on Windows and macOS) with about 4 GB of memory for it: the whole stack peaked at 1.45 GB under load. Get Turnout once (a private practice repo for now):

```sh
git clone https://github.com/tharunkumardeveloper/turnout-practice.git turnout
sh turnout/install.sh                                                  # macOS, Linux
powershell -ExecutionPolicy Bypass -File turnout\install.ps1           # Windows (PowerShell or CMD)
```

Then run the version you have and the version (or versions) you want to test, and give Turnout all of them, from your project's folder:

```sh
turnout compare localhost:3001 localhost:3002
```

That's it: no questions, no app code. Turnout starts its own Flagsmith, creates the flag and the experiment, starts the proxy, checks everything and opens one page with an **Open your site** button. Each new browser is a new visitor: half get the second version and keep it; Flagsmith compares the two, and **Ship winner** or **Revert** moves everyone to one. Two versions make an A/B test; three make an A/B/C test (a third of visitors each, every new version compared with the first), and so on.

| You have | Run |
|---|---|
| Two versions running (any language, any server) | `turnout compare localhost:3001 localhost:3002` |
| Two Docker images | `turnout compare myapp:1.0 myapp:1.1 --port 3000` |
| Three or more versions: an A/B/C test | `turnout compare myapp:1.0 myapp:1.1 myapp:1.2` (URLs, images or branches; not a mix) |
| A git project with a Dockerfile, two branches | `turnout compare main new-checkout` (each built from its last commit; your `.env` is passed; the port comes from `EXPOSE`) |

- **No goal needed to start:** a version is judged on page speed, with server errors as the guardrail. To measure a conversion, add `--goal "POST /signup"` (a 2xx answer or a 303 redirect counts, the usual answers to a form that worked; add a status to be exact, such as `"POST /signup 201"`). The page lists the requests it sees, with the exact `--goal` for each.
- `--split 10` sends 10% of visitors to each new version (the rest get the first). By default every visitor is split evenly. Different versions or settings start a new experiment.
- Ports already taken (8080, 8090, 8000) are skipped, and the next free ones are used. A version that crashes stops the run within seconds, with its last log lines.
- **No visitors yet? `turnout simulate`** sends pretend visitors (500 by default) so results appear in minutes. They go to a separate Flagsmith environment, "Demo (simulated)", with its own console, so they can never touch your real experiment; their hidden rates are revealed at the end. They are real requests to your app, so with a goal it asks before sending them.
- `turnout down` stops (the same `compare` resumes, data kept), `turnout reset` wipes, `turnout open` reopens the page, `turnout demo` starts the demo shop, `turnout update` gets the latest Turnout.
- The Turnout image can't be pulled while the repository is private, so the first run builds it from your checkout (about a minute, once).

## Go live

Run `turnout compare` on the server that will take the traffic, then `turnout deploy your-domain.com`: it prints the lines for the web server you already have, for example Nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

or, for Caddy, `reverse_proxy 127.0.0.1:8080`. Visitors keep using your domain and never see a second link; Turnout picks their version. Its own port and the console stay on 127.0.0.1 (open the console over `ssh -L`).

## How Flagsmith is used

Flagsmith runs self-hosted next to Turnout (its official Docker Compose file, Experimentation switched on, its own event store). Turnout never computes statistics: every number and call on its pages comes from Flagsmith's API.

| Flagsmith feature | What it does in Turnout |
|---|---|
| **Multivariate flag** | One flag per app; each variant's value names a version (`shop:1.5`). The proxy routes every visitor by it, evaluated locally with the Node SDK. |
| **Experiments** | Each comparison is a Flagsmith experiment on that flag: A/B, A/B/C or A/A, with a hypothesis, created and started by Turnout's API calls. |
| **Events and metrics** | Plain HTTP becomes Flagsmith events: page loads (exposures, page speed, server errors) and the goal request (`POST /checkout` → `order_placed`). |
| **Bayesian results** | Flagsmith's chance to win and credible interval decide Ship, Keep running or Revert. A version that loses a safety check never ships. |
| **Environment default and rollout** | Ship winner and Revert pause the experiment, set the flag's default, drain the split and complete it: everyone moves, in one flag change. |
| **Segments** | A preview segment shows the next version to your team before the experiment, kept out of its data. |
| **Feature Health** | A losing safety check marks the flag Unhealthy in Flagsmith's own dashboard; an opt-in guard can revert by itself. |
| **Tags, Code References** | The flag is tagged `release` (permanent); Code References show where its name is configured. |

Every Flagsmith fact above, with its source file and line: [docs/FLAGSMITH.md](docs/FLAGSMITH.md).

## What's inside

| | |
|---|---|
| **For your app** | `turnout compare` (two URLs, images or git branches; no questions); a goal is optional (no goal: judged on page speed); goal suggestions from the requests it sees; `turnout deploy` (Caddy or Nginx lines); installers for Windows, macOS and Linux |
| **Measuring** | sticky visitor IDs; events from plain HTTP (`POST /checkout` returned 2xx) or one response header; bounces counted; bots never counted; page speed and errors as guardrails; no events lost under load |
| **Deciding** | Flagsmith's Bayesian results, shown as returned; "keep running" while the interval crosses zero; a 20 ms floor so tiny speed differences never block a release; A/A tests |
| **Releasing** | Ship winner and Revert in an order that reaches everyone; swing back with one edit; preview links for your team; the next release on the same flag; a release ledger (and GitHub Releases) |
| **Safety** | Flagsmith's Feature Health shows a losing guardrail on the flag; an optional guard that reverts on its own (never ships); the shop keeps working if Flagsmith is down |
| **Tools** | `doctor` (35 checks); `check`, an Experiment Doctor for any Flagsmith experiment (also a GitHub Action); server mode with HTTPS and an autopilot |

Everything, one line each: [FEATURES.md](FEATURES.md). How each part works: [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md).

## Proof

| | Result |
|---|---|
| Your app, from an empty folder | `turnout compare`: running in 152 s (two URLs) and 167 s (two branches); 2,000 new visitors split 49.3% / 50.8% at 50% |
| Shipping under live traffic | 263 of 263 later visitors on the winner; 0 left behind |
| Flagsmith down | 100 of 100 pages still served, 86 ms average |
| Under load | 0 of 121,678 events lost at up to 200 visitors at once, counted in Flagsmith's own table |
| Data loss found in Flagsmith's Node SDK | events tracked faster than one batch round-trip are dropped, with only a log warning (28% lost in a minimal reproduction); Turnout holds its events back to avoid it; [reproduction and draft report](spikes/sdk-buffer-repro/) |
| A server, rebooted | back by itself in 50 s, 35 of 35 checks passing |

Raw logs and every number: [spikes/RESULTS.md](spikes/RESULTS.md). Not claimed: production users, or any simulated number as evidence about real people.

## Good to know

- **Real results take real visitors:** a few hundred per version. Ten clicks prove the wiring, not the winner.
- **Both versions share your database**, so the new one must not break the old one's data.
- **Both versions share state**, as in blue/green: schemas must stay backward compatible.
- **Page-level only.** SPA navigations aren't new exposures; conversions must be visible in HTTP (a request, or an `X-Turnout-Event` response header). In an SPA, set the goal on an API call or the event header.
- **One experiment per flag per environment** (Flagsmith's rule): releases run one at a time.
- **A new hop in the traffic path.** Teams will want to put the proxy through their own security review.
- **The ID cookie** is an online identifier; in the EU a cookie notice or consent may apply.
- **Routing follows a flag change** after Flagsmith's document rebuild plus up to the SDK's 5-second refresh.
- **`ship` is refused** where change requests are enabled (`features/future/views.py:31-44`).
- **Built on a beta.** Image and SDK versions are pinned; Flagsmith's own event store is for evaluation, not production volumes.
- **Not built:** statistics of its own, automatic shipping (the guard only reverts), WebSocket routing, a per-visitor opt-out, experiment audiences on traits other than `preview` (the proxy sends no other traits; `doctor` warns).
- **The guard acts on Flagsmith's results**, which refresh at most every 5 minutes; harm can run that long before a revert.
- **Flagsmith features not used**, each with its reason, are listed on the console's `/flagsmith` page and in [docs/FLAGSMITH.md](docs/FLAGSMITH.md); for example, Flagsmith's outgoing webhooks refuse private addresses, so they can't call a console on the Compose network.

## The demo on your machine

A shop with three releases, simulated visitors and a guided tour. Get the code as above, then:

| | Start (one command) |
|---|---|
| Windows | double-click `turnout.bat` (first time on this machine: `setup.bat` checks and installs what's needed) |
| macOS, Linux | `sh turnout.sh` (first time: `sh setup.sh`) |
| In the browser | [![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/tharunkumardeveloper/turnout-practice) (needs access to the repo; open the judge link the terminal prints at the end) |

**When it works,** your browser opens judge mode at <http://127.0.0.1:8090/judge>: one screen with a two-minute tour. Pick the kind of test (A/A, A/B or A/B/C), then follow the green button, or choose **Play it for me**. If anything is missing, <http://127.0.0.1:8090/setup> (or `docker compose run --rm cli doctor`) says what.

## Development

`npm test` runs the unit and integration tests (Node's built-in runner; no build step, since Node 24 runs the TypeScript directly). `npx tsc --noEmit` typechecks. Layout, commands and conventions: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## License

BSD-3-Clause, matching Flagsmith.
