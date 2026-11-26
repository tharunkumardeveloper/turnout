# Testing everything Turnout does

Each line is one thing to check, and what you should see. Start with `turnout demo` (or `turnout.bat` / `sh turnout.sh`).

## Automated

| Check | Command | Expected |
|---|---|---|
| Unit and integration tests | `npm test` | every test passes (1 is skipped on purpose) |
| Types | `npm run typecheck` | no output |
| The whole setup | `turnout demo status` (or the **Setup check** page) | every check ✓ |

## The terminal

| Check | Command | Expected |
|---|---|---|
| Install | `sh install.sh` / `powershell -ExecutionPolicy Bypass -File install.ps1` | the logo, ✓ Docker, ✓ Git, "Installed" |
| Help | `turnout help` | logo in colour, sections: Start here, Test your app, Decide, Go live, Look after it |
| Version | `turnout version` | `turnout 1.0.0` |
| Demo | `turnout demo` | the console opens at :8090 |
| Your app | `turnout compare localhost:3001 localhost:3002` (two apps running) | two addresses: your app through Turnout, and the console |
| Simulated visitors | `turnout simulate --visitors 300` | visitors are sent; results show within minutes |
| Results | `turnout results` | each metric per version, chance to win, Turnout's recommendation |
| Ship / Revert | `turnout ship` then `turnout revert` | each shows Flagsmith's numbers and asks before changing anything |
| Logs | `turnout logs proxy` | the proxy's log lines, following |
| Stop, wipe | `turnout down`, `turnout reset` | stopped (data kept); wiped after asking |

## The console (<http://127.0.0.1:8090>)

| Check | Do | Expected |
|---|---|---|
| Menu | look at the bar on Console, Setup check and What we use | the same menu on all three: Console · Setup check · What we use · Versions · Flagsmith ↗ (Flagsmith's logo) |
| Tour | press **Tour** | a guided overlay over the console |
| Judge mode | flip the **Judge mode** switch | the step-by-step view replaces the cards; flip back for the console; reload keeps the choice |
| Judge tour | with Judge mode on, press **Tour** | the judge view's tour |
| Traffic card | press **Previews**, then **Traffic** | Previews: the versions' websites only. Traffic: the flow chart only |
| Run a test | pick A/A, A/B or A/B/C, press its one button | the test starts, simulated shoppers flow on the map, Flagsmith's results arrive |
| Results headline | after a test | names the version to ship, in that version's colour; a version that loses a safety check is never the one to ship |
| Refresh | press **Refresh** on Flagsmith's results | new numbers, or "Flagsmith allows the next refresh in …" (its 5-minute limit) |
| Decide | **Ship** or **Revert**, confirm | everyone moves; the ledger and History show it |
| Be a visitor | **Open your site** | you get one version and count; the card says which |
| Versions menu | **Versions** ▾ | each version opens on its own, never counted |

## Try it with your app (console → **Try it with your app**)

| Check | Do | Expected |
|---|---|---|
| Example | **✨ Use an example**, then **🚀 Build and try** | two Ledgerly pages build; the build log streams; you land on your app's console at /app |
| Detection | paste a Dockerfile, a GitHub link, an image name | "✓ Looks like a Dockerfile / a git repository / a Docker image" |
| Folder | **📁 Project folder**, pick a folder with two Dockerfiles | A and B fill in by themselves, one Dockerfile each |
| A Dockerfile that copies files | paste one with `COPY . .` | a red note: choose its project folder instead |
| A repository without a Dockerfile | paste such a GitHub link and build | a red card names the version and says the repository has no Dockerfile |
| Previews | on your app's console, **Previews** | each version's own site (A :8086, B :8087, C :8088) |
| Your app's console | /app | traffic, Flagsmith's results, Run a test, Decide, for flag `tryit_release`; **← Demo shop** goes back |

## Flagsmith (<http://127.0.0.1:8001>)

| Check | Do | Expected |
|---|---|---|
| Sign in | use the login from the console's **Sign in to Flagsmith** | Flagsmith's dashboard |
| Turnout's tour | press **✦ Turnout tour** (bottom right) | seven stops on Flagsmith's own pages: the release flag, Feature Health, Experiments, the results, Metrics, Identities, Ship and Revert; each highlights the part it talks about |
| Same Flagsmith | open <http://127.0.0.1:8000> | the same dashboard, without the tour |

## The public view (server mode)

| Check | Open | Expected |
|---|---|---|
| Judge page | `https://<host>/judge` | the public console with Judge mode on; blind rounds and their scoreboard; nothing that changes anything |
| Public console | `https://<host>/judge/console` | the console, read-only |
| Private parts stay private | `https://<host>/app`, `/setup` | not found |
