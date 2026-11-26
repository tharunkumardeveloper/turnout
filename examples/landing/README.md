# Example: a landing page

A second, different app behind Turnout: a static landing page with a **Sign up** button ([`demo/landing/server.ts`](../../demo/landing/server.ts), no Flagsmith code). Two releases run as two containers:

| Release | Headline | Button |
|---|---|---|
| `landing:1` (live) | Plan your week in one place | Sign up |
| `landing:2` | Get your Mondays back | Start free, no card |

Success is `POST /signup` answering 2xx, sent to Flagsmith as the `signup` event. [`turnout.config.yml`](turnout.config.yml) was written by:

```sh
turnout new --yes --release landing:1 --release landing:2 --success "POST /signup 2xx"
```

**Who counts.** The proxy records an exposure only when a visitor sends its cookie back on a page load ([`src/proxy/server.ts:130-142`](../../src/proxy/server.ts)), so one-request clients never become Flagsmith identities, and Flagsmith counts a conversion only after the exposure. A visitor who signs up from their very first page view isn't counted; one who comes back (or loads a second page) is. The simulator's `goal` flow views the page twice before signing up, for that reason.

## Run it on this repo's stack

[`compose.yml`](compose.yml) adds the two releases on top of the main stack (Flagsmith, the proxy, the console). From the repo root, in Git Bash, macOS or Linux:

```sh
export TURNOUT_CONFIG_FILE=./examples/landing/turnout.config.yml
LANDING="docker compose -f compose.yaml -f examples/landing/compose.yml"
$LANDING build landing-1 landing-2
$LANDING run --rm cli init --project Landing --environment Production   # your existing project
$LANDING up -d --wait turnout console landing-1 landing-2
$LANDING run --rm cli demo --visitors 3000 --rate control=0.10 --rate v2=0.14   # labelled simulated visitors
$LANDING run --rm cli status --refresh
```

`init --project` writes the landing environment's keys to `.env`, replacing the shop's: copy `.env` first if you want to go back to the shop demo, then restore it, unset `TURNOUT_CONFIG_FILE`, remove the two containers (`$LANDING rm -sf landing-1 landing-2`) and run `docker compose up -d --wait`.

The live run, with its numbers: [spikes/RESULTS.md](../../spikes/RESULTS.md).
