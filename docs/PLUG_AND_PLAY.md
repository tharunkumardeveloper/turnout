# Plug and play: Turnout in front of apps it has never seen

Turnout needs no code in your app: it sits in front as a reverse proxy, picks a release per visitor from a Flagsmith flag, and turns HTTP requests into Flagsmith events. This page records what was tested, how to repeat it, and what doesn't work.

## What was tested

During Toggle Wars (27 Nov 2026 unless noted), each a real run against Flagsmith 2.291.0. How each was run, with every number: [spikes/RESULTS.md](../spikes/RESULTS.md).

| Apps | How | Result |
|---|---|---|
| Two landing pages (nginx, Start Bootstrap's Agency and Creative), on the host at :3001 and :3002 | `turnout compare localhost:3001 localhost:3002` from an empty folder, next to another running Turnout stack | Running in 271 s on the next free ports; 2,000 new visitors split 49.3% at `--split 50` and 20.5% at `--split 20`; one visitor 20 of 20 on the same version; after Ship, 100 of 100 on the winner |
| 12 sample apps: plain HTML, Vite, Next.js static and server, Express, Flask, Django, Go, PHP, no Dockerfile, needs a database, needs a setting | Try it, each built from its folder ([scoreboard](../scoreboard/README.md)) | builds 12/12, starts 12/12, goals found 11/12 (Next.js static has no working link, on purpose), counts match Flagsmith 12/12, ships 12/12 |
| 53 public GitHub repositories, pasted as links (26 Nov) | Try it ([github-run.json](../scoreboard/github-run.json)) | 39 build, start, serve real pages, get Flagsmith results with matching counts, and ship; each failure with its reason |

The automated version is [`test/plug-and-play.test.ts`](../test/plug-and-play.test.ts), part of `npm test` (684 tests, 0 failing): two real local HTTP apps behind the proxy (one under a path), checking the split, stickiness, the redirect and CSRF headers, gzip assets, JSON API calls, app cookies and that the visitor cookie never reaches the app.

## What the proxy handles for an app it has never seen

- **`Host` and TLS:** requests reach the release with its own host name and TLS server name (SNI), verified normally.
- **Compression:** `content-encoding` passes through unchanged.
- **Redirects:** a redirect to the same site (`Location: https://site/get` or `/get`) is rewritten to Turnout's host; for a release under a path (`https://site/docs/`), the release's path is taken off `Location` again. A redirect to another site is left alone: the visitor leaves.
- **CSRF checks:** a same-host `Origin` or `Referer` on a POST is rewritten to the release's origin, so Django-, Rails- or Express-style checks accept the form; a foreign `Origin` passes unchanged.
- **App cookies:** `Domain=` is removed, so the cookie belongs to Turnout's host; `Secure` is removed for visitors on plain http (except `__Secure-` and `__Host-` cookies), since browsers refuse it there off localhost.
- **Security headers:** `Content-Security-Policy` and `Strict-Transport-Security` pass through unchanged (see limits).
- **Several Turnouts on one machine:** `turnout new --proxy-port` and `--console-port` move both ports; `turnout compare` takes the next free ones by itself.
- **Your own Flagsmith:** `doctor` skips the bundled stack's metrics check unless `FLAGSMITH_METRICS_URL` is set.

## Do it yourself

With Flagsmith on the host at `127.0.0.1:8000` and an Organisation API key for a project:

```sh
mkdir try && cd try
turnout new --yes --flagsmith http://host.docker.internal:8000/api/v1/ \
  --project MyProject --environment Production --admin-key <key> \
  --release http://localhost:3001 --release http://localhost:3002 \
  --success "POST /signup 2xx" --proxy-port 18080 --console-port 18090
docker compose -f turnout.compose.yml run --rm cli init
docker compose -f turnout.compose.yml up -d --wait
docker compose -f turnout.compose.yml run --rm cli doctor
```

Open `http://127.0.0.1:18080`. For releases that are containers, either give `--release` an image, or name a service (`--release a=http://site-a`) and add it in a `compose.override.yml` passed with a second `-f`.

## Known limits

- **Who counts.** A visitor counts from their first page load in a browser, so one-page visits (bounces) are in the data. Without the `tn_id` cookie, API calls, assets and cookie-less scripts never become identities.
- **Single-page apps.** Navigation inside an SPA makes no new page loads, so put the goal on an API call (`POST /api/signup`) or the `X-Turnout-Event` header, not a page URL. App d above is an SPA and passed this way. Clients whose user agent looks like a bot (`curl`, `wget`, `python-requests`, headless browsers…) always get the live release and send no events: test with a browser user agent.
- **Absolute links in the page.** Turnout rewrites headers, never bodies. A page that links to `https://its-own-host/…` sends the visitor straight to the app, outside the experiment. Use relative links, or let Turnout serve the app's public host name.
- **Third-party websites** work as a smoke test but are not a use case: a CSP naming the site's own host, assets on the site's CDN, or `<base href>` keep parts of the page on the original site. Your own app, served only through Turnout, has none of these problems.
- **http to https redirects.** A release given as `http://site` that redirects to `https://site` sends the visitor away (the origins differ). Give the https URL.
- **`Strict-Transport-Security`** from a release passes through. Browsers ignore it over http; behind your own TLS, it applies to Turnout's host name, which is what you want for your own app.
- **WebSockets** and other upgrades get 501.
- **The visitor's IP** goes to the release in `X-Forwarded-For`, as with any reverse proxy.
- **Bring-your-own Flagsmith on the host**: the proxy can take a few seconds after start to load the first environment document through `host.docker.internal`; until then it serves the first release and `doctor` says so.
