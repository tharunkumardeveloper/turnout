# How Turnout uses Flagsmith, with sources

Every claim here was checked against Flagsmith's source at the pinned image, `2.291.0`, or against a live run on it. Paths are relative to the `api/` directory of [Flagsmith/flagsmith](https://github.com/Flagsmith/flagsmith) unless they say otherwise.

## Features used

| Flagsmith feature | Role in Turnout | Where to check |
|---|---|---|
| Multivariate flag with keyed variants (`control` is fixed) | The router before, during and after each release; the rollback switch | `experimentation/constants.py:14` |
| Experiment with a required hypothesis; one active per flag and environment; superseded rollouts removed on start | One experiment per release on the same flag; each start clears the last override | `experimentation/models.py:168,192-199`; `experimentation/services.py:619-623,632-681` |
| Experiment rollout (`experiment-<id>-rollout`, a percentage split on identity) | Who is enrolled; what `check` reports; drained to 0% by Ship winner and Revert | `experimentation/services.py:757-775,937-939` |
| Node SDK local evaluation, `getExperimentFlag`, `trackEvent` | Routing with no network call per request; exposures and events | Node SDK `sdk/index.ts:298-343,352-377` |
| Environment document (server key) and experiment metadata, present only while running | `check` tells a leftover split from a running one | `environments/sdk/views.py:26-38`; `experimentation/feature_state_metadata.py:15-33`; `util/mappers/engine.py:213,297,325` |
| Node SDK custom `fetch`, and the events endpoint's per-event answer | Per-visitor receipts | Node SDK `sdk/index.ts:122,198` and `sdk/events.ts:155,461-475`; `experimentation/views.py:823-867` |
| Metrics: aggregation, direction, expected direction | Goal (Occurrence) and guardrails (Mean, lower is better) | `experimentation/results_query.py:116-124`; `experimentation/models.py:291` |
| Post-exposure attribution | Events count only after an identity's first exposure, so Turnout records the exposure before the response's events | `experimentation/results_query.py:101-107` |
| Bayesian results, their floors, and the results page's winner rule | The only scorer; Ship winner's pre-selection, which a person confirms; guardrail warnings | `experimentation/services.py:484-507`; `experimentation/constants.py:22-23`; `frontend/web/components/experiments/results/derive.ts:188-243` |
| Sample-ratio check | Shown as returned; not computed for rollout experiments today (draft fix #8798) | `experimentation/services.py:419-424`; `experimentation/stats.py:97-99` |
| Experiment lifecycle and rollout API; flag environment default (`__future__` API); audit log | Ship winner and Revert, each step in Flagsmith's audit log; the result stays an ordinary editable flag. The default's value is set to the value control served (the rollout's), so control after the decision is control during it | `experimentation/services.py:518-602,605-630,1028-1035`; `features/future/serializers.py:50-58`; `features/future/services.py:171-188` |
| Segments, traits and segment-override priority | The preview stage: your team sees the new release first and stays out of the experiment | `features/feature_segments/services.py:69-75` |
| Identities and identity overrides | **Pin my browser**: the console creates an identity for the browser's visitor id and an override on the release flag; Flagsmith serves it before segment overrides, so before the experiment's split, and the browser is outside the test (no experiment on its flag, so no exposure). Verified live on 2.291.0: the proxy routed a pinned identity to the override within its 5-second refresh, with `enrolled=false` | `POST/GET/DELETE /api/v1/environments/<key>/identities/<id>/featurestates/`; docs `deployment-self-hosting` ("identity overrides are embedded in the environment document") |
| Environment setting "Use identity overrides in local evaluation" | Local evaluation sees identity overrides only with it on (the default for new environments); `init` turns it on where it is off | `use_identity_overrides_in_local_eval` on `GET/PATCH /api/v1/environments/<key>/`; docs `sdks` ("Environment Settings > SDK Settings") |
| Variant values (remote config) | Each variant's value names the image it serves (`shop:1.6`) | `features/multivariate/models.py` |
| Feature Health, generic Webhook provider (open source) | A losing guardrail tags the release flag "Unhealthy" in Flagsmith's dashboard with Flagsmith's numbers as the reason; a healthy report clears it. Verified live on 2.291.0 | `features/feature_health/providers/webhook/types.py`; `features/feature_health/constants.py` (`UNHEALTHY_TAG_LABEL`); `api/urls/v1.py:60-62` |
| Tags (permanent) | `init` tags the flag `release`, which keeps it out of stale-flag detection | `projects/tags/models.py:27-30` |
| Flag Analytics | Routed requests counted on the flag's Usage tab | Node SDK `sdk/index.ts:91,181` |
| Prometheus metrics | Flagsmith's own accepted/rejected event counter in the console | `experimentation/metrics.py:12-13` |
| Code References | `init`, `turnout code-refs` and the GitHub Action submit where the flag's name appears in the repository: only `turnout.config.yml`, never the app. Flagsmith stores the repository URL and builds GitHub permalinks from it; it never fetches it | `projects/code_references/views.py:32-71`, `serializers.py:30-41`, `services.py:117-196` |
| Lifecycle | The flag sits under Permanent: a permanent tag decides the stage before code references do | `features/feature_lifecycle/services.py:42-80` |
| Sign-up API (the first user may be a superuser) | `init` bootstraps a fresh instance | `docs/getting-started/run-locally-with-a-coding-agent.mdx:50` |
| Official self-hosted Docker Compose | Turnout is an overlay on it | `docker-compose.yml` |

The console's `/flagsmith` page (`GET /api/flagsmith-map`) lists every dashboard menu and integration with what Turnout does with it, a live value from the Admin API and, for anything not available on this laptop demo, the source behind that. In short:

- **Audit Log.** Flagsmith records Turnout's writes (124 rows for the demo project on my instance), but a free organisation's visibility window is 0 days, so the API and the page show none (`organisations/models.py:424-429`, `organisations/subscriptions/metadata.py:15`, `audit/views.py:84-91`). Turnout's ledger is the record here.
- **Segment Change Requests** come with the Enterprise image's workflows module; this image doesn't register the API (`app/settings/common.py:1116-1119`, `projects/urls.py:105-111`).
- **Outbound integrations** (Webhook, Grafana, Datadog, New Relic, Dynatrace, Sentry, GitLab and the analytics destinations) refuse URLs that resolve to loopback or private addresses (`core/fields.py:24-28`, `core/validators.py:22-31`, `core/network.py:8-34`), so they need a public endpoint or a vendor account. Slack and GitHub need the operator's own app credentials (`app/settings/common.py:1089-1093`).

## The results page's winner, as Turnout reads it

Ship winner, `status`, the console and guided demo pre-select the variation Flagsmith's results page shows as winning. Turnout follows the page's own rule (`frontend/web/components/experiments/results/derive.ts:188-243`, recovered from the source map shipped in the `2.291.0` image):

- Only the primary metric counts: the experiment's first metric (`frontend/web/components/experiments/constants.ts:71-73`).
- The best treatment is the one with the highest chance to win. A treatment with no inference yet is skipped (`derive.ts:203-223`).
- Control's chance to be best is 1 minus the treatments' total, and only once every treatment has inference (`derive.ts:183-201`). Control wins when that chance is known and higher than the best treatment's (`derive.ts:225-243`). With one treatment, control wins exactly when the treatment's chance to win is below 50%.
- A variation created without a key is named `Variant_<n>`, counting from 1 (`derive.ts:47,58`). Turnout uses the same name for it.

A person confirms the pre-selection, or picks another variation with `--winner`.

## Ending an experiment: what the docs say and what the pinned image does

The docs' analysis page says to end the experiment, then update the flag (`docs/docs/experimentation/analyse-an-experiment.md:58-61`). On `2.291.0` an experiment's split is a system segment override, `experiment-<id>-rollout`, a percentage split on the identity key (`experimentation/services.py:757-775,937-939`). Completing an experiment sets `ended_at` (`services.py:624-625`); the override is removed when the flag's next experiment starts (`services.py:619-623,632-681`, from merged PR #8770), and saves through the flag API don't overwrite it (`features/future/views.py:117`). Flagsmith's own flag editor saves through the v1 feature-state endpoint instead; spike 9 made a swing-back there and routing followed (`spikes/RESULTS.md`, "Spike 9 through Flagsmith's own flag editor").

Measured on the pinned image with 300 fresh identities through a local-evaluation SDK on 27 Nov 2026 (`spikes/07-round04.ts`, log in `spikes/RESULTS.md`):

| | What the 300 identities get |
|---|---|
| Experiment A running | control 150, v2 150 |
| A after Complete, then setting the flag's default to v2 (the documented order) | control 150, v2 150 |
| Experiment B running | control 144, v2 156 |
| B after Ship winner (pause → default = v2 → rollout 0% with v2 weights → complete) | v2 300 |
| B after one environment-default edit back to control | control 300 |

So on 2.291.0, until the next experiment starts, the documented edit doesn't reach the identities the rollout covers, and Ship winner drains the rollout first. Reported as [Flagsmith#9120](https://github.com/Flagsmith/flagsmith/issues/9120). Flagsmith 2.295.0 (23 Nov) had already added a choice of rollout to Complete, which removes the experiment's rollout ([#9018](https://github.com/Flagsmith/flagsmith/pull/9018), [#9021](https://github.com/Flagsmith/flagsmith/pull/9021); on for everyone from 2.295.2), and after the report Flagsmith rewrote its "Ending the experiment" docs ([#9141](https://github.com/Flagsmith/flagsmith/pull/9141)). On 2.295.2 and later, Ship winner's drain step isn't needed.

## Things we found on the pinned image

- **The Node SDK sends events to Flagsmith Cloud unless told otherwise.** With `apiUrl` pointing at a self-hosted instance, `@flagsmith/nodejs` 9.4.0 still posts events to `https://events.api.flagsmith.com/v1/events` (its default `eventsUrl`) unless `eventProcessorConfig.eventsApiUrl` is set; the self-hosted instance receives nothing and nothing says so. Turnout sets it from `FLAGSMITH_API_URL` (`src/flagsmith/flag-source.ts`); found while writing [examples/with-sdk](../examples/with-sdk/README.md); reproduction in [spikes/sdk-events-url](../spikes/sdk-events-url/repro.mjs), reported upstream as [flagsmith-nodejs-client#332](https://github.com/Flagsmith/flagsmith-nodejs-client/issues/332).
- **Local evaluation records exposures.** The docs say experiments need remote evaluation; Node SDK 9.4.0 records exposures under local evaluation: every load run on 27 Nov stored `$flag_exposure` rows from the proxy's local evaluation (`spikes/RESULTS.md`). Turnout relies on it.
- **A partial `PATCH` of a multivariate option answers 500** (`KeyError: 'feature'`, then `'default_percentage_allocation'`, `features/multivariate/serializers.py:85-86`). Turnout uses a full `PUT`.
- **The sample-ratio check is empty for rollout experiments** (`srm_p_value: null`: "sample-ratio check: not computed" on every decision the live demo recorded on 27 Nov, about 1,200 identities each); the first rollout zeroes the environment default's weights (`services.py:1000-1025`), so there is no expected share. Draft fix: #8798.
- **A Mean 0/1 guardrail with no errors at all has no inference**: control's mean is 0 (`experimentation/stats.py:60-61`). Turnout says "no errors in either release" instead of "collecting data".
- **A Mean metric is averaged over every exposed identity.** Each identity's value is the average of its own events after its first exposure, or 0 when it sent none (`experimentation/results_query.py:101-108,123-124`; `experimentation/warehouses/dialect.py:39-41`, with the same rule in each warehouse's `avg_if` at `:96-97,157-158,229-230`). `n` counts every non-quarantined exposed identity (`results_query.py:184-196`), and the arm's mean is `sum / n` (`stats.py:35-36`). So when some identities send no events for a metric, its mean is lower than the average over the events. Spike 4's 200 SDK-only identities sent no latency events, and control's mean latency read 0.3 ms (`spikes/RESULTS.md`). Through the proxy every visitor sends latency, so Turnout's guardrails compare like with like; its results lines and health reports label these figures as means per exposed identity.
- **Environment webhooks can't point at a private address**, by design: `core/network.py:8-34` rejects loopback and private ranges (`webhooks/fields.py:20`, `core/fields.py:27`). Turnout's console lives on the Compose network, so it doesn't use the webhook; it reads the flag's state when it loads instead.
- **The dashboard can't be framed.** Django's `XFrameOptionsMiddleware` is installed (`app/settings/common.py:413`) and the settings don't set `X_FRAME_OPTIONS`, so Django's default applies (`X_FRAME_OPTIONS = "DENY"`, `django/conf/global_settings.py:447` in the image); the dashboard answers `X-Frame-Options: DENY`. Guided demo opens Flagsmith's dashboard in a separate tab.
- **Results refresh at most every 5 minutes**: `RESULTS_REFRESH_MIN_INTERVAL = timedelta(minutes=5)` (`experimentation/constants.py:12`), checked when a refresh is requested (`experimentation/views.py:591`). The guard and guided demo wait for it.
- **An audience has at most one segment on this image**: `MAX_AUDIENCE_SEGMENTS = 1` (`experimentation/constants.py:18`), enforced by the serializer (`experimentation/serializers.py:271`) and the service (`experimentation/services.py:891-893`). `check` and `doctor` also read the wrapper rule's ANY/ALL and more than one segment, should a later version allow it.
- **A condition on a trait the identity doesn't have fails, except `IS_NOT_SET`**, which it matches (`flag_engine/segments/evaluator.py:518-519,524-528` in the image's `flag_engine` package). The proxy sends only the `preview` trait, so `doctor` warns about audience conditions on other traits and says when an `IS_NOT_SET` one matches every visitor.
- **The API closes idle keep-alive connections after 2 s by default** (`GUNICORN_KEEP_ALIVE`, `common/gunicorn/utils.py:26` in the image's `common` package); Node's `fetch` keeps them for 4 s. Turnout's Compose file sets it to 5 (a marked edit), and its admin client sends a read once more if the socket was closed under it.
- **Segment-override priorities are unique**, and a finished experiment's drained override keeps priority 0 until the next start. `preview` takes the next free priority.
- **`GET …/experiments/` returns `feature` as a nested object**, not an id.
