# Issue for Flagsmith/flagsmith

Filed 26 Nov 2026: https://github.com/Flagsmith/flagsmith/issues/9120

**Title:** Experimentation: after an experiment is completed, its rollout override keeps splitting identities, so the documented "end it, then update the flag" doesn't reach them

---

### Summary

The analysis docs say to end the experiment, then update the flag to the winning value
(`docs/docs/experimentation/analyse-an-experiment.md:58-61`). On `2.291.0`, completing an experiment sets `ended_at`
but leaves its `experiment-<id>-rollout` system segment override in place. The override is only removed when the
flag's **next** experiment starts. So after following the docs, every identity the rollout covered keeps its old
variation, and the flag edit reaches none of them.

### Reproduction (self-hosted 2.291.0, local-evaluation Node SDK, 300 fresh identities)

1. Create a multivariate flag (`control`, `v2`) and an experiment on it with a 50/50 split. Start it.
2. Evaluate 300 new identities: control 144, v2 156.
3. Complete the experiment, then set the flag's environment default to `v2` (the documented order).
4. Evaluate the same 300 identities again: **control 144, v2 156**. Nothing moved.
5. Start a second experiment on the same flag: the first rollout override is removed (`services.py:619-623,632-681`, PR #8770).

Script: `spikes/07-round04.ts` in https://github.com/tharunkumardeveloper/turnout (log in `spikes/RESULTS.md`).

### Where it happens

- The split is a system segment override, a percentage split on the identity key: `experimentation/services.py:757-775,937-939`.
- Complete sets `ended_at` only: `services.py:624-625`.
- Saves through the flag API don't overwrite the override: `features/future/views.py:117`.

### Expected

Either Complete removes the rollout (or offers to, for example "Complete and roll out the winner"), or the docs say the
override stays until the next experiment and how to clear it.

### Workaround I use

Pause → set the default to the winner → set the rollout to 0% with the winner's weights → Complete. Measured: 300 of
300 identities on the winner, and a later default edit back to control reaches all 300.
