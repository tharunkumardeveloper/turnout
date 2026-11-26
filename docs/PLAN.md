# Plan: Turnout works on any website, automatically

One rule for everything below: Turnout learns from the **running app and its traffic**, never from the app's code, and
nothing is tuned for one site. Each change is measured on a fixed set of small public sample repos (step 1), and it
only counts if it works on all of them.

## Where things stand

- Local stack: `turnout.bat` (Windows) or `sh turnout.sh` starts everything, Try it included. Console :8090, demo shop
  :8080, Flagsmith :8000, Flagsmith with Turnout's tour :8001, Try it's proxy :8085, previews A/B/C :8086-8088.
- One console page with a **Judge mode** switch. A Try it build lands on **your app's console** at `/app`.
- VM (public, read-only): `https://172-198-62-67.sslip.io/judge`. Deploy:
  `ssh -i ~/Downloads/switchyard-key.pem azureuser@172.198.62.67 'cd ~/turnout-practice && git pull -q && docker compose -f compose.yaml -f compose.server.yml up -d --build --wait turnout turnout-live console'`
- Tests: `npm test` (634, 1 skipped on purpose), `npm run typecheck`. CI runs both on every push.
- The repo and the image are private. Try it never runs on the VM (it builds and runs code over the Docker socket).
- Scoreboard (`npm run scoreboard`, one clean run of all 12, 25 Nov): builds 12/12, starts 12/12, goals 11/12,
  visitors 12/12, results 12/12, counts match 12/12, ships 12/12. Next.js static has no goal on purpose: its only link
  answers 404 on nginx, so none is offered and it's compared on page speed.
- Done: a Dockerfile written for a project without one (instead of Buildpacks); A and B built side by side, the same
  source once; crash-on-start found in seconds; the "needs settings / database" card with a throwaway Postgres or
  MySQL; goals read off the running versions (only actions every version has, only links that answer); link goals
  (`GET /pricing*`) counted; every request through the proxy kept as a pattern; the goal changed mid-test (a new
  experiment, "counting from"); steady simulated visitors with Flagsmith's results fetched every 5 minutes; visitors
  needed; the split check; the one-sentence verdict, the Markdown report, history and the step after Ship.
  Terminal: `turnout try | goals | goal | steady | results [--full] [--report] | history`.
- Still to do: the optional click script (browser actions), the settings check against Flagsmith, pretend rates per
  action, a separate Flagsmith environment for simulated visitors, the console's results card and full panel
  (the terminal has both), and the console's buttons for goal change and steady visitors (the API has them).
- Not yet checked on screen: the console layout after the latest changes, the Try it wizard, and the tour inside Flagsmith.

## 1. A test set and a scoreboard (first)

About 12 small public repos, one of each kind:

- plain HTML
- a Vite single-page app
- Next.js static
- Next.js with a server
- Express
- Flask
- Django
- Go
- PHP
- one with no Dockerfile
- one that needs a database
- one that needs settings

One automated run per repo: build → start → discover actions → suggest goals → simulated visitors → Flagsmith results
→ Ship. It records pass or fail per stage. Each run also checks that the visitors counted per version in Turnout match
Flagsmith's numbers.

**Done when:** one command prints the scoreboard ("builds 12/12, goals found 9/12…").

## 2. Any repo runs

| Gap | Fix |
|---|---|
| No Dockerfile | Build with Cloud Native Buildpacks (Node, Python, Go, PHP, Ruby, Java); serve a plain `index.html` directly; the repo's own Dockerfile always wins |
| Unknown port | Already read from the log and tried on common ports; add a check of which port is open inside the container |
| Needs settings | A "needs settings" card listing the names the error mentions (`DATABASE_URL`…) |
| Needs a database | One click: a throwaway Postgres or MySQL for the test, its address filled in |
| Slow builds | Cached dependencies, A and B built in parallel, time left shown |

## 3. Turnout learns the site by watching it

- **Server actions:** every request through the proxy becomes a pattern (`GET /product/*`, `POST /api/contact`), with
  its status and the version that served it.
- **Browser actions:** an optional small script, added by the proxy to every page, records clicks on buttons and links
  and form submits by their visible label ("Sign up", "Download CV", an email link). It never records what people type.
- **Before any visitor:** right after the build, each version is walked once, uncounted.

## 4. Picking a goal is a choice from a list

- "What should count as a win?" lists the actions found, in plain words.
- They're ranked by how much each looks like a conversion: form sends, sign-up or buy verbs, downloads and contact
  links first.
- Only actions every version has are offered.
- One goal plus optional secondary metrics.
- Safety checks are automatic: page speed, server errors, browser errors, one-page visits.
- The goal can change mid-test, labelled "counting from <time>".
- When nothing is countable: compare on page speed, and say why.

## 5. Simulated visitors that behave like visitors

- They take the discovered actions, not only links.
- Pretend rates are set per action and version, and always labelled.
- They keep running at a low, adjustable rate.
- They stay in their own Flagsmith environment.

## 6. A test you can trust, checked by Turnout

- **Visitors needed:** before starting, the visitors needed per version (and Flagsmith's minimum of 50 visitors and 5
  conversions).
- **Split check:** visitors counted per version vs the split that was set.
- **Settings check:** the proxy's copy of Flagsmith's settings vs Flagsmith's current settings.
- **Optional A/A first**, with one click.
- **Automatic results:** Turnout asks Flagsmith for results when there's enough new data (its 5-minute limit,
  counted down).
- **"Not sure yet" in plain words:** "B has 31 of 50 visitors".

## 7. Results that hide nothing

- **The card:** the verdict, the goal row and any losing safety check. It never scrolls.
- **Everything else:** a full panel with every metric, exactly as Flagsmith returns it.
- **The verdict:** one sentence ("B gets 18% more sign-ups, 97% sure, no slowdown: ship B").
- **Every decision:** saved with Flagsmith's numbers, and exportable as a Markdown report.

## 8. After the decision, and the terminal

- **After Ship:** the next step, "make B the default deploy", with the command.
- **History:** every test, with its winner and report.
- **Terminal commands:**
  - `turnout try <repo|folder|image> …`
  - `turnout goals` and `turnout goal "<action>"`
  - `turnout results` (the one-sentence verdict; `--full` for every number)
  - Every error ends with a next step.

## Order

1. The test set and the scoreboard.
2. Any repo runs.
3. Learning the site and picking a goal.
4. The trust checks and results.
5. Simulated visitors, after the decision, and the terminal.
