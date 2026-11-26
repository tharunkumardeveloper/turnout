# Scoreboard

Twelve small sample apps, one of each kind, each run through Try it end to end. A change to Turnout counts only if it
holds up on all of them.

```sh
npm run scoreboard                    # every app; Turnout must be running (turnout.bat or sh turnout.sh)
npm run scoreboard -- flask express   # only these
```

Each app goes through the same steps as the console page, with A and B both built from the app's folder:

| Stage | Passes when |
|---|---|
| build | both versions build |
| start | both answer over HTTP, and the A/B test starts in Flagsmith |
| goals | Try it finds at least one action on the running versions (it uses the best) |
| visitors | 300 simulated visitors reach the app (pretend rates: A 10%, B 20%) |
| results | Flagsmith returns results |
| counts | the visitors Turnout sent per version match the visitors Flagsmith counted on the goal |
| ship | Ship completes |

It ends with one line, e.g. `builds 11/12, starts 9/12, goals found 4/12…`, and writes every stage's notes to
`scoreboard/last-run.json`. A run of only some apps (`npm run scoreboard -- flask`) replaces just their rows there;
the other apps' results stay, each row with the time it ran.

## The apps

`apps/` holds plain HTML, a Vite single-page app, Next.js static, Next.js with a server, Express, Flask, Django (no
`EXPOSE`, port 8000), Go, PHP, a Node app with no Dockerfile, one that needs a database (`DATABASE_URL`) and one that
needs a setting (`SECRET_KEY`). For the last two the scoreboard presses what the console offers (a throwaway
database, the named setting with a test value) and says so in the start stage. Next.js static's only link answers 404
on nginx, so no goal is offered: that stage fails on purpose.

The goal is the one Try it picks from the running app; the scoreboard never gives one.
