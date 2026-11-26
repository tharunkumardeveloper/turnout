# Spikes: verify Flagsmith before building on it

Small throwaway scripts, run against the pinned Flagsmith (`docker compose up -d`), that each answer one question the design depends on. Record each answer, with its output, in `RESULTS.md`. If an answer is "no", change the design, not the facts.

| # | Question | Design depends on it for | Source said |
|---|---|---|---|
| 1 | Does `POST /api/v1/auth/users/` with `superuser: true` create the first admin on a fresh instance, and return a usable token? | `init` with no manual sign-up | docs `run-locally-with-a-coding-agent.mdx:50` |
| 2 | Can that token create the organisation, project, environment, an Organisation API key and read the server key? | `init` | — |
| 3 | Does `{"warehouse_type":"postgres","config":{"source":"flagsmith_database"}}` connect the event store, and do events return 404 before it? | `init`, receipts | docs; `views.py:846-850` |
| 4 | With `@flagsmith/nodejs` 9.4 in local evaluation, does the environment document contain the experiment's rollout segment, and does `getExperimentFlag` record an exposure? Which `variant` does a visitor outside the rollout get? | Routing and exposures. The docs say experiments need remote evaluation; the SDK changelog says local exposures shipped in 9.3.0 | conflicting |
| 5 | Are events accepted (`202`, nothing in `rejected`), and does Flagsmith's `flagsmith_experimentation_sdk_events_total` count them on `:9100/metrics`? | Receipts, console | `metrics.py:12` |
| 6 | After 50 identities and 5 conversions per variant and a refresh, do results show a leader? | Demo | `constants.py:22-23` |
| 7 | After Complete, does editing the environment default leave enrolled identities on the split? | The Round 04 problem | source reading only |
| 8 | Does the drain (pause → environment default → rollout 0% → complete) move every test identity to the winner, with the flag still enabled? | Ship winner | source reading only |
| 9 | After the drain, does an edit in Flagsmith's own flag editor swing everyone back (or return 409)? | The swing-back moment | unknown |
| 10 | Is the sample-ratio result `null` for an experiment with a rollout? | Upstream repro on #8798 | `services.py:419-469` |
| 11 | Does a `preview = true` segment override beat the experiment rollout, with no exposure for those identities? | Preview stage | `feature_segments/services.py:69-75` |
| 12 | Does an environment webhook fire `FLAG_UPDATED` with `changed_by` and the old and new state on a flag edit? | Ledger | `features/tasks.py:24` |
