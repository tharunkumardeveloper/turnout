# Guided demo and the console

The console runs at <http://127.0.0.1:8090>. It has four pages:

| Page | What it is for |
|---|---|
| `/judge` | Guided demo: the whole story from a browser, with a guided tour |
| `/` | The full console: traffic map, Flagsmith's results, Ship winner and Revert, demo controls, snapshots, the guard |
| `/flagsmith` | Every Flagsmith menu and integration, what Turnout does with it, a live value from the Admin API, and for anything a laptop demo can't reach, the source behind that |
| `/setup` | The setup check (`doctor`) in the browser |

Every number about results comes from Flagsmith as returned; the console computes no statistics. Every visitor it sends is simulated, and the page says so.

## Guided demo

One desktop screen, no scrolling (checked at 1366×768 and 1920×1080). Every number on it is Flagsmith's, read from its API; every shopper is simulated, and the page says so.

![Guided demo after an A/B/C test: B shipped to everyone, C stopped by its slower pages, 50 of 50 new shoppers on B](images/judge-dashboard.png)

### The page

- **Top bar.** The menu (Guided demo, Console, Setup check, What we use, **Versions**, and **Flagsmith ↗**, which opens Flagsmith itself), the kind of test, **Tour**, **Play it for me** and **Earlier tests**.
- **The kind of test.** A/A (the same shop on both sides: Flagsmith should find no difference, a check that the split and the counting are fair; the copy, A′, has a dashed outline), A/B, or A/B/C (two new versions at once, each against A). A click shows a **preview**: the versions it will compare, and step 1 with its Start button. Nothing changes in Flagsmith until Start; a running test stops first then, and **Keep test #…** goes back to it.
- **Left: the test in four steps.** Start the test, Send shoppers, Ask Flagsmith, Decide. Only the current step has a button (one green button at a time), each finished step keeps a one-line result, and a running step shows its progress.
- **Right, top: the versions.** A live preview of each version, laid out at a width that suits its tile, its share of shoppers and, once Flagsmith has counted, its order rate. Clicking a preview opens that version on its own, never counted: its pages, styles and links all stay on that version. **Be a visitor ↗** opens the shop the way a shopper gets it.
- **Right, bottom: two tabs.**
  - **What Flagsmith measured**: a row per metric (orders as the goal, page load time and server errors as safety checks, added to cart as a funnel step), a column per version, and Flagsmith's call for each new version against A. The verdict underneath says what to do in one sentence. A safety check Flagsmith calls slightly worse but within Turnout's margin (more than 5% worse and, for page speed, at least 20 ms) reads "slightly worse", not as a failure.
  - **In Flagsmith**: the route each shopper takes right now (shopper → Turnout → the flag → each version's share, with a **YOU** pin on yours), your visits (what you got before the test, in it and after the decision), **Pin my browser** (a Flagsmith identity override for your visitor id: that version on every page, outside the test), the flag with its variants, the experiment and its metrics, links to the flag and the experiment in Flagsmith, and Flagsmith's login.
- **After a decision.** The Decide step shows what changed in Flagsmith, before → after, and then a check that 50 brand-new shoppers all get the result with no test split left on the flag.

**Play it for me** clicks each green button through one whole test, in about a minute for an A/B/C test. The **tour** opens on the first visit and from the Tour button. It walks you through one test by clicks: each stop highlights the button to press and says what it does ("Click “Send 1,400 shoppers”"), moves on when you click it, and waits while a step runs. The console has its own tour on the same engine.

### The demo shop

Three releases with their own look: 1.4 **Classic** (blue, a 3-step checkout), 1.5 **Express** (green, a one-page checkout) and 1.6 **Bold** (charcoal and orange, with a labelled 60 ms test fault on every page). The simulated shoppers order at 10%, 20% and 22% (`TURNOUT_DEMO_RATES`; inputs, not evidence), so with 700 shoppers per version Flagsmith decides on its first look: B ships, and C, which sells a little more, is stopped by its slower pages.

### Flagsmith's own dashboard

The menu's **Flagsmith ↗** opens Flagsmith's dashboard; its login is in the **In Flagsmith** tab (and in the console's **Sign in to Flagsmith** box), so you can see the same flag, experiment and results there. Flagsmith's dashboard refuses to be shown in a frame, so it opens in a separate tab. The password appears only on this machine's console (port 8090, published on `127.0.0.1` only), never on the port other devices use (8091) or on the public page.

### The public page (server mode)

The same page, read-only, at `https://<host>/judge`: no buttons, no console, no Flagsmith links or login. The autopilot runs the story by itself (A/B: 1.5 against 1.4, then 1.6 against the shipped 1.5, then it starts over), and the current step says what it does next. It rests while nobody has the page open and carries on when someone does.

To open guided demo on another device, see [SETUP.md](SETUP.md#judge-mode-on-another-device).

## The full console

- **Run a test:** A/A, A/B or A/B/C with a preview first, then one button: start, simulated shoppers, Flagsmith's results (on the demo; for your own app it starts the test). More: send shoppers yourself, and after a ship, swing back or forward.
- **Try it with your app:** one, two or three versions (Dockerfile, public git repo or image), built and run on this machine, then guided demo for them at `/try`. Local only.
- **Refresh:** held back while no new visit has arrived since the test started or since Flagsmith's last results (Flagsmith allows one recompute every 5 minutes).
- **Your site:** **Open your site: be a visitor**, one line on where you landed, each version on its own and the goal; under **More**: your visits over time, pin this browser, goal suggestions, a new comparison command and the Flagsmith login.
- **Traffic map:** each routed request as a dot, counters for the last 60 seconds, ghost dots that always move along the tracks the flag routes to now, a **YOU** pin on your version.
- **Decide:** Ship winner and Revert. The plan dialog lists the five steps with the API call each one makes. The pre-selected version is the best one that passes every safety check; one that loses a guardrail needs an explicit "ship anyway".
- **Flagsmith's results:** the goal and each guardrail, as returned. Mean metrics are labelled "mean per exposed identity" ([details](FLAGSMITH.md#things-we-found-on-the-pinned-image)).
- **History:** past experiments on the flag and the decision snapshots. **Health and guard:** what was last reported to Flagsmith's Feature Health, and the guard's switch.

For your own app (`turnout compare`) the console has no judge page and sends no simulated shoppers: use `turnout simulate`, which keeps its visitors in a separate Flagsmith environment.
