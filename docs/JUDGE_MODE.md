# Judge mode and the console

The console runs at <http://127.0.0.1:8090>. It has four pages:

| Page | What it is for |
|---|---|
| `/judge` | Judge mode: the whole story from a browser, with a guided tour |
| `/` | The full console: traffic map, Flagsmith's results, Ship winner and Revert, demo controls, snapshots, the guard |
| `/flagsmith` | Every Flagsmith menu and integration, what Turnout does with it, a live value from the Admin API, and for anything a laptop demo can't reach, the source behind that |
| `/setup` | The setup check (`doctor`) in the browser |

Every number about results comes from Flagsmith as returned; the console computes no statistics. Every visitor it sends is simulated, and the page says so.

## Judge mode

### The welcome screen

It says what Turnout is in three points (no app code; Flagsmith decides; ship or revert on one flag) and offers two ways to run the tour:

- **Guide me.** The tour dims the page, puts a spotlight on the one thing to look at or click, and explains it in a bubble. You click the highlighted button and press **Next**.
- **Play it for me.** The same tour, hands-free. An on-screen cursor glides to each button and clicks it. Each explanation stays up for 4.5 to 13 seconds, depending on its length.

Either way you pick a tour:

- **Quick tour** (the default, about 2.6 minutes played for you): one release through visitors, Flagsmith's results and Ship, one beat per finished job, then a single beat that sums up the guardrail story, with **Play round two** to carry on as the full tour.
- **Full tour** (about 9 to 10 minutes): both releases, the guardrail revert, the feature map, the setup check and the release history.

You can switch between the two, pause or leave the tour at any point from the bubble. **Explore on my own** closes the welcome screen without a tour.

Each beat is shown in two phases. First the spotlight moves to its target, a short animation plays on it, and the bubble says only "Look here" and the title. Then the bubble opens to the full explanation.

### The page

Four tabs: **Story**, **Shop** (the shop through Turnout, which has no Flagsmith code), **What we use** (the `/flagsmith` page) and **Setup check** (the `/setup` page). The tour moves between them on its own.

The Story tab is a three-column dashboard:

- **Left: Demo steps and Release history.** The seven steps are: send simulated visitors, get Flagsmith's results, decide (Ship winner or Revert), check that everyone gets the decision, swing back (optional, only after a ship), preview the next release for your team, and release it. The history shows the latest three decisions, with **Show all** for the rest. The column stays in place while you scroll only when it fits on the screen.
- **Centre: the flow and the one thing to do now.**
  - A flow line, Deploy → Split → Measure → Decide → Everyone. The current stage lights up, and pulses while a step runs.
  - Four tiles: visitors in this experiment, live requests per second, events accepted and rejected (Flagsmith's own counter) and the chance to win (from Flagsmith).
  - A live track map drawn from the flag: your team (the preview segment), the experiment's split with its percentages, and everyone else. Every request rides its track as a dot, coloured by the release that served it.
  - A stage card with the step's button. While a step runs it shows a checklist of the step's stages and, for visitors, a progress bar. When it finishes it shows a **before → after** card of what changed in Flagsmith. At Decide, when Flagsmith shows the winner losing a guardrail, Revert is the main button and **Ship anyway…** needs you to accept the loss first. After a ship, the swing back appears as a smaller, optional button.
- **Right: In Flagsmith right now**, read from Flagsmith's API: the experiment, the release flag and its split, Feature Health and the results.

Judge mode sends 3,000 simulated visitors per experiment: with 1,500, the first experiment's result lands below Flagsmith's 95% bar about one run in three.

### Flagsmith's own dashboard

Flagsmith's dashboard refuses to be shown in a frame, so each "see it in Flagsmith" step opens it in one separate browser tab and reuses that tab. The sign-in details are not a tour step: the bubble shows the admin login only the first time you open a Flagsmith link. The password appears only on this machine's console (port 8090, published on `127.0.0.1` only), never on the port other devices use (8091), whatever Host header a request sends.

### The full tour, start to finish

The full tour runs the whole story: send visitors, get Flagsmith's results, ship the winner, check that everyone got it, preview the next release for your team, and release it. The second release sells more but loses the page-speed guardrail, so the tour reverts it. It ends on the feature map, the setup check and the release history. If the demo is part-way through an earlier run, the tour first offers to start from the beginning.

Played for you at 1440×900 on the demo stack, the full tour took 8 min 51 s from the welcome screen to its last beat, through 42 beats (one run on 18 Nov 2026; see [`spikes/RESULTS.md`](../spikes/RESULTS.md)). Most of that is the steps' own jobs and the reading time.

Each shop release has its own look: 1.4 **Classic** (blue, multi-step checkout), 1.5 **Express** (green, one-page checkout) and 1.6 **Bold** (charcoal and orange, with the deliberate 60 ms test fault behind the guardrail loss).

On screens narrower than 640 px the bubble becomes a bottom sheet. To open judge mode on another device, see [SETUP.md](SETUP.md#judge-mode-on-another-device).

## The full console

- **Traffic map:** each routed request as a dot, counters for the last 60 seconds, and sidings for past experiments on the flag with their decisions.
- **Decide:** Ship winner and Revert. The plan dialog lists the five steps with the API call each one makes. If the winner is losing a guardrail, it says so in red, and the confirm button waits until you tick the box to ship anyway.
- **Demo controls:** send 50 to 3,000 simulated visitors (1,500 by default), and after a ship, **Swing back** to the release it replaced or **Swing forward** again. Each is one edit to the flag's environment default, the same edit as in Flagsmith's flag editor. A progress bar follows the job; Ship and Revert wait while it runs. The card also follows steps started from judge mode.
- **Flagsmith's results:** the goal and each guardrail, as returned. Mean metrics are labelled "mean per exposed identity": Flagsmith averages over every exposed identity, and one with no event counts as 0 ([details](FLAGSMITH.md#things-we-found-on-the-pinned-image)).
- **Decision snapshots:** the results saved before each decision, newest first.
- **Health and guard:** what was last reported to Flagsmith's Feature Health, and the guard's switch.

When the flag is changed in Flagsmith after a ship, the console says so: it shows the release the flag serves next to the one the ledger recorded.
