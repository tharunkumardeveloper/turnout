import { READONLY } from './menu.js';

// A short guided tour of the judge page: each stop highlights one part of the screen and says what it is, with a
// Next button. Ten stops of a few sentences: under two minutes. It opens by itself on a first visit, and again from
// the Tour button. Every string goes in through textContent.

const SEEN_KEY = 'turnout-demo-tour-seen';

/**
 * The stops, in order. target: a selector, a list (the first one on screen wins), or null for a centred card.
 * interactive: the page under the card stays clickable (the test picker). readonly: what server mode's public page
 * shows instead (false: the stop is skipped there: no buttons, no console, no Flagsmith login on the public page).
 */
export const STOPS = [
  {
    target: null,
    title: "Welcome to Turnout's judge mode",
    text: "Turnout puts every new version of an app into a Flagsmith experiment, without touching the app's code. This page runs real Flagsmith experiments on a demo shop with simulated shoppers. Ten stops, under two minutes.",
    readonly: { text: 'Turnout puts every new version of an app into a Flagsmith experiment, without touching its code. This public page runs real Flagsmith experiments on a demo shop by itself, with simulated shoppers. Under two minutes.' },
  },
  {
    target: '#kinds',
    interactive: true,
    title: 'Pick a test: click one now',
    text: 'A/A puts the same version on both sides: the numbers should match, which proves the split is fair. A/B tests one new version against A; A/B/C tests two at once. Click any of them: it starts straight away.',
    done: (label) =>
      label === 'A/A'
        ? 'A/A started: both sides are A (A and A′, the same shop). Flagsmith should find no difference. Click another kind any time, or Next.'
        : `${label} started: the versions on the right changed at once, each a different shop. Flagsmith compares each new one with A. Next →`,
    readonly: { interactive: false, title: 'The kind of test', text: 'A/A: the same version twice, a check that the split is fair. A/B: one new version against A. A/B/C: two at once. On this public page the autopilot picks the test.' },
  },
  {
    target: '#steps-panel',
    title: 'Four steps, one green button',
    text: 'Start the test, send shoppers, ask Flagsmith, decide. Only the current step has a button, and finished steps keep a one-line result.',
    readonly: { title: 'Four steps, run by the autopilot', text: 'Start the test, send shoppers, ask Flagsmith, decide. Here the autopilot runs each step by itself; the line in the current step says what comes next.' },
  },
  {
    target: '#versions-panel',
    title: 'The versions, and you',
    text: 'A is what everyone gets now; B and C are the new ones. Click a preview to open that version on its own (never counted). The line at the top says which version you got.',
  },
  {
    target: '#results-panel',
    title: 'What Flagsmith measured',
    text: "Orders is the goal. Page load time and server errors are safety checks: a version that sells more but is slower doesn't ship. Every number and call is Flagsmith's own.",
  },
  {
    target: ['#go', '#steps-panel'],
    title: 'The decision',
    text: 'Ship or roll back is one flag change in Flagsmith, not a deploy. Right after it, 50 brand-new shoppers check that everyone really gets the result.',
  },
  {
    target: '#autoplay',
    title: 'Play it for me',
    text: 'Clicks every green button for you through one whole test, in about a minute.',
    readonly: false,
  },
  {
    target: '#menu-versions',
    title: 'Every version of the site',
    text: 'The Versions menu opens each version on its own, and the plain shop link gives you a version the way a real visitor gets one.',
  },
  {
    target: '#menu a[data-page="console"]',
    title: 'The console, for your own app',
    text: "Run turnout compare with your versions: 2 make an A/B test, 3 an A/B/C test. The console shows where you land, live traffic, Flagsmith's results, and Ship or Revert.",
    readonly: false,
  },
  {
    target: '#menu-flagsmith',
    title: 'Sign in to Flagsmith',
    text: 'Everything here lives in Flagsmith. This menu has its address, email and password: sign in to see the same flag, experiment and results there. Now press the green button.',
    readonly: { target: null, title: 'It all lives in Flagsmith', text: "The flag, the split and the results are Flagsmith's. On this public page Flagsmith's dashboard stays private; the numbers you see come straight from its API." },
  },
];

/** The stops for this page: the console's, or server mode's public ones. */
export const stopsFor = (readonly) =>
  STOPS.flatMap((s) => (!readonly ? [s] : s.readonly === false ? [] : [{ ...s, ...(s.readonly ?? {}) }]));

const stops = stopsFor(READONLY);
let tour = null; // { i, block, ring, tip, keys, resize, back, onKind }

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function visible(node) {
  if (!node) return false;
  const r = node.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function targetOf(stop) {
  if (!stop.target) return null;
  for (const sel of [stop.target].flat()) {
    const node = document.querySelector(sel);
    if (visible(node)) return node;
  }
  return null;
}

function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* the tour may open again next time */
  }
}

/** Opens the tour on a first visit only. */
export function offerTour() {
  let seen = false;
  try {
    seen = localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    seen = false;
  }
  if (!seen) startTour();
}

export function startTour(at = 0) {
  closeTour();
  const block = el('div', 'tour-block'); // catches stray clicks so the page doesn't change under the tour
  const ring = el('div', 'tour-ring');
  const tip = el('div', 'tour-tip');
  tip.setAttribute('role', 'dialog');
  tip.setAttribute('aria-modal', 'true');
  tip.setAttribute('aria-labelledby', 'tour-title');
  document.body.append(block, ring, tip);
  const keys = (e) => {
    if (e.key === 'ArrowRight' || e.key === 'Enter') {
      e.preventDefault();
      next();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      show(tour.i - 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeTour();
    }
  };
  const resize = () => tour && place();
  const onKind = (e) => {
    const stop = tour && stops[tour.i];
    if (!stop?.interactive || !stop.done) return;
    const text = tour.tip.querySelector('.tour-text');
    if (text) text.textContent = stop.done(e.detail.label);
    setTimeout(() => tour && place(), 50);
  };
  document.addEventListener('turnout:kind', onKind);
  addEventListener('keydown', keys, true);
  addEventListener('resize', resize);
  tour = { i: 0, block, ring, tip, keys, resize, onKind, back: document.activeElement };
  document.body.classList.add('touring');
  show(at);
}

export function closeTour() {
  if (!tour) return;
  removeEventListener('keydown', tour.keys, true);
  removeEventListener('resize', tour.resize);
  document.removeEventListener('turnout:kind', tour.onKind);
  tour.block.remove();
  tour.ring.remove();
  tour.tip.remove();
  document.body.classList.remove('touring');
  const back = tour.back;
  tour = null;
  markSeen();
  if (back instanceof HTMLElement) back.focus?.();
}

function next() {
  if (!tour) return;
  if (tour.i >= stops.length - 1) closeTour();
  else show(tour.i + 1);
}

function show(i) {
  if (!tour) return;
  tour.i = Math.max(0, Math.min(stops.length - 1, i));
  const stop = stops[tour.i];
  const last = tour.i === stops.length - 1;
  // An interactive stop leaves the page clickable (the picker): the dimmed screen no longer catches clicks.
  tour.block.style.pointerEvents = stop.interactive ? 'none' : '';
  tour.ring.classList.toggle('tour-ring-live', Boolean(stop.interactive));
  const title = el('h3', 'tour-title', stop.title);
  title.id = 'tour-title';
  const back = el('button', 'btn btn-quiet', 'Back');
  back.type = 'button';
  back.disabled = tour.i === 0;
  back.addEventListener('click', () => show(tour.i - 1));
  const skip = el('button', 'btn btn-quiet', last ? '' : 'Skip tour');
  skip.type = 'button';
  skip.hidden = last;
  skip.addEventListener('click', closeTour);
  const go = el('button', 'btn btn-go tour-next');
  go.type = 'button';
  go.append(last ? 'Done' : 'Next', ' ', Object.assign(el('kbd', 'tour-key', '→'), { title: 'or press the → key' }));
  go.addEventListener('click', next);
  const row = el('div', 'tour-row');
  row.append(back, skip, go);
  tour.tip.replaceChildren(el('p', 'tour-count', `${tour.i + 1} of ${stops.length}`), title, el('p', 'tour-text', stop.text), row);
  place();
  go.focus();
}

// The ring hugs the target (a dimmed screen around it); the card sits below it, else above, else beside it.
function place() {
  const { ring, tip } = tour;
  const target = targetOf(stops[tour.i]);
  const vw = innerWidth;
  const vh = innerHeight;
  const gap = 12;
  if (!target) {
    ring.classList.add('tour-ring-none');
    Object.assign(ring.style, { left: `${vw / 2}px`, top: `${vh / 2}px`, width: '0px', height: '0px' });
    tip.style.left = `${Math.round((vw - tip.offsetWidth) / 2)}px`;
    tip.style.top = `${Math.round((vh - tip.offsetHeight) / 2)}px`;
    return;
  }
  ring.classList.remove('tour-ring-none');
  const r = target.getBoundingClientRect();
  const pad = 6;
  Object.assign(ring.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let left;
  let top;
  if (r.bottom + pad + gap + h <= vh - 8) {
    top = r.bottom + pad + gap;
    left = r.left + r.width / 2 - w / 2;
  } else if (r.top - pad - gap - h >= 8) {
    top = r.top - pad - gap - h;
    left = r.left + r.width / 2 - w / 2;
  } else if (r.right + pad + gap + w <= vw - 8) {
    left = r.right + pad + gap;
    top = r.top + r.height / 2 - h / 2;
  } else if (r.left - pad - gap - w >= 8) {
    left = r.left - pad - gap - w;
    top = r.top + r.height / 2 - h / 2;
  } else {
    left = vw / 2 - w / 2;
    top = vh / 2 - h / 2;
  }
  tip.style.left = `${Math.round(Math.max(8, Math.min(vw - w - 8, left)))}px`;
  tip.style.top = `${Math.round(Math.max(8, Math.min(vh - h - 8, top)))}px`;
}
