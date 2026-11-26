// The guided tour judge mode and the console share: each stop highlights one part of the screen and says what it
// is. A "click" stop asks you to click the highlighted thing and moves on when you do (the page stays usable under
// it); a plain stop has a Next button. The stops live in tour-stops.js, one list per page. Every string goes in
// through textContent.
//
// A stop: { target, title, text, click?, action?, interactive?, done? }
//   target       a selector, or a list (the first one on screen wins), or null for a centred card
//   text         a string, or a function () => string, read again while the stop is open (a button's label can change)
//   click        a selector: the stop moves on once you click something matching it; until then the card says so
//   action       with click: '#go' — the green button's data-action this stop is about. A stop whose action isn't the
//                page's current one is skipped (the test is further along), and while a step runs the card waits
//   interactive  the page stays clickable, but the stop has a Next button (no click needed)
//   done         (detail) => text: shown after a turnout:kind event while the stop is open

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

const textOf = (stop) => (typeof stop.text === 'function' ? stop.text() : stop.text);

/** The green button's current action ('start', 'visitors', 'score', 'ship'…), or null while none is shown. */
export function currentAction() {
  const go = document.querySelector('#go');
  return go && visible(go) && !go.disabled ? go.dataset.action ?? null : null;
}

/**
 * A tour over `stops`. `seenKey`: the localStorage key that remembers it was shown (offer() opens it once).
 * Returns { start(at), offer(), close(), isOpen() }.
 */
export function createTour({ stops, seenKey }) {
  let tour = null; // { i, block, ring, tip, timer, keys, clicks, onKind, back, shown }

  const markSeen = () => {
    try {
      localStorage.setItem(seenKey, '1');
    } catch {
      /* the tour may open again next time */
    }
  };

  function offer() {
    let seen = false;
    try {
      seen = localStorage.getItem(seenKey) === '1';
    } catch {
      seen = false;
    }
    if (!seen) start();
  }

  function start(at = 0) {
    close();
    const block = el('div', 'tour-block'); // catches stray clicks on plain stops, so the page doesn't change under the tour
    const ring = el('div', 'tour-ring');
    const tip = el('div', 'tour-tip');
    tip.setAttribute('role', 'dialog');
    tip.setAttribute('aria-modal', 'false');
    tip.setAttribute('aria-labelledby', 'tour-title');
    document.body.append(block, ring, tip);
    const keys = (e) => {
      if (!tour) return;
      const stop = stops[tour.i];
      if ((e.key === 'ArrowRight' || (e.key === 'Enter' && !stop.click)) && !e.target.closest?.('input, textarea, select')) {
        e.preventDefault();
        next();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        show(tour.i - 1, -1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    // A click stop moves on once its target is clicked; the click itself still does its job on the page.
    const clicks = (e) => {
      const stop = tour && stops[tour.i];
      if (!stop?.click || !(e.target instanceof Element) || tour.tip.contains(e.target)) return;
      if (e.target.closest(stop.click)) setTimeout(() => tour && stops[tour.i] === stop && next(), 350);
    };
    const onKind = (e) => {
      const stop = tour && stops[tour.i];
      if (!stop?.done) return;
      const node = tour.tip.querySelector('.tour-text');
      if (node) node.textContent = stop.done(e.detail);
      setTimeout(() => tour && place(), 50);
    };
    document.addEventListener('turnout:kind', onKind);
    document.addEventListener('click', clicks, true);
    addEventListener('keydown', keys, true);
    // Targets move and buttons change while a step runs: follow them, and refresh a click stop's wording.
    const timer = setInterval(() => tour && refresh(), 400);
    tour = { i: 0, block, ring, tip, timer, keys, clicks, onKind, back: document.activeElement, shown: '' };
    document.body.classList.add('touring');
    show(at);
  }

  function close() {
    if (!tour) return;
    clearInterval(tour.timer);
    removeEventListener('keydown', tour.keys, true);
    document.removeEventListener('click', tour.clicks, true);
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
    if (tour.i >= stops.length - 1) close();
    else show(tour.i + 1, 1);
  }

  // A click stop about one of the green button's actions is skipped when the page is past that action.
  function skippable(stop) {
    if (!stop.action) return false;
    const now = currentAction();
    if (now === null) return false; // a step is running: wait on this stop
    return ![stop.action].flat().includes(now) && stops.some((s, j) => j > tour.i && s.action && [s.action].flat().includes(now));
  }

  function show(i, dir = 1) {
    if (!tour) return;
    tour.i = Math.max(0, Math.min(stops.length - 1, i));
    while (dir > 0 && skippable(stops[tour.i]) && tour.i < stops.length - 1) tour.i++;
    render();
  }

  // What the card says right now: a click stop waits while a step runs (no green button on screen yet).
  function wording(stop) {
    if (stop.click && stop.action && currentAction() === null) return 'A step is running. Wait for it to finish: its green button comes next.';
    return textOf(stop);
  }

  function render() {
    const stop = stops[tour.i];
    const last = tour.i === stops.length - 1;
    const clickable = Boolean(stop.click || stop.interactive);
    // A click or interactive stop leaves the page usable: the dimmed screen no longer catches clicks.
    tour.block.style.pointerEvents = clickable ? 'none' : '';
    tour.ring.classList.toggle('tour-ring-live', clickable);
    const title = el('h3', 'tour-title', stop.title);
    title.id = 'tour-title';
    const back = el('button', 'btn btn-quiet', 'Back');
    back.type = 'button';
    back.disabled = tour.i === 0;
    back.addEventListener('click', () => show(tour.i - 1, -1));
    const skip = el('button', 'btn btn-quiet', last ? '' : 'End tour');
    skip.type = 'button';
    skip.hidden = last;
    skip.addEventListener('click', close);
    const row = el('div', 'tour-row');
    row.append(back, skip);
    if (stop.click) {
      // No Next: you click the highlighted thing. "Skip this" moves on without it.
      const pass = el('button', 'btn btn-quiet tour-pass', 'Skip this →');
      pass.type = 'button';
      pass.addEventListener('click', next);
      row.append(el('span', 'tour-cue', '👆 Click the highlighted button'), pass);
    } else {
      const go = el('button', 'btn btn-go tour-next');
      go.type = 'button';
      go.append(last ? 'Done' : 'Next', ' ', Object.assign(el('kbd', 'tour-key', '→'), { title: 'or press the → key' }));
      go.addEventListener('click', next);
      row.append(go);
    }
    tour.shown = wording(stop);
    tour.tip.dataset.click = String(Boolean(stop.click));
    tour.tip.replaceChildren(el('p', 'tour-count', `${tour.i + 1} of ${stops.length}`), title, el('p', 'tour-text', tour.shown), row);
    place();
    (tour.tip.querySelector('.tour-next') ?? tour.tip.querySelector('.tour-pass'))?.focus({ preventScroll: true });
  }

  function refresh() {
    const stop = stops[tour.i];
    if (skippable(stop)) return show(tour.i + 1, 1);
    const now = wording(stop);
    if (now !== tour.shown) {
      tour.shown = now;
      const node = tour.tip.querySelector('.tour-text');
      if (node) node.textContent = now;
    }
    place();
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
      left = vw - w - 16;
      top = vh - h - 16;
    }
    tip.style.left = `${Math.round(Math.max(8, Math.min(vw - w - 8, left)))}px`;
    tip.style.top = `${Math.round(Math.max(8, Math.min(vh - h - 8, top)))}px`;
  }

  return { start, offer, close, isOpen: () => tour !== null };
}
