# Draft issue for Flagsmith/flagsmith-nodejs-client (not posted)

**Title:** Experimentation events are dropped when they're tracked faster than one batch round-trip, and the buffer can't be raised past Flagsmith's 2 MiB batch limit

---

### Summary

With `enableEvents: true`, `@flagsmith/nodejs` 9.4.0 sends its whole event buffer as one batch and keeps one batch in flight at a time. While that batch is in flight, a full buffer drops its oldest event for each new one. This is documented (`build/cjs/sdk/events.js:41-44`) and each drop is logged as a warning, but:

1. **The app gets no programmatic signal.** Nothing is returned, emitted or counted, so code that records "events sent" sees no loss unless it parses log messages.
2. **Raising `maxBuffer` doesn't fix it, and can make it worse.** Batches are never split, and Flagsmith rejects a request body over 2 MiB (`api/experimentation/constants.py`, `MAX_BODY_BYTES = 2_097_152` in 2.291.0) with a 413. The SDK then drops the whole batch. A buffer over roughly 7,000–11,000 events (depending on event size) can produce batches that are refused whole.

So for any app whose event rate × the time one batch takes to post is more than `maxBuffer`, a share of experiment events is lost, and the experiment results computed from them are biased toward whichever events survived.

### Reproduction

No Flagsmith instance is needed: `repro.mjs` (attached, ~90 lines) runs the real SDK against a local stand-in for the events endpoint that answers like 2.291.0 (`202 { accepted, rejected }`, 413 over 2 MiB) after a set delay. It tracks events at a fixed rate and compares how many were tracked with how many the endpoint received.

```sh
npm i @flagsmith/nodejs@9.4.0
node repro.mjs <eventsPerSecond> <seconds> <endpointDelayMs> [maxBuffer] [flushIntervalMs]
```

### Results (Node 24, Windows 11; `@flagsmith/nodejs` 9.4.0)

| SDK settings | Events/s | Endpoint answers after | Tracked | Received | Lost | Logged as dropped |
|---|---|---|---|---|---|---|
| defaults (buffer 1,000, flush 10 s) | 100 | 0.2 s | 6,000 | 6,000 | 0 | 0 |
| defaults | 300 | 5 s | 9,000 | 6,447 | **2,553 (28.4%)** | 2,553 |
| defaults | 150 | 10 s | 9,000 | 6,470 | **2,530 (28.1%)** | 2,530 |
| `maxBuffer: 7000`, `flushInterval: 1000` | 700 | 4 s | 21,000 | 21,000 | 0 | 0 |
| `maxBuffer: 7000`, `flushInterval: 1000` | 700 | 20 s | 21,000 | 13,960 | **7,040 (33.5%)** | 7,040 |
| `maxBuffer: 20000`, `flushInterval: 1000` | 700 | 30 s | 28,000 | 2,091 | **25,909 (92.5%)** | 8,000 + 2 batches refused with 413 |

The delays are deliberately long here, to make the effect easy to see. Against a real self-hosted Flagsmith 2.291.0 on a 2-vCPU VM, I measured batch round-trips of 4 to 10.7 s under load (~700 events/s from one Node process), and lost 2.2% of events in one run with `maxBuffer: 6000` and `flushInterval: 2000`.

### Still there in 9.5.0

Re-run on `@flagsmith/nodejs` 9.5.0 (the latest, released 23 Nov), same machine, defaults, 300 events/s for 20 s, endpoint answering after 5 s: 6,000 tracked, 4,476 received, **1,524 lost (25.4%)**, all 1,524 logged as dropped. On 9.4.0 with the same settings: 1,527 lost (25.4%). `repro.mjs` prints the version it actually ran.

### Where it happens

- `build/cjs/sdk/events.js:239`: a full buffer while a batch is in flight drops its oldest event.
- `build/cjs/sdk/events.js:260`: the whole buffer becomes one batch, with no size cap.
- `build/cjs/sdk/events.js:362`: a non-retryable status (413 included) drops the whole batch.

### Suggestions (any one helps)

1. **Split a flush into batches under the server's body limit** (by bytes, e.g. ≤ 1.5 MiB), so `maxBuffer` can be raised safely.
2. **Expose drops programmatically**, for example an `onEventsDropped(count, reason)` callback in `eventProcessorConfig` or a counter on the client, so apps can alert on loss.
3. **Optionally allow more than one batch in flight**, or flush as soon as the buffer reaches a high-water mark rather than only on the interval.

### Workaround we use

In the meantime, the app can hold its own `trackEvent` calls back while the SDK's buffer is nearly full and feed them in as it empties. That reads the processor's internal buffer, which isn't public API, so a supported signal would be better. With that in place, 8 load runs at 20 to 200 concurrent visitors lost 0 of 121,678 events, measured against the rows Flagsmith stored.

### Versions

`@flagsmith/nodejs` 9.4.0; Flagsmith 2.291.0 (self-hosted, Docker); Node 24.
