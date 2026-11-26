# Setting up Switchyard

The [README](../README.md#quick-start) has the short version. This page has the details: what the scripts do, the commands they run, judge mode on another device, Linux user ids, and what runs where.

## What you need

- Docker with Compose 2.20 or later (Docker Desktop on Windows and macOS, Docker Engine on Linux), with about 8 GB of RAM for Docker.
- Free ports 8000 (Flagsmith), 8080 (the proxy and the shop), 8090 (the console and judge mode) and 8091 (judge mode for other devices).
- For development only: Node.js 24 or later, npm and Git.

## The scripts

| Script | What it does |
|---|---|
| `setup.bat`, `setup.sh` | Checks Docker (and starts it), Compose 2.20+, memory, the three ports and `.env`, and for development Node.js 24+, npm and Git; on Windows also WSL 2. Offers to install anything missing: `winget` on Windows, Homebrew on macOS; on Linux it prints the `apt`/`dnf` or Docker install command and asks before running it with `sudo`. On Linux it also writes your user and group id to `.env` (see [Linux](#linux-user-ids)). `/check` (`--check`) changes nothing; `/yes` (`--yes`) installs without asking |
| `switchyard.bat`, `switchyard.sh` | Starts Flagsmith, sets it up on the first run, starts Switchyard, the console and the shop, runs `doctor`, and opens judge mode (`SWITCHYARD_NO_BROWSER=1` skips the browser) |

`switchyard.bat` and `sh switchyard.sh` take one action:

| Action | What it does |
|---|---|
| (none) or `start` | Start everything, check the setup and open judge mode |
| `demo` | The same, then send 1,500 simulated visitors through the proxy |
| `status` | Show what's running, run `doctor`, and print the links |
| `stop` | Stop every container; Flagsmith's data and the keys are kept |
| `reset` | Wipe Flagsmith's data, the ledger and the keys, then start from scratch. It asks first; `reset --yes` (`switchyard.bat reset /yes`) doesn't |

An unknown action or option stops the script with "Not started." before Docker is touched.

## By hand, in any shell

`compose.yaml` includes Flagsmith's official compose file (`compose.flagsmith.yml`) and the Switchyard overlay (`compose.switchyard.yml`), so plain `docker compose` works in PowerShell, cmd and any POSIX shell:

```bash
cp .env.example .env
docker compose up -d --wait flagsmith          # Flagsmith on 127.0.0.1:8000, once healthy
docker compose run --rm cli init               # admin, keys, tagged flag, metrics, experiment → .env
docker compose up -d --build                   # proxy :8080, console :8090, shop 1.4, 1.5 and 1.6
docker compose run --rm cli doctor             # is everything in place?
docker compose run --rm cli demo               # labelled simulated visitors
docker compose run --rm cli status --refresh   # Flagsmith's results (one refresh per 5 minutes)
```

To wipe everything: `docker compose --profile tools down -v`, then delete `.switchyard/`.

**On a fresh Flagsmith**, `init` creates the first admin itself (`POST /api/v1/auth/users/` with `superuser: true`, which Flagsmith accepts only while no users exist) and saves the login to `.env` straight away. It then connects Flagsmith's own event store, creates the flag (tagged `release`, permanent), the Feature Health provider, the goal and guardrail metrics, and starts the first experiment. Re-running it is safe: it starts the first experiment only when the flag has none.

**On an existing Flagsmith instance**, put an Organisation API key in `.env` as `SWITCHYARD_ADMIN_KEY` before running `init`.

`compose.flagsmith.yml` is Flagsmith's official `docker-compose.yml` with five edits, each listed in its header: the image tag is pinned to `2.291.0`, the API is published on `127.0.0.1` only (whatever `SWITCHYARD_PUBLISH_HOST` says), the task processor's port isn't published, the API also joins the `sdk` network, and it keeps idle connections open for 5 s (`GUNICORN_KEEP_ALIVE`; Flagsmith's default is 2, Node's client keeps them for 4).

## Checking the setup

`doctor` compares what Switchyard needs with what is there: Flagsmith and its version, the keys, the flag and its variants, the metrics, the experiment and its audience, the proxy, each shop release, Flagsmith's event counter, and whether `.switchyard/` and `.env` are writable. Each line is ok, a warning or a failure, with **Expected → Actual** where they differ and how to fix it. It exits 1 when something fails.

- `docker compose run --rm cli doctor` runs inside Compose and reads everything.
- <http://127.0.0.1:8090/setup> shows the same checks in the browser. **Check again** runs them fresh. It runs as the console, which doesn't mount `.env`, so it has no `.env` check.
- `node src/cli.ts doctor --api-url http://127.0.0.1:8000/api/v1/` runs from the host (after `npm install`). Flagsmith serves its Prometheus counter on port 9100 inside Compose only, so from the host that line reads "not checked from the host" and counts as ok.

Right after a restart, the proxy can warn once that its last flag refresh timed out while Flagsmith was starting; the next run is clean.

![The setup check at /setup: everything in place, 28 checks ok, no warnings, nothing failing](images/setup-check.png)

## Addresses: 127.0.0.1, not localhost

Compose publishes every port on `127.0.0.1`, and the links use `127.0.0.1`: on Windows, a client that tries `localhost`'s IPv6 address (`::1`) first waits for that attempt to be refused before it falls back.

Open the console and the shop on the **same hostname**. Judge mode shows the shop in a frame, and browsers drop the shop's `SameSite=Lax` cookies (the cart and the visitor id) in a frame from another site; `localhost` and `127.0.0.1` count as different sites. The start scripts and `init` follow the hostname in `SWITCHYARD_PUBLIC_SHOP_URL`, so an older `.env` that still uses `localhost` keeps working.

## Judge mode on another device

The console holds the admin key, so by default only this machine can reach it. To let a phone, tablet or another computer on your network open judge mode:

1. In `.env`, set:
   - `SWITCHYARD_CONSOLE_HOSTS` to this machine's address on the network, for example `192.168.1.20` (a comma-separated list is allowed);
   - `SWITCHYARD_PUBLISH_HOST=0.0.0.0`;
   - `SWITCHYARD_PUBLIC_SHOP_URL=http://192.168.1.20:8080`.
   
   `SWITCHYARD_JUDGE_TOKEN` must be set too; `init` writes it. The console refuses to start with other hosts listed and no judge token.
2. Run `docker compose up -d`.
3. Run `docker compose run --rm cli init` again. It prints `Judge link for other devices: http://<host>:8091/judge?key=…`, and a hint if the publish host or the shop URL doesn't match.
4. Open that link once on each device, **this machine included**, so every browser uses the same hostname as the shop.

Other devices use the console's second port, **8091**. The link carries `SWITCHYARD_JUDGE_TOKEN` and leaves a cookie that holds an HMAC of it. On port 8091 every request without that cookie is refused (403, or 421 for a host that isn't listed), whatever Host header it sends, and the admin password that the tour shows for Flagsmith's dashboard is never sent there. Port 8090, this machine's console, is published on `127.0.0.1` only. Rotate `SWITCHYARD_JUDGE_TOKEN` to revoke every judge device.

What this doesn't cover: a container on the console's Compose networks (`default`, `feed`), the proxy included, can reach port 8090 directly and name a loopback Host. That needs code running in one of those containers. The shops sit on `apps` only and can't reach the console.

`SWITCHYARD_PUBLISH_HOST=0.0.0.0` also publishes the proxy (the shop, port 8080) to your network. Flagsmith's dashboard and API stay on `127.0.0.1`: the official compose file's placeholder secrets are kept, so it isn't put on a shared network. On another device, "see it in Flagsmith" links point at this machine's dashboard and don't open there. The shops allow the console on the listed hosts to frame them; `SHOP_FRAME_ANCESTORS` replaces that list if you need something else.

## Linux user ids

The console and the CLI write `.switchyard/` (snapshots and the release ledger) and `.env` through bind mounts, so they run as `SWITCHYARD_UID:SWITCHYARD_GID` (default `1000:1000`, the image's `node` user).

- `sh switchyard.sh` sets both from `id -u` and `id -g`, and stops with the `chown` command to run if `.switchyard/` or `.env` isn't writable.
- `sh setup.sh` writes them to `.env` for anyone who runs `docker compose` directly.
- `doctor` fails the "State folder" or ".env file" check, with the fix, when either isn't writable.

macOS and Windows don't need this.

## What runs where

| Service | Published port | Networks | Keys it gets |
|---|---|---|---|
| `flagsmith` (API and dashboard) | 8000, always on `127.0.0.1` | default, sdk | |
| `flagsmith-task-processor`, `postgres`, `migrate-db` | none | default | |
| `switchyard` (the proxy) | 8080 | sdk, feed, apps | server key, preview token |
| `console` (console and judge mode) | 8090 on `127.0.0.1`; 8091 for other devices | default, feed | admin key and login, server key, preview and judge tokens, Feature Health URL, GitHub token |
| `shop-1-4`, `shop-1-5`, `shop-1-6` | none | apps | none; the shop has no Flagsmith code |
| `cli` (profile `tools`, one-off commands) | none | default, feed | reads the mounted `.env` |

- **default:** Flagsmith, its Postgres, the console and the CLI (the admin side).
- **sdk:** Flagsmith and the proxy: flag reads and events.
- **feed:** the proxy and the console: the traffic feed (internal port 8081) and judge mode's simulated visitors.
- **apps:** the proxy and the shops. The shops can't reach Flagsmith or the console.

So the proxy can't reach Postgres or the console's Flagsmith-admin traffic. The proxy's port and the console's port for other devices are bound to `SWITCHYARD_PUBLISH_HOST` (default `127.0.0.1`); Flagsmith's and the console's own port 8090 are always bound to `127.0.0.1`.

## Settings

`.env.example` documents every variable the code reads and every `${…}` value Compose uses, in sections: Flagsmith and keys, judge mode and other devices, Feature Health and the guard, the proxy, Linux, CLI-only, and the ones Compose sets for you. A few worth knowing:

- `SWITCHYARD_GUARD=revert` switches on the guard (see the README); `SWITCHYARD_GUARD_THRESHOLD` sets its threshold.
- `SWITCHYARD_SECURE_COOKIES=1` marks the proxy's cookies `Secure`; set it when a TLS proxy serves the shop over HTTPS.
- `SWITCHYARD_ACCESS_LOG=0` turns off the proxy's one-line-per-request access log.
- `GITHUB_TOKEN` and `GITHUB_REPOSITORY` write each decision into the GitHub Release for its tag.
- `SWITCHYARD_REPOSITORY_URL` names the repository for Code References when the checkout has no `https` GitHub `origin` remote; without one, `init` skips Code References and says why.
