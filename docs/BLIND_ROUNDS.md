# How accurate are Flagsmith's experiment calls? 111 blind rounds

The live demo runs A/B tests by itself. In each **blind round** the true order rate of each version is drawn at random
and hidden: the new version is truly better, truly worse, or exactly the same. Simulated shoppers order at those
hidden rates, Flagsmith's Experimentation computes its results, a decision is made, and only then is the truth
revealed. That makes it possible to grade Flagsmith's call against a known answer, which a real experiment never
allows.

Data: 111 decided rounds on the live demo, 24 to 26 Nov 2026, Flagsmith 2.291.0 self-hosted, about 1,200 shoppers per
A/B round. Every round, with its hidden rates and Flagsmith's chance to win: [blind-rounds.json](blind-rounds.json).

## Two things are graded separately

* **Flagsmith's call:** its chance that B beats A on the goal (orders). A call is made when it crosses 95% (B better)
  or falls under 5% (A better).
* **Turnout's decision:** Flagsmith's call plus Turnout's safety checks (page speed, server errors). The public
  scoreboard ("right in 109 of 111") grades this one.

In 53 of the 111 rounds the new version was 1.6, whose pages are deliberately slow. Turnout rolled back all 53 on the
page-speed check, whatever the order rates were. Those rounds say little about Flagsmith's order call, so the cleanest
view of it is the other 58.

## Flagsmith's call, where only orders differed (58 rounds)

| The hidden truth | Rounds | Flagsmith's call | Right |
|---|---|---|---|
| B truly better (+60% orders) | 20 | B better, ≥ 95% | **20 of 20** |
| B truly worse (−37% orders) | 18 | A better, ≤ 5% | **18 of 18** |
| No difference | 20 | no call in 15; **a false call in 5**: B at ≥ 99% in 2, A at ≤ 5% in 3 | 15 of 20 |

In the three A-side calls (experiments 125, 133 and 139, at 4.6%, 2.9% and 3.7%) Flagsmith's interval still crossed zero, so Turnout kept testing instead of acting. The two B-side calls cleared zero, and Turnout shipped.

Those two B-side calls (experiments 159 and 198) are the scoreboard's only two wrong rounds: A and B truly ordered at the
same rate (10.4% in one round, 10.2% in the other), Flagsmith was 99.96% and 99.3% sure B was better (intervals +6% to +24% and +5% to +43%), and Turnout
shipped. No safety check could catch it: the versions were identical.

## False winners across all 46 no-difference rounds

Counting the slow rounds too, Flagsmith's chance to win crossed 95% or fell under 5% in **7 of 46** rounds where the
versions truly had the same order rate: **15%** (95% interval 8% to 28%). A two-sided 95% threshold would be expected to
do that about 10% of the time. With 46 rounds the result is consistent with that, so this is not evidence that
Flagsmith is miscalibrated; it is a measured reminder that a 95% call is wrong about one time in ten when there is
nothing to find, and more often if a result is looked at repeatedly.

## What this does and doesn't show

* **Shown:** at about 1,200 shoppers, Flagsmith detected every real 60% lift and every real 37% drop (38 of 38), and
  never called a winner in the wrong direction.
* **Not shown:** how many shoppers it needs to cross 95%. Every round used a fixed number of shoppers and asked once,
  so the data can't say when the line was crossed, and only two effect sizes were drawn.
* **Not shown:** anything about real people. The shoppers are simulated, at rates Turnout set.

## What Turnout does with it

Turnout never ships on a call alone: it also needs the interval to clear zero and every safety check to pass. That
stopped all 53 slow rounds. It does not stop a false winner on identical versions, which is why the guided demo
offers an **A/A test** (the same version on both sides) before trusting a setup: on identical versions, any
winner Flagsmith calls is a false one.
