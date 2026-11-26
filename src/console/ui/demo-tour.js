// A short guided tour of the judge page: each stop highlights one part of the screen and says what it is, with a
// Next button. Ten stops of a few sentences: under two minutes. It opens by itself on a first visit, and again from
// the Tour button. Every string goes in through textContent.

const SEEN_KEY = 'turnout-demo-tour-seen';

/** The stops, in order. target: a selector, a list (the first one on screen wins), or null for a centred card. */
export const STOPS = [
  {
    target: null,
    title: "Welcome to Turnout's judge mode",
    text: "Turnout puts every new version of an app into a Flagsmith experiment, without touching the app's code. This page runs a real Flagsmith experiment on a demo shop, with simulated shoppers. Ten stops, under two minutes.",
  },
  {
    target: '#kinds',
    title: 'Pick the kind of test',
    text: 'A/B: one new version against the one everyone gets now (A). A/B/C: two new versions at once. A/A: the same version twice, a check that the split is fair. With your own app, two versions make an A/B test, three an A/B/C test, and so on.',
  },
  {
    target: '#steps-panel',
    title: 'Four steps, one green button',
    text: 'Start the test, send shoppers, ask Flagsmith, decide. Only the current step has a button. Finished steps keep a one-line result, so the whole story stays on screen.',
  },
  {
    target: '#versions-panel',
    title: 'The versions',
    text: 'A is what every shopper gets now; B and C are the new ones. Each card shows a live preview, its share of shoppers and, once Flagsmith has counted, how many of them ordered.',
  },
  {
    target: '#results-panel',
    title: 'What Flagsmith measured',
    text: "Orders is the goal. Page load time and server errors are safety checks: a version that sells more but is slower doesn't ship. Every number and every call is Flagsmith's own; Turnout does no statistics.",
  },
  {
    target: ['#go', '#steps-panel'],
    title: 'The one thing to do now',
    text: 'The green button is always the next step. Ship or roll back is one flag change in Flagsmith, not a deploy, and right after it 50 brand-new shoppers check that everyone really gets the result.',
  },
  {
    target: '#autoplay',
    title: 'Play it for me',
    text: 'Clicks every green button for you, through one whole test: about a minute.',
  },
  {
    target: '#history-box',
    title: 'Earlier tests',
    text: "Every decision so far, newest first, from Turnout's release ledger.",
  },
  {
    target: '#link-console',
    title: 'The console, for your own app',
    text: 'Run turnout compare with your versions: URLs, Docker images or git branches. The console shows real visitors on a live traffic map, Flagsmith\'s results, and Ship winner or Revert. This page is the guided demo of the same engine.',
  },
  {
    target: '#link-flagsmith',
    title: 'It all lives in Flagsmith',
    text: "The flag, the experiment, the split and the results are Flagsmith's. Open it to see the same numbers on Flagsmith's own pages. Now press the green button, or Play it for me.",
  },
];

let tour = null; // { i, block, ring, tip, keys, resize, back }

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
  addEventListener('keydown', keys, true);
  addEventListener('resize', resize);
  tour = { i: 0, block, ring, tip, keys, resize, back: document.activeElement };
  document.body.classList.add('touring');
  show(at);
}

export function closeTour() {
  if (!tour) return;
  removeEventListener('keydown', tour.keys, true);
  removeEventListener('resize', tour.resize);
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
  if (tour.i >= STOPS.length - 1) closeTour();
  else show(tour.i + 1);
}

function show(i) {
  if (!tour) return;
  tour.i = Math.max(0, Math.min(STOPS.length - 1, i));
  const stop = STOPS[tour.i];
  const last = tour.i === STOPS.length - 1;
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
  tour.tip.replaceChildren(el('p', 'tour-count', `${tour.i + 1} of ${STOPS.length}`), title, el('p', 'tour-text', stop.text), row);
  place();
  go.focus();
}

// The ring hugs the target (a dimmed screen around it); the card sits below it, else above, else beside it.
function place() {
  const { ring, tip } = tour;
  const target = targetOf(STOPS[tour.i]);
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
