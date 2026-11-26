# Turnout from the terminal, step by step

Everything runs on your machine's Docker. Flagsmith comes with Turnout, so there is nothing else to install.

## 1. What you need

- **Docker Desktop** (Windows, macOS) or Docker Engine (Linux), running, with about **4 GB** of memory.
- **Git**, to get Turnout and to compare git branches.

## 2. Install the `turnout` command (once)

```sh
git clone https://github.com/tharunkumardeveloper/turnout.git turnout
cd turnout
```

| Your machine | Install | Undo |
|---|---|---|
| macOS, Linux | `sh install.sh` | `rm ~/.local/bin/turnout` |
| Windows (PowerShell or CMD) | `powershell -ExecutionPolicy Bypass -File install.ps1` | remove `turnout\bin` from your user Path |

Open a **new** terminal, then check it:

```sh
turnout version      # turnout 1.0.0
turnout help         # the logo, what your machine has, and every command
```

`turnout` uses the published Turnout image when it can download it, and otherwise builds one from this folder.
The first build takes about a minute.

## 3. The demo, about 3 minutes

```sh
turnout demo         # starts Flagsmith, sets it up the first time, starts Turnout and the demo shop
```

Your browser opens the console at <http://127.0.0.1:8090>.

| Address | What it is |
|---|---|
| <http://127.0.0.1:8090> | **The console**: traffic map, Flagsmith's results, Run a test, Decide. The **Judge mode** switch next to **Tour** shows the step-by-step view. |
| <http://127.0.0.1:8080> | The demo shop through Turnout: you get one version and count as a visitor. |
| <http://127.0.0.1:8001> | **Flagsmith's dashboard with Turnout's tour.** Press **✦ Turnout tour** at the bottom right. |
| <http://127.0.0.1:8000> | Flagsmith's dashboard, unchanged. |

You can also run the demo from this folder without installing: `turnout.bat` (Windows) or `sh turnout.sh` (macOS, Linux).

```sh
turnout demo status  # what's running, a full check, the links
turnout demo stop    # stop every container (Flagsmith's data and keys are kept)
turnout demo reset   # wipe and start fresh (asks first)
```

## 4. Test your own app

Run these in **your project's folder**. The first version is **A**, what everyone gets now.

```sh
# Two versions already running: an A/B test
turnout compare localhost:3001 localhost:3002

# Docker images: three make an A/B/C test
turnout compare myapp:1.0 myapp:1.1 myapp:1.2 --port 3000

# Git branches, each built from your Dockerfile
turnout compare main new-checkout
```

| Option | What it does |
|---|---|
| `--goal "POST /signup"` | What counts as a win: a request (`GET /pricing*`, `POST /checkout`). Without one, versions are compared on page speed. |
| `--split 10` | 10% of visitors get each new version; the rest get A. Default: an even share. |
| `--port 3000` | The port your images listen on (default: the Dockerfile's `EXPOSE`, else 8080). |
| `--env-file .env.turnout` | Your app's settings for the versions Turnout starts (default `./.env`). |

When it's ready it prints two addresses: **your app through Turnout** (send real visitors there) and **the console**.

```sh
turnout simulate --visitors 500   # pretend visitors, in a separate Flagsmith environment, so results show in minutes
turnout open                      # reopen the console
```

### Or from the console, with no terminal

On the demo console, **Try it with your app** builds one, two or three versions for you. Give each one a project
folder, a Dockerfile, a GitHub link or an image name. When it's ready you land on **your app's console** at
<http://127.0.0.1:8090/app>. Each version also has its own preview address: A at `:8086`, B at `:8087`, C at `:8088`.
Previews are never counted.

## 5. Decide: Flagsmith decides, you confirm

```sh
turnout results      # Flagsmith's results: each metric, each version, chance to win, and Turnout's recommendation
turnout ship         # move everyone to the winner (shows Flagsmith's numbers and asks first)
turnout ship v2      # ...or name the version
turnout revert       # move everyone back to A (asks first)
```

A version that wins the goal but loses a safety check (page speed, server errors) is never shipped by
recommendation. `turnout results` says which one is safe to ship.

## 6. Look after it

```sh
turnout status            # what's running, and a full check
turnout logs              # follow every service's logs
turnout logs proxy        # ...only the proxy (or: console)
turnout down              # stop (data kept); turnout compare with the same arguments starts it again
turnout reset             # wipe this project's Turnout and Flagsmith data (asks first)
turnout update            # get the latest Turnout
turnout deploy example.com  # the Nginx or Caddy lines to put Turnout in front of your site
```

## 7. When something's wrong

| You see | Do this |
|---|---|
| `Docker isn't running` | Start Docker Desktop, wait until it says it's running, run the command again. |
| A version fails to build in Try it | The red card names the version and the reason; the build log shows the full output. Usually the repository has no Dockerfile, or its Dockerfile has an error. |
| Flagsmith says **Not sure yet** | Flagsmith needs at least 50 visitors in each version, and recalculates at most every 5 minutes. Send more visitors, wait, then press **Refresh**. |
| A port is busy | `turnout compare` picks the next free one and prints it. |
| Anything else | `turnout status` runs every check and says what differs from what's expected. |
