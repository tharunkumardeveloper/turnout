# Does Gitea 28.0.0 load the repo page faster than 1.27.3? Flagsmith's verdict

Gitea 28.0.0's release notes list a front-end performance change, [go-gitea/gitea#39332](https://github.com/go-gitea/gitea/pull/39332), "perf(frontend): enable vite module preload". Its pull request measured, with 50 ms latency per request, the median time until the page's lazy-loaded content had rendered; for the repo home page in Chromium, **962 → 826 ms**.

Turnout put the two releases side by side, sent real Chrome visits through them, and let Flagsmith Experimentation decide. Measured on 27 Nov 2026.

## Result

940 visits to the same repository's home page (469 on 28.0.0, 471 on 1.27.3), 50 ms of added latency per request, the same as the pull request:

| Measured | Gitea 1.27.3 | Gitea 28.0.0 | Flagsmith's verdict |
|---|---|---|---|
| **Server response** (time to Gitea's response headers, measured by Turnout's proxy) | 51.3 ms | 44.3 ms | **13.8% faster** (interval −21% to −6%), 100% chance to be better |
| **Largest contentful paint** (when the page's main content appeared, measured in Chrome) | 671.5 ms | 708.6 ms | **Not faster**: +5.5% (interval −3% to +14%), 10% chance to be better. The interval crosses zero: no clear difference either way |
| Layout shift (in Chrome) | 0.0 | 0.0 | no difference |
| Visits whose browser reported page speed | 100% | 100% | both reported every visit, so the comparison is fair |

**What it says:** 28.0.0's server answers the repo page clearly faster. The page's main content doesn't appear sooner: if anything slightly later, within the noise of 940 visits.

**What it doesn't contradict:** the pull request measured when the lazy-loaded parts (loaded by JavaScript after the page) finish rendering, which is what module preload speeds up. Largest contentful paint is the main content, which on a repo home page is server-rendered and arrives before those parts. The two measure different things, so this is not evidence against the pull request's numbers; it says that, for this page, the change visitors would notice first didn't move.

## Method

- **Versions:** the official images `gitea/gitea:1.27.3` (the last release before the change) and `gitea/gitea:28.0.0` (the first with it), each with its own SQLite database, set up the same way: install locked, one admin user, one public repository created through Gitea's API with the default README (`auto_init`). Both releases answered on this machine, 1.27.3 on :3101 and 28.0.0 on :3102.
- **Turnout:** `turnout compare localhost:3101 localhost:3102 --browser-speed` (setup check 29 ok), then `turnout browsers --visits 240 --path /demo/demo --latency 50` and `--visits 700` again: each visit a fresh headless-Chrome profile (`chromedp/headless-shell`), so Flagsmith assigned each one a version, loading the repo home page, waiting a second, then leaving it, which is when Turnout's page-speed script reports.
- **Labelled automated:** every visit's user agent ends with `TurnoutBrowserVisit/1.0`, and the visits went to a separate Flagsmith environment (Demo, simulated), never to a real experiment.
- **Scoring:** Flagsmith Experimentation's own results (Bayesian, means per exposed visitor), read with `turnout status` after a refresh at 07:21:54 UTC. Turnout computes no statistics.
- **Machine:** Windows 11, Docker Desktop 29.9.3, both Gitea containers and Chrome on the same machine; the 50 ms latency is Chrome's network emulation on every request.

## Limits

- **Two whole releases, not one pull request.** Many other changes landed between 1.27.3 and 28.0.0 (the main JavaScript bundle alone went from 661 KB to 552 KB).
- **One page, nearly empty:** a repository with only a README. A page with more content, or one whose main content is rendered by JavaScript, could behave differently.
- **One machine, automated visits, emulated latency:** no real network, real devices or real users.
- **940 visits:** enough for a clear server-response result; the largest-paint difference is smaller than this sample can settle. Turnout's estimate to settle a difference of that size, if it holds: roughly 2.4× the visitors, about 1,150 per version.

Raw numbers and the run's log: [spikes/RESULTS.md](../spikes/RESULTS.md).
