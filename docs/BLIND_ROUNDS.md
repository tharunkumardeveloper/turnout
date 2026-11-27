# How accurate are Flagsmith's experiment calls? 41 blind rounds

The live demo runs A/B tests by itself. In each **blind round** the true order rate of each version is drawn at random
and hidden: the new version is truly better, truly worse, or exactly the same. Simulated shoppers order at those
hidden rates, Flagsmith's Experimentation computes its results, a decision is made, and only then is the truth
revealed. That makes it possible to grade Flagsmith's call against a known answer, which a real experiment never
allows.

Data: the 41 rounds decided on the live demo during Toggle Wars, from 26 Nov 2026 06:31 to 27 Nov 2026 02:29 UTC,
Flagsmith 2.291.0 self-hosted, about 1,200 shoppers per round. Every round, with its hidden rates and Flagsmith's
chance to win: [blind-rounds.json](blind-rounds.json). The autopilot keeps running rounds; this page counts those
41.

## Two things are graded separately

* **Flagsmith's call:** its chance that B beats A on the goal (orders). A call is made when it crosses 95% (B better)
  or falls under 5% (A better).
* **Turnout's decision:** Flagsmith's call plus Turnout's safety checks (page speed, server errors). The public
  scoreboard grades this one: **right in 40 of 41**.

In 17 of the 41 rounds the new version was 1.6, whose pages are deliberately slow. Turnout rolled back all 17 on the
page-speed check, whatever the order rates were. Those rounds say little about Flagsmith's order call, so the cleanest
view of it is the other 24.

## Flagsmith's call, where only orders differed (24 rounds)

| The hidden truth | Rounds | Flagsmith's call | Right |
|---|---|---|---|
| B truly better (+60% orders) | 10 | B better, ≥ 95% | **10 of 10** |
| B truly worse (−37% orders) | 6 | A better, ≤ 5% | **6 of 6** |
| No difference | 8 | no call in 7; **a false call in 1**: B at 99.3% | 7 of 8 |

That false call (experiment 198) is the scoreboard's only wrong round: A and B truly ordered at the same rate, Flagsmith
was 99.3% sure B was better with an interval of +5% to +43%, which clears zero, and Turnout shipped. No safety check
could catch it: the versions were identical.

## False winners across all 15 no-difference rounds

Counting the slow rounds too, Flagsmith's chance to win crossed 95% or fell under 5% in **2 of 15** rounds where the
versions truly had the same order rate (13%; experiment 209, a slow round at 0.2%, was rolled back on page speed
anyway). A two-sided 95% threshold would be expected to do that about 10% of the time. With 15 rounds the result is
consistent with that, so this is not evidence that Flagsmith is miscalibrated; it is a measured reminder that a 95%
call is wrong about one time in ten when there is nothing to find, and more often if a result is looked at
repeatedly.

## What this does and doesn't show

* **Shown:** at about 1,200 shoppers, Flagsmith detected every real 60% lift and every real 37% drop (16 of 16), and
  never called a winner in the wrong direction.
* **Not shown:** how many shoppers it needs to cross 95%. Every round used a fixed number of shoppers and asked once,
  so the data can't say when the line was crossed, and only two effect sizes were drawn.
* **Not shown:** anything about real people. The shoppers are simulated, at rates Turnout set.
* **Small numbers:** 8 no-difference rounds without the slow version, 15 with it. The autopilot adds a round every
  few minutes, so these counts grow until the end of the hackathon.

## What Turnout does with it

Turnout never ships on a call alone: it also needs the interval to clear zero and every safety check to pass. That
stopped all 17 slow rounds. It does not stop a false winner on identical versions, which is why the guided demo
offers an **A/A test** (the same version on both sides) before trusting a setup: on identical versions, any
winner Flagsmith calls is a false one.
