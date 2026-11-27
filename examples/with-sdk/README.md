# The same experiment with Flagsmith's SDK in the app

[`server.ts`](server.ts) runs the demo shop's experiment the usual way: Flagsmith's Node SDK inside the app. Same flag (`shop_release`), same exposures, same events (`order_placed`, `add_to_cart`, `doc_latency_ms`, `server_error`). It is here to measure what Turnout saves, and it was run against a self-hosted Flagsmith 2.291.0: 30 visitors split 13 / 12 / 5 across the three versions, none switched version on a second page, and Flagsmith stored 30 exposures, 30 add-to-carts, 10 orders and 60 page-speed and 60 server-error events.

| | With the SDK (`server.ts`) | With Turnout |
|---|---|---|
| Code in the app | **45 lines** in a new file, 7 Flagsmith calls | **0 lines**: no file in `demo/shop` mentions Flagsmith |
| Configuration | the flag name, event names and rules are in that code | 12 lines of [`turnout.config.yml`](../../turnout.config.yml) |
| How the versions run | all three in one process, because the app must pick its release per visitor | each version is its own container or URL, as it ships |

**Two traps hit while writing it**, both silent:

1. **Events go to Flagsmith Cloud by default.** With `apiUrl` pointing at a self-hosted Flagsmith, the SDK still posts events to `https://events.api.flagsmith.com/v1/events` unless `eventProcessorConfig.eventsApiUrl` is set: nothing reached the self-hosted instance, and nothing said so.
2. **Visitors before the environment document arrives get the flag's default.** Under local evaluation, every early visitor was served control until the first document loaded; `await flagsmith.getEnvironmentFlags()` at start fixes it.

**What it still doesn't do** that Turnout does: leave bots out of the data; serve the live release when Flagsmith is slow or down instead of waiting on it; hold events back while the SDK's buffer is full (the SDK alone loses about 28% at 300 events/s with a 5 s round-trip, [spikes/RESULTS.md](../../spikes/RESULTS.md)); ship or revert by draining the experiment's split; preview a version to your team; measure page speed in real browsers (`lcp_ms`, `cls`).

Run it (with `turnout demo` running, from the repository's root):

```sh
FLAGSMITH_SERVER_KEY=ser.… FLAGSMITH_API_URL=http://127.0.0.1:8000/api/v1/ node examples/with-sdk/server.ts
```
