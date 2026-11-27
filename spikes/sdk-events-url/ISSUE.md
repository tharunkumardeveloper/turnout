# Draft issue for Flagsmith/flagsmith-nodejs-client (not posted yet)

**Title:** Self-hosted: experiment events go to Flagsmith Cloud unless `eventsApiUrl` is set

**Body:**

With `apiUrl` pointing at a self-hosted Flagsmith and `enableEvents: true`, `trackEvent` and the exposures that `getExperimentFlag` records are sent to Flagsmith Cloud (`https://events.api.flagsmith.com/v1/events`), not to the self-hosted instance. Nothing warns: the self-hosted instance never sees the events, its experiments show no data, and each event (the identity's identifier, the event name, any value) plus the environment key leaves the network.

**Where:** `EventProcessor` takes `opts.eventsApiUrl || DEFAULT_EVENTS_API_URL` (`sdk/events.ts`; `DEFAULT_EVENTS_API_URL = 'https://events.api.flagsmith.com/'`), and the `Flagsmith` constructor passes only `eventProcessorConfig` through, so the default is used whatever `apiUrl` is. The analytics URL, by contrast, is derived from `apiUrl` (`new URL(ANALYTICS_ENDPOINT, apiUrl)`), so a self-hosted setup gets analytics right and events wrong.

**Reproduction** (no network: a custom `fetch` records the destinations): https://github.com/tharunkumardeveloper/turnout/blob/main/spikes/sdk-events-url/repro.mjs

```
apiUrl (self-hosted): http://127.0.0.1:55651/api/v1/
  GET http://127.0.0.1:55651/api/v1/environment-document/
  POST https://events.api.flagsmith.com/v1/events
```

Same result on 9.4.0 and 9.5.0. Found by accident while writing an example against a self-hosted 2.291.0: its experiment stayed empty while the events went to Cloud.

**Suggested fix**, either:

1. When `apiUrl` is set and isn't Flagsmith's own edge API, derive the events URL from it, as analytics already is: `apiUrl` without its trailing `v1/` as `eventsApiUrl`, so events go to `{host}/api/v1/events` on the same instance (what Turnout passes today, and it works against 2.291.0); or
2. at least log a warning at construction when `enableEvents` is true, `apiUrl` is not the default, and `eventsApiUrl` isn't set.

Option 1 matches how the analytics URL already works. Happy to open a PR for either.
