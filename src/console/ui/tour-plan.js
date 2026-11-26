// The judge tour's script: which "beat" comes next, from the demo's state. Pure: no DOM, no fetch. tour.js plays the
// beats (spotlight, bubble, the autoplay cursor); judge.js renders what they point at.
//
// Every beat is played in two phases. SHOW: the spotlight glides to the target, a short demo animation runs on it
// (`demo`), and the bubble only says "Look here" and the title. EXPLAIN: the bubble opens to the full text.
//
// A beat: { id, tab, target, title, body, action?, flagsmith?, shop?, signin?, skippable?, bubbleAction?, last?, demo? }
//   tab           the in-page tab to show first: 'story' | 'shop' | 'map' | 'setup'
//   target        a CSS selector to spotlight (null: a centred card)
//   action        a judge action; the tour waits for that job before moving on
//   bubbleAction  the action's button lives in the bubble (#tour-action) with this label, not on the page
//   flagsmith     { label, url }: a button that opens the same thing in the "Flagsmith" browser tab
//   shop          'reload' | 'preview': what the Shop tab loads before the beat
//   more          the quick tour's guardrail beat: the bubble offers "Play round two" (carry on as the full tour)
// The Flagsmith sign-in is no beat of its own: the bubble shows it the first time the judge opens a Flagsmith link.
//   skippable     guide mode offers "Skip"
//   last          the closing beat: Finish and "Start over"
//   demo          the SHOW animation, one of DEMOS
import { winnerLine, losingText, formatChance } from './judge-format.js';

export const PHASES = [
  { id: 'deploy', label: 'Deploy', sub: 'a new release' },
  { id: 'split', label: 'Split', sub: 'Flagsmith buckets visitors' },
  { id: 'measure', label: 'Measure', sub: 'Flagsmith scores it' },
  { id: 'decide', label: 'Decide', sub: 'ship or revert' },
  { id: 'everyone', label: 'Everyone', sub: 'one flag, all traffic' },
];

/** The SHOW animations the page knows (app.demo(name, el)). */
export const DEMOS = ['flow-sweep', 'track-burst', 'kpi-count', 'results-grow', 'diff-flash', 'verify-grow', 'stage-pulse', 'fs-flash', 'steps-sweep'];

/** The tabs a beat can name. */
export const TABS = ['story', 'shop', 'map', 'setup'];

// 'reset' is the finished loop: the last stage (the page draws every stage done).
const PHASE_OF = { visitors: 'split', score: 'measure', decide: 'decide', verify: 'everyone', swing: 'everyone', preview: 'deploy', release: 'deploy', reset: 'everyone' };

/** The flow line's lit stage for a judge step. */
export function phaseOf(current) {
  return PHASE_OF[current] ?? 'deploy';
}

/** How long autoplay leaves a beat's explanation on screen: enough to read it at a brisk pace. */
export function readingMs(beat, flavor = 'full') {
  const words = `${beat?.title ?? ''} ${beat?.body ?? ''}`.split(/\s+/).filter(Boolean).length;
  if (flavor === 'quick') return Math.max(3000, Math.min(8000, 1200 + words * 130));
  return Math.max(4500, Math.min(13000, 2000 + words * 180));
}

/** The two tours: 'quick' (one loop, about 2–3 minutes) and 'full' (both releases, the map and the setup check). */
export const FLAVORS = ['quick', 'full'];

/** How long autoplay lets an action beat's text sit before its click. The quick tour clicks sooner: its text stays up while the job runs. */
export function armMs(beat, flavor = 'full') {
  const r = readingMs(beat, flavor);
  return flavor === 'quick' ? Math.min(3000, Math.round(r * 0.5)) : Math.round(r * 0.8);
}

const CHAPTERS = {
  intro: 'Overview',
  'intro:restart': 'Fresh start',
  guardrail: 'Round two',
  visitors: 'Send visitors',
  'visitors-after': 'Send visitors',
  'visitors-fs': 'Send visitors',
  score: 'Results',
  results: 'Results',
  'results-fs': 'Results',
  health: 'Results',
  decide: 'Decision',
  ship: 'Decision',
  'ship-diff': 'Decision',
  'ship-fs': 'Decision',
  'ship-shop': 'Decision',
  revert: 'Decision',
  'revert-diff': 'Decision',
  'revert-fs': 'Decision',
  'revert-shop': 'Decision',
  'reset-diff': 'Fresh start',
  verify: 'Verify',
  'verify-after': 'Verify',
  preview: 'Team preview',
  'preview-shop': 'Team preview',
  'preview-track': 'Team preview',
  'preview-fs': 'Team preview',
  release: 'Next release',
  'release-after': 'Next release',
  'release-fs': 'Next release',
  outro: 'Wrap-up',
  wait: 'Running',
};

/** The bubble's chapter label for a beat ("Results", "Decision"): the tour's progress reads by chapter, not by number. */
export function chapter(beat) {
  const id = String(beat?.id ?? '');
  const [head] = id.split(':');
  return CHAPTERS[id] ?? CHAPTERS[head] ?? 'Tour';
}

const winningChance = (s) => {
  const c = s?.results?.winner?.chanceToWin;
  return Number.isFinite(c) && c >= 0.95;
};

/**
 * One phrase for the closing beat about a decision, taken when the decision is made (the results are gone after):
 * "shop:1.5 shipped on Flagsmith's verdict (99.6% chance to win)".
 */
export function decisionNote(action, s) {
  const v2 = s?.experiment?.v2 ?? 'v2';
  const control = s?.experiment?.control ?? 'control';
  const w = s?.results?.winner;
  const losing = s?.results?.losingGuardrails ?? [];
  if (action === 'revert') {
    return losing.length ? `${v2} reverted when ${losing.map((g) => g.metric).join(' and ')} lost` : `${v2} reverted, everyone kept on ${control}`;
  }
  if (action !== 'ship') return '';
  const chance = w && Number.isFinite(w.chanceToWin) ? formatChance(w.chanceToWin) : null;
  if (winningChance(s)) return `${v2} shipped on Flagsmith's verdict (${chance} chance to win)`;
  return `${v2} shipped as Flagsmith's pick${chance ? ` (${chance}, below its 95% bar)` : ''}`;
}

/** How long the SHOW phase lasts at least (the demo animation may take up to 2 s of it). */
export function showMs(beat) {
  if (beat?.action) return 2000; // the cursor glides to the button and hovers it
  if (beat?.demo) return 1900;
  return beat?.target ? 1600 : 1200;
}

const vars = (s) => ({
  control: s?.experiment?.control ?? 'control',
  v2: s?.experiment?.v2 ?? 'v2',
  live: s?.live ?? 'the live release',
  next: s?.next ?? 'the next release',
});

/** The opening beats, before the first click. Mid-story, it ends with "start from the beginning". */
export function introBeats(s, flavor = 'full') {
  const beats = flavor === 'quick' ? quickIntro() : [
    {
      id: 'intro:flow',
      tab: 'story',
      target: '#flowline',
      demo: 'flow-sweep',
      title: 'Every deploy becomes a Flagsmith experiment',
      body: `This line is the whole idea. A new release is deployed, Flagsmith splits visitors between it and the current one, measures both, and you decide on the same flag. ${
        s?.current === 'reset' ? 'Every stage is ticked: the last run went all the way round.' : 'The lit stage is where the demo is now.'
      }`,
    },
    {
      id: 'intro:steps',
      tab: 'story',
      target: '#steps-panel',
      demo: 'steps-sweep',
      title: 'Seven steps, two releases',
      body: 'The story runs these steps in order: send visitors, ask Flagsmith for results, decide, check everyone got the decision, then preview and release the next version. The highlighted one is next.',
    },
    {
      id: 'intro:kpis',
      tab: 'story',
      target: '#kpis',
      demo: 'kpi-count',
      title: 'The numbers that matter',
      body: "Visitors in this experiment, live requests per second, the events Flagsmith accepted, and Flagsmith's chance that the new release wins. They update as the demo runs.",
    },
    {
      id: 'intro:track',
      tab: 'story',
      target: '#track-card',
      demo: 'track-burst',
      title: 'Who gets which release, live',
      body: 'This map is drawn from the flag in Flagsmith. Every dot is a request Turnover routed, riding the track Flagsmith chose for that visitor. The dots you just saw were a preview; real ones follow.',
    },
    {
      id: 'intro:fs',
      tab: 'story',
      target: '#fs-panel',
      demo: 'fs-flash',
      title: 'Flagsmith, right now',
      body: "Everything in this column is read from Flagsmith's API: the experiment, the flag and its split, the results and Feature Health. You never have to leave this page to check a claim.",
    },
    {
      id: 'intro:shop',
      tab: 'shop',
      shop: 'reload',
      target: '#shop-frame',
      title: 'The app being released',
      body: 'This is the shop, loaded through Turnover. It contains no Flagsmith code at all. The line above it says which release this browser gets, straight from the flag.',
    },
  ];
  if (s && s.current === 'reset') {
    // The last run is complete: the page's own "Start over" button is the one to click.
    beats.push({
      id: 'intro:restart',
      tab: 'story',
      target: '[data-key="btn-reset"]',
      action: 'reset',
      demo: 'stage-pulse',
      title: 'Start from the beginning',
      body: 'The last run is complete. Start over puts everyone back on the first release and starts a fresh experiment in Flagsmith, so you see the whole story.',
      skippable: true,
    });
  } else if (s && s.current !== 'visitors' && s.current !== undefined) {
    // Part-way through: the steps show how far it got; the button lives in the bubble.
    beats.push({
      id: 'intro:restart',
      tab: 'story',
      target: '#steps-panel',
      action: 'reset',
      bubbleAction: 'Start from the beginning',
      demo: 'steps-sweep',
      title: 'Start from the beginning',
      body: 'The demo is part-way through an earlier run, as the ticked steps show. This puts everyone back on the first release and starts a fresh experiment, so you see the whole story.',
      skippable: true,
    });
  }
  return beats;
}

// The quick tour's intro: the idea, then the Flagsmith column. The sign-in only shows when a Flagsmith link is clicked.
function quickIntro() {
  return [
    {
      id: 'intro:flow',
      tab: 'story',
      target: '#flowline',
      demo: 'flow-sweep',
      title: 'Every deploy becomes a Flagsmith experiment',
      body: 'A new release goes out, Flagsmith splits visitors between it and the current one, scores both, and you ship or revert on the same flag. The shop itself has no Flagsmith code.',
    },
    {
      id: 'intro:fs',
      tab: 'story',
      target: '#fs-panel',
      demo: 'fs-flash',
      title: 'Flagsmith, read live',
      body: "This column is read from Flagsmith's API: the experiment, the flag's split, the results and Feature Health. Each step also offers the same page in Flagsmith itself.",
    },
  ];
}

/** The beat that asks for the current step's click. Null when there is nothing to click (the story is complete). */
export function actionBeat(s, rec, flavor = 'full') {
  if (!s || !s.experiment) return null;
  const v = vars(s);
  const exp = s.experiment.id;
  const losing = s.results?.losingGuardrails ?? [];
  const btn = (action) => `[data-key="btn-${action}"]`;
  const beat = (action, title, body, target = btn(action)) => ({ id: `${s.current}:${exp}`, tab: 'story', target, action, demo: 'stage-pulse', title, body });
  switch (s.current) {
    case 'visitors':
      if (flavor === 'quick') {
        return beat(
          'visitors',
          'Send 3,000 visitors',
          `Simulated shoppers go through Turnover. For each one Flagsmith picks ${v.control} (what everyone has now) or ${v.v2} (the new release), about half each. Their pages and orders become Flagsmith events as you watch.`,
        );
      }
      return beat(
        'visitors',
        'Send 3,000 visitors',
        `Simulated shoppers go through Turnover. For each one, Flagsmith decides: ${v.control} (what everyone has now) or ${v.v2} (the new release). Turnover turns their pages and orders into Flagsmith events.`,
      );
    case 'score':
      return beat('score', 'Ask Flagsmith who won', 'Flagsmith runs its Bayesian analysis on orders (the goal), add-to-cart (a funnel step shown alongside, not a guardrail), page speed and errors (the guardrails). Turnover computes no statistics of its own.');
    case 'decide':
      if (losing.length) {
        return beat(
          'revert',
          'Revert: a guardrail is losing',
          `${v.v2} may sell more, but Flagsmith says it is losing on ${losing.map((g) => g.metric).join(' and ')}. The safe call is to keep everyone on ${v.control}. Revert drains the experiment the same careful way a ship does.`,
        );
      }
      if (rec === 'keep-running') {
        const r = s.results?.recommendation;
        const c = r?.chanceToWin;
        return beat(
          'keep-running',
          /crosses zero/.test(r?.reason ?? '') ? 'Keep running: the interval crosses zero' : 'Keep running: not sure yet',
          `Flagsmith puts ${v.v2}${Number.isFinite(c) ? ` at a ${formatChance(c)} chance to win` : ' ahead'}, but its credible interval${r?.reason ? ` (${r.reason.replace(/^interval /, '')})` : ''} still includes no difference at all. An interval crossing zero isn't a win, so the honest call is to keep the experiment running and send more visitors. Nothing changes in Flagsmith.`,
        );
      }
      if (rec === 'revert') return beat('revert', 'Revert to the current release', `Flagsmith doesn't show ${v.v2} ahead, so keep everyone on ${v.control}.`);
      if (!winningChance(s)) {
        const c = s.results?.winner?.chanceToWin;
        return beat(
          'ship',
          `Flagsmith's pick: ${v.v2}, below its 95% bar`,
          `Flagsmith puts ${v.v2} ahead${Number.isFinite(c) ? ` with a ${formatChance(c)} chance to win` : ''}, and its bar for a verdict is 95%, so this result is inconclusive. Shipping now is a judgement call: it changes the flag so everyone gets ${v.v2}, with Flagsmith's numbers saved first.`,
        );
      }
      return beat(
        'ship',
        `Ship the winner: ${v.v2}`,
        `Flagsmith's results show ${v.v2} winning, above its 95% bar. Shipping changes the flag so everyone gets it, in an order that reaches every visitor, with Flagsmith's numbers saved first.`,
      );
    case 'verify':
      return beat('verify', 'Prove everyone got it', `50 brand-new visitors arrive. Every one of them should get ${v.live}, and no experiment split should be left on the flag.`);
    case 'preview':
      return beat(
        'preview',
        `Show ${v.next} to your team first`,
        `A Flagsmith segment override gives ${v.next} only to browsers that open the preview link. Nobody else sees it, and your team stays out of the experiment's data.`,
      );
    case 'release':
      return beat('release', `Release ${v.next}`, `A new Flagsmith experiment on the same flag: ${v.next} against ${v.live}. No app code changes; the shop never mentions Flagsmith.`);
    default:
      return null;
  }
}

/** What to show after a job finished: where to look here, then the same thing in the Flagsmith column (and tab). */
export function afterBeats(action, s, extra = {}) {
  const v = vars(s);
  const exp = s?.experiment?.id ?? 0;
  const links = s?.links ?? {};
  const fs = (label, url) => (url ? { label, url } : null);
  if (extra.flavor === 'quick') return quickAfter(action, s, extra);
  switch (action) {
    case 'visitors':
      return [
        {
          id: `visitors-after:${exp}`,
          tab: 'story',
          target: '#track-card',
          demo: 'track-burst',
          title: 'The split, as it happened',
          body: `The dots rode two tracks: ${v.control} and ${v.v2}, about half each. Flagsmith chose the track for every visitor; Turnover only followed the flag.`,
        },
        {
          id: `visitors-fs:${exp}`,
          tab: 'story',
          target: '#fs-experiment',
          demo: 'fs-flash',
          title: 'The same visitors, in Flagsmith',
          body: 'Each visitor was recorded as an exposure of this experiment, and each order and page load as an event Flagsmith accepted. This card reads the experiment back from Flagsmith.',
          flagsmith: fs('Open the experiment in Flagsmith', links.experiment),
        },
      ];
    case 'score': {
      const losing = s?.results?.losingGuardrails ?? [];
      const beats = [
        {
          id: `results:${exp}`,
          tab: 'story',
          target: '#stage-visual',
          demo: 'results-grow',
          title: "Flagsmith's verdict",
          body: [winnerLine(s).text, ...losing.map(losingText)].join(' '),
        },
        {
          id: `results-fs:${exp}`,
          tab: 'story',
          target: '#fs-results',
          demo: 'fs-flash',
          title: 'The same numbers, from Flagsmith',
          body: "Every bar is Flagsmith's own result, exactly as its API returned it. Its results page shows the same chance to win and lift.",
          flagsmith: fs("Open Flagsmith's results page", links.experiment),
        },
      ];
      if (losing.length && extra.unhealthy) {
        beats.push({
          id: `health:${exp}`,
          tab: 'story',
          target: '#fs-flag',
          demo: 'fs-flash',
          title: 'Flagsmith marks the flag Unhealthy',
          body: "Turnover reported the losing guardrail to Flagsmith's Feature Health. The release flag now carries an Unhealthy tag in Flagsmith, with Flagsmith's numbers as the reason.",
          flagsmith: fs('See the flag in Flagsmith', links.flag),
        });
      }
      return beats;
    }
    case 'ship':
    case 'revert':
    case 'reset':
      return [
        {
          id: `${action}-diff:${exp}`,
          tab: 'story',
          target: '#stage-visual',
          demo: 'diff-flash',
          title: 'What changed in Flagsmith',
          body: 'Before → after, read back from Flagsmith once the job finished. Highlighted rows changed; the rest stayed as they were.',
        },
        ...(action === 'reset'
          ? []
          : [
              {
                id: `${action}-fs:${exp}`,
                tab: 'story',
                target: '#fs-flag',
                demo: 'fs-flash',
                title: 'The flag in Flagsmith',
                body: `Its default value is now ${v.live}. No deploy happened: the decision is a flag change, and after it the flag is an ordinary flag anyone can edit.`,
                flagsmith: fs('Open the flag in Flagsmith', links.flag),
              },
              {
                id: `${action}-shop:${exp}`,
                tab: 'shop',
                shop: 'reload',
                target: '#shop-frame',
                title: 'The shop, now',
                body: `Reloaded through Turnover. The flag's default is now ${v.live}, so every new visitor gets it; 50 of them prove it in the next step.`,
              },
            ]),
      ];
    case 'verify':
      return [
        {
          id: `verify-after:${exp}`,
          tab: 'story',
          target: '#stage-visual',
          demo: 'verify-grow',
          title: 'Everyone, on one release',
          body: `One bar: all 50 new visitors got ${v.live}. The check found no experiment split left on the flag.`,
        },
      ];
    case 'preview':
      return [
        {
          id: `preview-shop:${exp}`,
          tab: 'shop',
          shop: 'preview',
          target: '#shop-frame',
          title: "Your team's view",
          body: `This browser opened the preview link, so the shop shows ${s?.preview?.release ?? v.next}. Everyone else still gets ${v.live}.`,
        },
        {
          id: `preview-track:${exp}`,
          tab: 'story',
          target: '#track-card',
          demo: 'track-burst',
          title: 'A track just for your team',
          body: 'The map gained a "your team" track, ranked above any experiment. Only browsers with the preview link ride it.',
        },
        {
          id: `preview-fs:${exp}`,
          tab: 'story',
          target: '#fs-flag',
          demo: 'fs-flash',
          title: 'The segment override, in Flagsmith',
          body: 'The flag card shows the turnover-preview segment override that serves your team. It is an ordinary Flagsmith segment, read back from the API.',
          flagsmith: fs('See the segment override in Flagsmith', links.flag),
        },
      ];
    case 'release':
      return [
        {
          id: `release-after:${exp}`,
          tab: 'story',
          target: '#track-card',
          demo: 'track-burst',
          title: 'A new experiment on the same flag',
          body: `The experiment track is back, now splitting ${s?.experiment?.control ?? v.live} and ${s?.experiment?.v2 ?? v.next}. Round two: this release sells even more, but it carries a deliberate test fault, a labelled 60 ms delay on every page. Watch the page-speed guardrail catch it.`,
        },
        {
          id: `release-fs:${exp}`,
          tab: 'story',
          target: '#fs-experiment',
          demo: 'fs-flash',
          title: 'A new experiment, in Flagsmith',
          body: 'This card now reads the new experiment from Flagsmith: its name, hypothesis and start time. Same flag, new variants.',
          flagsmith: fs('Open the experiment in Flagsmith', links.experiment),
        },
      ];
    default:
      return [];
  }
}

// The quick tour: one beat per finished job, with the Flagsmith column and its link in that same beat.
function quickAfter(action, s, extra) {
  const v = vars(s);
  const exp = s?.experiment?.id ?? 0;
  const links = s?.links ?? {};
  const fs = (label, url) => (url ? { label, url } : null);
  switch (action) {
    case 'score': {
      const losing = s?.results?.losingGuardrails ?? [];
      const beats = [
        {
          id: `results:${exp}`,
          tab: 'story',
          target: '#fs-results',
          demo: 'fs-flash',
          title: "Flagsmith's verdict",
          body: [winnerLine(s).text, ...losing.map(losingText), "Every number is Flagsmith's own; a lead whose credible interval still crosses zero is never called a win."].join(' '),
          flagsmith: fs("Open Flagsmith's results page", links.experiment),
        },
      ];
      if (losing.length && extra.unhealthy) {
        beats.push({
          id: `health:${exp}`,
          tab: 'story',
          target: '#fs-flag',
          demo: 'fs-flash',
          title: 'Flagsmith marks the flag Unhealthy',
          body: "Turnover reported the losing guardrail to Flagsmith's Feature Health, with Flagsmith's numbers as the reason.",
          flagsmith: fs('See the flag in Flagsmith', links.flag),
        });
      }
      return beats;
    }
    case 'ship':
    case 'revert':
      return [
        {
          id: `${action}-diff:${exp}`,
          tab: 'story',
          target: '#stage-visual',
          demo: 'diff-flash',
          title: 'Before → after, in Flagsmith',
          body: `Read back from Flagsmith: the flag's default is now ${v.live} and the experiment's split is drained. No deploy happened, only a flag change.`,
          flagsmith: fs('Open the flag in Flagsmith', links.flag),
        },
      ];
    case 'verify':
      return [
        {
          id: `verify-after:${exp}`,
          tab: 'story',
          target: '#stage-visual',
          demo: 'verify-grow',
          title: 'Everyone, on one release',
          body: `All 50 brand-new visitors got ${v.live}, and no experiment split is left on the flag.`,
        },
      ];
    default:
      return [];
  }
}

/** The quick tour's guardrail story in one beat: what round two shows, with the choice to play it (`more`). */
export function guardrailBeat(s) {
  const next = s?.next ?? 'The next release';
  return {
    id: 'guardrail',
    tab: 'story',
    target: '#steps-panel',
    demo: 'steps-sweep',
    title: 'Round two: a guardrail catches a bad release',
    body: `${next} sells even more, but carries a deliberate, labelled 60 ms delay on every page. Flagsmith's page-speed guardrail scores it losing, the flag turns Unhealthy in Feature Health, and the call becomes Revert.`,
    more: Boolean(s?.next),
  };
}

/** The quick tour's ending: the guardrail beat, then the last beat with what this tour decided. */
export function quickOutro(s, notes = []) {
  const said = (notes ?? []).filter(Boolean);
  const story = said.length ? `${said.join('; then ')}.` : "The release was decided on Flagsmith's numbers.";
  return [
    guardrailBeat(s),
    {
      id: 'outro:end',
      tab: 'story',
      target: '#history',
      title: "That's the loop",
      body: `${story} Every decision is in the release history with Flagsmith's numbers. The Feature map and Setup tabs show everything Turnover uses in Flagsmith.`,
      last: true,
    },
  ];
}

/**
 * The closing beats: the feature map, the setup check, and the end. `notes` are the decisions this tour watched
 * (decisionNote), so the last beat says what really happened.
 */
export function outroBeats(notes = []) {
  const said = (notes ?? []).filter(Boolean);
  const story = said.length
    ? `${said.length === 2 ? 'Two releases' : said.length === 1 ? 'One release' : `${said.length} releases`}: ${said.join('; then ')}.`
    : 'Each release was decided on Flagsmith\'s numbers.';
  return [
    {
      id: 'outro:map',
      tab: 'map',
      target: '#map-frame',
      title: 'Everything Turnover uses in Flagsmith',
      body: "Every Flagsmith menu and integration, with what Turnover does with it and live values from this instance. The ones a laptop demo can't reach say why, with Flagsmith's source.",
    },
    {
      id: 'outro:setup',
      tab: 'setup',
      target: '#setup-frame',
      title: 'Everything, checked',
      body: 'The setup check compares what Turnover needs with what is really there, from Flagsmith to each release container. Green means expected and actual match.',
    },
    {
      id: 'outro:end',
      tab: 'story',
      target: '#history',
      title: "That's the whole loop",
      body: `${story} Every decision is in the release history with Flagsmith's numbers. Start over to run it again.`,
      last: true,
    },
  ];
}

/** The beat shown while a job the tour didn't start is running: it carries on when the job ends. */
export function waitBeat() {
  return { id: 'wait', tab: 'story', target: '#stage-visual', title: 'A step is running', body: 'The tour carries on by itself when it finishes.', wait: true };
}

const ROUND = ['visitors', 'score', 'decide', 'verify', 'preview', 'release'];
const ACTION_OF = { decide: 'ship' };

/**
 * About how many beats are left from this state: each remaining step's click and what follows it, a final round when
 * there is a next release, and the outro. Only for "Step x of N"; it never has to be exact.
 */
export function remainingBeats(s, flavor = 'full') {
  if (flavor === 'quick') {
    const left = { visitors: 8, score: 7, decide: 5, verify: 4 };
    return s?.experiment ? (left[s.current] ?? 2) : 2;
  }
  const outro = outroBeats().length;
  if (!s || !s.experiment) return outro;
  const i = ROUND.indexOf(s.current);
  if (i < 0) return outro;
  const per = (step) => 1 + afterBeats(ACTION_OF[step] ?? step, s).length;
  const round = s.next ? ROUND : ROUND.slice(0, 4);
  let n = 0;
  for (const step of round.slice(i)) n += per(step);
  if (s.next) for (const step of ROUND.slice(0, 4)) n += per(step); // the next release's round
  return n + outro;
}
