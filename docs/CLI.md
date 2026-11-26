# The `switchyard` command

In the Compose stack, run commands with `docker compose run --rm cli <command>`. From a checkout with Node.js 24, `node src/cli.ts <command>` works too. `switchyard --help` prints the same list.

## Options for any command

| Option | Environment variable | What it is |
|---|---|---|
| `--api-url <url>` | `FLAGSMITH_API_URL` | Flagsmith's API, for example `http://127.0.0.1:8000/api/v1/` from the host or `http://flagsmith:8000/api/v1/` inside Compose |
| `--server-key <ser.…>` | `SWITCHYARD_SERVER_KEY` | A server-side environment key |
| `--admin-key <key>` | `SWITCHYARD_ADMIN_KEY` | An Organisation API key. Commands that need it ask for it when it isn't set, and never store it |

`status`, `ship` and `revert` take an experiment link (`…/environment/<key>/experiments/<id>`), or default to the flag's latest experiment in `SWITCHYARD_EXPERIMENT`'s environment.

An unknown option or a missing value prints what was wrong and exits 1, before anything is sent.

## Commands

| Command | What it does |
|---|---|
| `init` | Bootstraps Flagsmith: the first admin on a fresh instance, the event store, the flag (tagged `release`, permanent), the Feature Health provider, the metrics and the first experiment. Writes the keys to `.env`. Submits Code References when it can name the repository. Prints the judge-mode links |
| `doctor [--json]` | Checks that everything is set up as expected; exits 1 when something fails. See [SETUP.md](SETUP.md#checking-the-setup) |
| `demo` | Sends labelled simulated visitors through the proxy (see below) |
| `status [--refresh]` | Flagsmith's results for an experiment. `--refresh` asks Flagsmith to recompute; it allows one refresh every 5 minutes per experiment |
| `ship [--winner <variant>] [--yes] [--accept-losing-guardrails]` | Ship winner on the same flag. Prints the results and the plan, and waits for you unless `--yes`. A losing guardrail needs `--accept-losing-guardrails` with `--yes`, or a second confirmation. Prints the decision snapshot's path |
| `revert [--yes]` | Sends everyone back to control, drains the split and completes the experiment |
| `preview <label>` | Serves a new release to your team only, through the `switchyard-preview` segment. Open `<proxy>/__switchyard/preview?token=<SWITCHYARD_PREVIEW_TOKEN>` once in each browser that should see it |
| `release <label> [--hypothesis "…"] [--split <1-99>]` | Starts the next experiment on the same flag. `--split` is the share of the experiment's visitors who get the new release (default 50). The experiment has no audience: everyone the proxy routes can be enrolled |
| `check` | Finds experiment splits left behind on any flag (see below) |
| `code-refs [--project <id>]` | Finds the flag's name in this checkout and submits it to Flagsmith's Code References (see below) |
| `proxy` | Runs the reverse proxy (port 8080). Compose runs it for you |
| `console` | Runs the console and judge mode (port 8090). Compose runs it for you |

### `demo`

| Option | Default | Allowed |
|---|---|---|
| `--visitors` | 2000 | a whole number from 1 to 1,000,000 |
| `--rate <variant>=<rate>` | `control=0.1`, `v2=0.13` | a rate from 0 to 1; repeat the option for each variant |
| `--concurrency` | 20 | 1 to 1,000 |
| `--seed` | 42 | 0 to 2³²−1 |
| `--target` | `SWITCHYARD_PROXY_URL`, else `http://switchyard:8080` | an `http` or `https` URL |

Every option is checked before any traffic is sent. The rates are the simulator's inputs, not evidence.

### `check`

`check` is read-only and needs only a server key. It reads the environment document and reports each experiment split still on a flag, with how much traffic it covers, for example "50% of identities" or, for an experiment with an audience, "50% of identities matching its audience segment" (with an admin key, `matching segment "Beta"`). Flagsmith 2.291.0 allows one audience segment per experiment (`experimentation/constants.py:18`, `experimentation/serializers.py:271`); `check` also words an ANY or ALL audience of several segments, should a later version allow it. It exits 1 when it finds a split whose experiment isn't running.

- **With only a server key**, it can't tell a created or paused experiment from a completed one. Their splits are reported as "not running (created, paused or completed)" and counted.
- **With an admin key** (`--admin-key` or `SWITCHYARD_ADMIN_KEY`; never asked for), it reads each experiment's status. Created and paused experiments' splits are shown as warnings and don't fail the run; completed and deleted ones do. Audience segments are named.
- A drained split (0%) is reported as drained and doesn't fail the run.

The GitHub Action in `action.yml` runs `check` with the `server-key` input, and with `admin-key` when it is given.

### `code-refs`

Scans the checkout for the flag's name (skipping `docs/`, `test/`, `spikes/` and Markdown files) and submits the references to Flagsmith's Code References for the project (`--project`, `SWITCHYARD_PROJECT_ID`, or `SWITCHYARD_EXPERIMENT`'s project). In this repository the only reference is `switchyard.config.yml`; the app has none.

Flagsmith stores the repository URL and builds GitHub links from it, so the command needs one: GitHub Actions' own variables, an `https` GitHub `origin` remote, or `SWITCHYARD_REPOSITORY_URL` (with `SWITCHYARD_REVISION` for the commit). Without any of them it submits nothing and says why. The Action runs it when `admin-key` is given.

## Experiment audiences

The proxy sends Flagsmith one trait, `preview`, and only for preview browsers. An experiment audience built on any other trait matches no visitor, so `doctor` warns about it ("Experiment / Audience"). `switchyard release` creates experiments without an audience.
