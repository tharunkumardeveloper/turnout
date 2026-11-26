# Plug and play: Turnout in front of apps it has never seen

Turnout needs no code in your app: it sits in front as a reverse proxy, picks a release per visitor from a Flagsmith flag, and turns HTTP requests into Flagsmith events. This page records what was tested, what happened, how to repeat it, and what doesn't work.

## What was tested (23 Nov 2026)

Each row is a separate Compose project written by `turnout new`, pointed at its own Flagsmith project in a throwaway organisation (`init --project`), on its own ports (`--proxy-port`, `--console-port`), next to the running demo stack. Each run sent 20 to 40 visitors with a browser user agent: two page loads (cookie, then exposure), three more pages, then the goal request.

| # | App | Releases | Goal | Both served | Sticky | Goal events in Flagsmith | `check` / `doctor` |
|---|---|---|---|---|---|---|---|
| a | Two static sites (`nginx:alpine`, different `index.html`), services in the same Compose project | `a=http://site-a`, `b=http://site-b` | `GET /index.html 2xx` | 19 / 21 | 0 switches | `viewed_index` n=21 / n=19 | pass / 0 failing |
| b | Python `http.server` on the host, ports 3021 and 3022 | `http://localhost:3021`, `http://localhost:3022` (rewritten to `host.docker.internal`) | `GET /about.html 2xx` | 13 / 17 | 0 switches | `about` n=17 / n=13 | pass / 0 failing |
| c | Public HTTPS websites | `https://example.com`, `https://httpbin.org/anything/v2` (a release under a path) | `GET / 2xx` | 10 / 10 | 0 switches | `index` n=18 / n=12 | pass / 0 failing |
| d | Node SPA on the host: client-side routes, a JSON API, a POST form that checks `Origin` (as CSRF middleware does) and answers 303 | `spa-a=http://localhost:3031`, `spa-b=http://localhost:3032` | `POST /signup 303` | 9 / 21 | 0 switches; page, `/api/plan` and `/app.js` always from the same release | `signup` n=24 / n=13 | pass / 0 failing |

"n" is Flagsmith's count of exposed identities per arm after `status --refresh`, so the events arrived and were joined to the exposures. The proxy reported 0 undelivered events in every run.

Also checked by hand against public HTTPS sites (`httpbin.org`, `github.com`, `nodejs.org`), with the proxy run from source:

| Concern | Result |
|---|---|
| `Host` and TLS server name (SNI) | The release's own host name (httpbin echoed `Host: httpbin.org`); TLS verified normally |
| Compression | `content-encoding: gzip` passed through unchanged, body intact |
| Redirect to the same site (`Location: https://httpbin.org/get` or `/get`) | Rewritten to `/get` on Turnout's host |
| Redirect to another site | Left alone: the visitor leaves |
| `Set-Cookie` with `Domain=` | `Domain` removed, so it becomes a cookie for Turnout's host |
| `Set-Cookie` with `Secure`, visitor on plain http | github.com's session cookies arrived with `Secure`, which browsers refuse over http off localhost. Fixed: `Secure` is now removed for http visitors (except `__Secure-` / `__Host-` cookies); covered by the unit test |
| `Origin` / `Referer` on a POST | Rewritten to the release's origin when they name Turnout's host; a foreign `Origin` passes unchanged |
| `Content-Security-Policy`, `Strict-Transport-Security` | Passed through unchanged (see limits) |

## Fixed while testing

- **Releases under a path**: a same-site redirect from `https://site/docs/` came back as `/docs/x`, which the proxy then turned into `/docs/docs/x`. The release's path is now taken off `Location` again.
- **CSRF checks**: the app got `Origin: http://127.0.0.1:8080` with `Host: app`, so Django-, Rails- or Express-style checks refused every form post. Same-host `Origin` and `Referer` are now rewritten to the release's origin.
- **App cookies**: `Domain=<app's host>` cookies were refused by browsers on Turnout's host; `Secure` cookies from an https release were refused for http visitors off localhost. Both are adjusted (above).
- **`turnout new --console-port`**: the generated compose file always published the console on 8090, so a second Turnout on the same machine couldn't start. The new flag moves it, like `--proxy-port`.
- **`doctor` with your own Flagsmith** warned that it couldn't read `http://flagsmith:9100/metrics`, a host that only exists in the bundled stack. It now skips that check unless `FLAGSMITH_METRICS_URL` is set.

The automated version is [`test/plug-and-play.test.ts`](../test/plug-and-play.test.ts): two real local HTTP apps behind the proxy (one under a path), checking the split, stickiness, the redirect and CSRF headers, gzip assets, JSON API calls, app cookies and that the visitor cookie never reaches the app.

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

- **Who counts.** A visitor counts from their second request (the first one sets the cookie), so a single-page visit never becomes an experiment identity. Clients whose user agent looks like a bot (`curl`, `wget`, `python-requests`, headless browsers…) always get the live release and send no events: test with a browser user agent.
- **Absolute links in the page.** Turnout rewrites headers, never bodies. A page that links to `https://its-own-host/…` sends the visitor straight to the app, outside the experiment. Use relative links, or let Turnout serve the app's public host name.
- **Third-party websites** work as a smoke test but are not a use case: a CSP naming the site's own host, assets on the site's CDN, or `<base href>` keep parts of the page on the original site. Your own app, served only through Turnout, has none of these problems.
- **http to https redirects.** A release given as `http://site` that redirects to `https://site` sends the visitor away (the origins differ). Give the https URL.
- **`Strict-Transport-Security`** from a release passes through. Browsers ignore it over http; behind your own TLS, it applies to Turnout's host name, which is what you want for your own app.
- **WebSockets** and other upgrades get 501.
- **The visitor's IP** goes to the release in `X-Forwarded-For`, as with any reverse proxy.
- **Bring-your-own Flagsmith on the host**: the proxy can take a few seconds after start to load the first environment document through `host.docker.internal`; until then it serves the first release and `doctor` says so.
