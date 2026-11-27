# How accurate are Flagsmith's experiment calls? 111 blind rounds

The live demo runs A/B tests by itself. In each **blind round** the true order rate of each version is drawn at random
and hidden: the new version is truly better, truly worse, or exactly the same. Simulated shoppers order at those
hidden rates, Flagsmith's Experimentation computes its results, a decision is made, and only then is the truth
revealed. That makes it possible to grade Flagsmith's call against a known answer, which a real experiment never
allows.

Data: the first 111 rounds decided on the live demo during Toggle Wars, from 26 Nov 2026 06:31 to 27 Nov 2026 07:18
UTC (experiments 186 to 330), Flagsmith 2.291.0 self-hosted, about 1,200 shoppers per round. Every round, with its
hidden rates and Flagsmith's chance to win: [blind-rounds.json](blind-rounds.json).

## What Turnout adds on top of Flagsmith

The same 111 rounds under two rules for shipping a new version:

| Rule | Versions shipped | Bad ships |
|---|---|---|
| Ship whenever Flagsmith is ≥ 95% sure the new version gets more orders | 38 | **14**: 13 deliberately slow releases that did sell more, and 1 false winner (experiment 198) |
| Turnout: Flagsmith ≥ 95% **and** its credible interval clears zero **and** every safety check passes | 24 | **1**: the false winner, experiment 198 |

The 13 slow ones are version 1.6, whose pages carry a deliberate 60 ms delay: in those rounds it was drawn to sell
more, Flagsmith rightly saw it, and a rule that only reads orders would have shipped a slower site. Turnout's page-speed
check rolled back every round with 1.6 in it, 45 of 45, whatever the orders said.

## Two things are graded separately

* **Flagsmith's call:** its chance that B beats A on the goal (orders). A call is made when it crosses 95% (B better)
  or falls under 5% (A better).
* **Turnout's decision:** Flagsmith's call plus the interval check and the safety checks (page speed, server errors).
  The public scoreboard grades this one: **right in 105 of 111**.

## Flagsmith's call, where only orders differed (66 rounds)

| The hidden truth | Rounds | Flagsmith's call | Right |
|---|---|---|---|
| B truly better (+60% orders) | 26 | B better, ≥ 95% in 24; no call in 2 | **24 of 26** |
| B truly worse (−37% orders) | 12 | A better, ≤ 5% | **12 of 12** |
| No difference | 28 | no call in 26; **a false call in 2**: B at 99.3% (experiment 198), A at 1.2% (experiment 236) | 26 of 28 |

Flagsmith never called a winner in the wrong direction. Its two false calls were both on identical versions.

## Turnout's six that weren't right

* **Experiment 198, wrong:** A and B ordered at the same rate (10.2%), Flagsmith was 99.3% sure B was better with an
  interval of +5% to +43%, which clears zero, and Turnout recommended shipping. No safety check could catch it: the
  versions were identical.
* **Experiment 236, wrong:** the mirror case: identical versions (10.4%), Flagsmith 1.2% for B with an interval of
  −52% to −4%, and Turnout recommended reverting to A, which changes nothing a visitor sees.
* **Experiments 234, 239, 240 and 241, no call:** a real difference (three lifts, one drop) where Flagsmith's interval
  still crossed zero at 1,200 shoppers, so Turnout said keep running rather than guess.

Five of these six (all but 198) are among the 15 rounds decided by a test of Ship under live traffic (experiments 229
to 243): it asked Flagsmith once at 1,200 shoppers and decided straight away. When a result is unclear, the autopilot
instead sends more shoppers and asks again before deciding.

## False winners across all 45 no-difference rounds

Counting the slow rounds too, Flagsmith's chance to win crossed 95% or fell under 5% in **3 of 45** rounds where the
versions truly had the same order rate (7%; experiment 209, a slow round at 0.2%, was rolled back on page speed
anyway). A two-sided 95% threshold would be expected to do that about 10% of the time, so this is consistent with a
well-calibrated engine, and a reminder that a 95% call is wrong about one time in ten when there is nothing to find.

## What this does and doesn't show

* **Shown:** at about 1,200 shoppers, Flagsmith detected 36 of 38 real differences (every 37% drop and 24 of 26 60%
  lifts), never in the wrong direction; and checking page speed as well as orders stopped every slow release.
* **Not shown:** how many shoppers it needs to cross 95%: each round asked once or a few times at fixed shopper
  counts, and only two effect sizes were drawn.
* **Not shown:** anything about real people. The shoppers are simulated, at rates Turnout set.

## Known limits, and what would come next

* **A false winner on identical versions can still ship.** Experiment 198 passed every check Turnout has: 99.3%, an
  interval clearing zero, no safety check losing. Asking Flagsmith repeatedly as shoppers arrive (the autopilot keeps
  running an unclear test and asks again) also raises the chance of such a call, as any repeated look does. Not changed
  during the hackathon, because changing the rule now would make these 111 rounds incomparable with the next ones.
  **Next:** plan the shoppers needed before a test starts (Turnout's launch estimate already gives it) and count a
  win only at that size, or require the call to hold across two looks; and run an **A/A test** first (the same version
  on both sides, offered in the guided demo), on which any winner is a false one.
* **Page speed measured in browsers** (`lcp_ms`, `cls`) counts a visitor whose browser never reported as 0 in
  Flagsmith's mean, which flatters a version whose visitors leave early. Turnout compares those two metrics only when
  both versions reported about as often (within 5 points), and says so when it doesn't; a mean over reporting
  visitors only would remove the bias outright. The live demo's simulated shoppers send no browser page speed, so those
  metrics show "no events" there and decide nothing.
