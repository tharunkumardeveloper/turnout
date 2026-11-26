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
| `release <label> [--hypothesis "…"] [--split <1-99>] [--mde <pct>] [--daily-visitors <n>]` | Starts the next experiment on the same flag. `--split` is the share of the experiment's visitors who get the new release (default 50). The experiment has no audience: everyone the proxy routes can be enrolled. Prints a rough launch estimate (see below) |
| `release --aa` | Starts an A/A experiment: the live release on both arms (see below) |
| `check` | Finds experiment splits left behind on any flag; with an admin key, also runs the Experiment Doctor (see below) |
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

#### Experiment Doctor (with an admin key)

With an admin key, `check` then runs the Experiment Doctor on every running and paused experiment in the environment, and on those completed in the last 14 days. It works for any Flagsmith Experimentation user, with or without the Switchyard proxy, and only reads. Each check prints pass, warn, fail or skip; a warn or fail also prints what it means and how to fix it. Any fail makes `check` exit 1. These are sanity checks on how data reaches the experiment, not results: Flagsmith's results page says which arm is better.

| Check | Fails when |
| --- | --- |
| exposures | One arm has exposed visitors and another has none |
| tracking | An arm has visitors but no events for a metric that another arm records, and the other arm's rate predicts at least 10 events there (3 to 10 warns). For a lower-is-better guardrail (errors, latency) it only warns, since zero can be real |
| sample ratio | The arms' visitor counts don't match the configured split, p < 0.001. Uses Flagsmith's `srm_p_value` when the results have one; otherwise the same chi-square goodness-of-fit (`experimentation/stats.py:87-129`) against the experiment rollout's split. Skipped under 100 exposed visitors, Flagsmith's own floor (`experimentation/constants.py:24`) |
| late multivariate | Always skipped: Flagsmith's API keeps no date for when a flag's variants were added, so a flag converted to multivariate after its experiment started can't be detected |

Flagsmith 2.291.0 computes `srm_p_value` against the flag's environment-default allocation (`experimentation/services.py:419-469`). Switchyard keeps v2 at 0% there and splits in the experiment rollout, so for Switchyard's experiments the doctor's own chi-square is the one shown.

#### In GitHub Actions

The Action in `action.yml` runs `check` with the `server-key` input, and with `admin-key` when it is given, which turns the Experiment Doctor on:

```yaml
- uses: actions/checkout@v5
- uses: <owner>/switchyard@v1
  with:
    api-url: https://flagsmith.example.com/api/v1/
    server-key: ${{ secrets.FLAGSMITH_SERVER_KEY }}
    admin-key: ${{ secrets.FLAGSMITH_ADMIN_KEY }} # optional: experiment statuses and the Experiment Doctor
```

### `release`: A/A runs and the launch estimate

`switchyard release --aa` (or `release <live label> --against-itself`) starts an A/A experiment: v2 serves the live release, the same as control, with the hypothesis "A/A: same release on both arms; any winner is noise". The proxy routes both arms to the same upstream. Use it to test the tracking and the split before a real release; then run `check` with an admin key. Flagsmith accepts two arms with the same value: a flag's variants must have unique keys, not unique values (`features/multivariate/models.py:73`, `features/multivariate/serializers.py:138-147`).

After starting an experiment, `release` prints one line: roughly how many visitors each arm needs to detect a relative lift (`--mde <pct>`, default 10) at control's goal rate in the previous experiment, n ≈ 16·p(1−p)/(p·mde)² (80% power, 5% two-sided). Without a previous goal rate it says unknown. `--daily-visitors <n>` adds the days that takes, paced by the smaller arm. It is a rough estimate; Flagsmith does the real statistics; don't ship on an early reading.

### `code-refs`

Scans the checkout for the flag's name (skipping `docs/`, `test/`, `spikes/` and Markdown files) and submits the references to Flagsmith's Code References for the project (`--project`, `SWITCHYARD_PROJECT_ID`, or `SWITCHYARD_EXPERIMENT`'s project). In this repository the only reference is `switchyard.config.yml`; the app has none.

Flagsmith stores the repository URL and builds GitHub links from it, so the command needs one: GitHub Actions' own variables, an `https` GitHub `origin` remote, or `SWITCHYARD_REPOSITORY_URL` (with `SWITCHYARD_REVISION` for the commit). Without any of them it submits nothing and says why. The Action runs it when `admin-key` is given.

## Experiment audiences

The proxy sends Flagsmith one trait, `preview`, and only for preview browsers. An experiment audience built on any other trait matches no visitor, so `doctor` warns about it ("Experiment / Audience"). `switchyard release` creates experiments without an audience.
