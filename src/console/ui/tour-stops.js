// The tour's stops, one list per page (the engine is tour.js). Judge mode's tour walks you through one whole test by
// clicking: pick a kind, start it, send shoppers, ask Flagsmith, decide, then look in Flagsmith and be a visitor
// yourself. The console's tour shows where everything is. Server mode's public page gets narration only (no buttons
// there): a stop's `readonly` replaces it, `readonly: false` drops it.

const goLabel = () => (typeof document === 'undefined' ? null : document.querySelector('#go')?.textContent?.trim()) || 'the green button';

export const JUDGE_STOPS = [
  {
    target: null,
    title: "Welcome to Turnout's judge mode",
    text: "Turnout puts every new version of an app into a Flagsmith experiment without touching the app's code. This tour walks you through one real test on a demo shop: you click, Flagsmith decides. About three minutes.",
    readonly: { text: 'Turnout puts every new version of an app into a Flagsmith experiment, without touching its code. This public page runs real Flagsmith experiments on a demo shop by itself, with simulated shoppers. Under two minutes.' },
  },
  {
    target: '#kinds',
    click: '#kinds .kind',
    title: 'Pick the kind of test',
    text: 'Click A/B/C to compare two new versions with the current one (or A/B for one, or A/A for two identical copies: a fairness check). Nothing starts yet: first you see what it will compare.',
    readonly: { click: undefined, title: 'The kind of test', text: 'A/A: the same version twice, a check that the split is fair. A/B: one new version against A. A/B/C: two at once. On this public page the autopilot picks the test.' },
  },
  {
    target: '#versions-panel',
    title: 'The versions it will compare',
    text: 'Each tile is a live preview of one version of the shop. A is what everyone gets now; B and C are the new ones. In an A/A test the copy, A′, has a dashed outline: same shop, counted separately. Click a preview to open it on its own (never counted).',
    readonly: { text: 'Each tile is a live preview of one version of the shop. A is what everyone gets now; B and C are new. Click a preview to open that version on its own (never counted).' },
  },
  {
    target: ['#go', '#steps-panel'],
    click: '#go',
    action: 'start',
    title: 'Start the test',
    text: () => `Click “${goLabel()}”. Turnout creates the experiment in Flagsmith and the flag starts splitting shoppers between the versions.`,
    readonly: { click: undefined, action: undefined, target: '#steps-panel', title: 'Four steps, run by the autopilot', text: 'Start the test, send shoppers, ask Flagsmith, decide. Here the autopilot runs each step by itself; the line in the current step says what comes next.' },
  },
  {
    target: ['#go', '#steps-panel'],
    click: '#go',
    action: 'visitors',
    title: 'Send shoppers',
    text: () => `Click “${goLabel()}”. Simulated shoppers browse the shop through Turnout; Flagsmith picks a version for each one and counts their visits and orders.`,
    readonly: false,
  },
  {
    target: ['#go', '#steps-panel'],
    click: '#go',
    action: 'score',
    title: 'Ask Flagsmith',
    text: () => `Click “${goLabel()}”. Flagsmith compares each new version with A using its own Bayesian statistics. Turnout does no maths of its own.`,
    readonly: false,
  },
  {
    target: '#results-panel',
    title: 'What Flagsmith measured',
    text: "Orders are the goal. Page load time and server errors are safety checks: a version that sells more but loads slower doesn't ship. Every number and call here is Flagsmith's own.",
  },
  {
    target: ['#go', '#steps-panel'],
    click: '#go',
    action: ['ship', 'revert', 'keep-running'],
    title: 'Decide',
    text: () => `Click “${goLabel()}”. Shipping or rolling back is one flag change in Flagsmith, not a deploy. Right after it, 50 brand-new shoppers check that everyone gets the result.`,
    readonly: { click: undefined, action: undefined, target: '#steps-panel', title: 'The decision', text: 'Ship or roll back is one flag change in Flagsmith, not a deploy. Right after it, 50 brand-new shoppers check that everyone really gets the result.' },
  },
  {
    target: '#tab-flagsmith',
    click: '#tab-flagsmith',
    title: 'Look inside Flagsmith',
    text: 'Click “In Flagsmith”: the flag, its split and the experiment as Flagsmith holds them right now, the route each shopper takes, and the login to open the same things in Flagsmith.',
    readonly: { text: 'Click “In Flagsmith” any time: the flag, its split and the experiment as Flagsmith holds them, and the route each shopper takes. Flagsmith’s own dashboard stays private on this public page.' },
  },
  {
    target: '#be-visitor',
    click: '#be-visitor',
    title: 'Be a visitor yourself',
    text: 'Click “Be a visitor”: the shop opens in a new tab and Flagsmith gives you a version, like any shopper. Come back here: the route in “In Flagsmith” marks where you landed, and the line above the versions says which one.',
  },
  {
    target: '#autoplay',
    title: 'Play it for me',
    text: 'Next time, this clicks every green button for you through one whole test, in about a minute.',
    readonly: false,
  },
  {
    target: '#menu a[data-page="console"]',
    title: 'The console, for your own app',
    text: "turnout compare puts Turnout in front of your own versions and opens the console: the same tests (A/A, A/B, A/B/C), live traffic, where you land, Flagsmith's results, and Ship or Revert. It has its own tour.",
    readonly: false,
  },
];

export const CONSOLE_STOPS = [
  {
    target: null,
    title: 'The Turnout console',
    text: 'The console is where you run tests on your own app (Try it with your app, or turnout compare, opens it). Everything on it is read from Flagsmith or the proxy, live. A short tour: about a minute.',
  },
  {
    target: '#run',
    title: 'Run a test: one button',
    text: 'Pick A/A, A/B or A/B/C and check the preview, then one button does the rest: it starts the test in Flagsmith, sends simulated shoppers and asks Flagsmith for its results, waiting out Flagsmith’s 5-minute refresh limit if it has to.',
    readonly: false,
  },
  {
    target: '#try-open',
    title: 'Try it with your own app',
    text: 'Give Turnout one, two or three versions of your app (a Dockerfile, a public git repo or an image). It builds them, runs them behind its own proxy and opens the same test page as judge mode: previews, one-button runs and Flagsmith’s results. One version makes an A/A test, two an A/B, three an A/B/C.',
    readonly: false,
  },
  {
    target: '#site-open',
    click: '#site-open',
    title: 'Be a visitor',
    text: 'Click “Open your site”: it opens through Turnout in a new tab and Flagsmith gives you a version. Come back: the line under the button says which, and More lists your visits before and after the test.',
    readonly: { click: undefined, text: 'Open the site through Turnout: Flagsmith gives you a version, and the line under the button says which.' },
  },
  {
    target: '#traffic',
    title: 'The traffic map',
    text: 'Every request Turnout routes is a dot that rides to the version that served it; the faint moving dots show the path the flag sends the next visitor. The YOU pin marks the version you get.',
  },
  {
    target: '#actions',
    title: 'Decide',
    text: 'Ship the winner or revert: each shows the exact Flagsmith calls first and asks you to confirm. The pre-selected version is the best one that passes every safety check.',
    readonly: { text: 'On this public page the autopilot decides, by the same rules: ship the best version that passes every safety check, or revert. The private console has the buttons.' },
  },
  {
    target: '#results',
    title: "Flagsmith's results",
    text: "The goal and the safety checks per version, exactly as Flagsmith's results API returns them. Refresh asks Flagsmith to recompute: it allows one every 5 minutes, so Turnout holds a refresh back until new visits have arrived.",
  },
  {
    target: '#menu-flagsmith',
    title: 'Flagsmith itself',
    text: 'Opens your self-hosted Flagsmith in a new tab. The sign-in details are under More in the Your site card.',
    readonly: false,
  },
  {
    target: '#history-drop',
    title: 'History',
    text: 'Every past test on this flag with its decision, and the snapshot of Flagsmith’s results saved before each Ship or Revert.',
  },
];

/** A page's stops: the full list, or server mode's public variants (`readonly` replaces a stop, false drops it). */
export const stopsFor = (stops, readonly) =>
  stops.flatMap((s) => (!readonly ? [s] : s.readonly === false ? [] : [{ ...s, ...(s.readonly ?? {}) }]));
