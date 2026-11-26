// Small motion helpers for judge mode. Pure DOM, no knowledge of the app: each one takes elements, animates them, and
// returns a promise that resolves when the motion is over. Under prefers-reduced-motion (or in a hidden tab, where
// animation frames stop) every helper applies its final state at once and resolves immediately. Nothing here touches
// the DOM at import time, so the module loads in Node for the tests.

/** The page's one easing curve: a quick start and a soft landing. */
export const EASE = 'cubic-bezier(.22,1,.36,1)';

/** True when the viewer asked for less motion. */
export function reducedMotion() {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** No motion at all: reduced motion, or a hidden tab (nothing would be painted, and frames would never come). */
function still() {
  return reducedMotion() || (typeof document !== 'undefined' && document.hidden === true);
}

/** Close to EASE, as a function of t in [0, 1], for the frame-by-frame count-ups. */
const easeOut = (t) => 1 - (1 - t) ** 4;

function cssVar(el, name) {
  try {
    return getComputedStyle(el).getPropertyValue(name).trim();
  } catch {
    return '';
  }
}

/** Waits for a Web Animation, but never longer than its length plus a margin (a hidden tab can stall the timeline). */
function settle(anims, ms) {
  const list = anims.filter(Boolean);
  if (!list.length) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(end, ms + 300);
    Promise.all(list.map((a) => (a.finished ? a.finished.catch(() => {}) : null))).then(end, end);
  });
}

function asList(elements) {
  if (!elements) return [];
  if (typeof elements.length !== 'number' && typeof elements[Symbol.iterator] !== 'function') return [elements];
  return [...elements].filter(Boolean);
}

const counting = new WeakMap(); // element → { value, stop }

/**
 * Counts an element's text from its last value (or `from`, or 0) up or down to `to`.
 * `format(n)` turns the in-between numbers into text; it gets the exact `to` at the end.
 * A second call on the same element takes over from wherever the first one had got to.
 * @param {Element} el
 * @param {number} to
 * @param {{ ms?: number, format?: (n: number) => string, from?: number }} [opts]
 * @returns {Promise<void>}
 */
export function countUp(el, to, { ms = 900, format = (n) => String(Math.round(n)), from } = {}) {
  if (!el) return Promise.resolve();
  const prev = counting.get(el);
  prev?.stop?.();
  const target = Number(to);
  const put = (v) => {
    const text = String(format(v));
    if (el.textContent !== text) el.textContent = text;
  };
  const start = Number.isFinite(from) ? Number(from) : Number.isFinite(prev?.value) ? prev.value : 0;
  if (!Number.isFinite(target) || ms <= 0 || start === target || still() || typeof requestAnimationFrame !== 'function') {
    put(Number.isFinite(target) ? target : to);
    counting.set(el, { value: Number.isFinite(target) ? target : undefined, stop: null });
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const rec = { value: start, stop: null };
    let raf = 0;
    let timer = 0;
    const halt = () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      rec.stop = null;
    };
    const finish = () => {
      halt();
      rec.value = target;
      put(target);
      resolve();
    };
    rec.stop = () => {
      halt(); // taken over by a newer count: leave the number where it is, the next count starts from it
      resolve();
    };
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, Math.max(0, (now - t0) / ms));
      if (t >= 1) return finish();
      rec.value = start + (target - start) * easeOut(t);
      put(rec.value);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    timer = setTimeout(finish, ms + 400); // frames stop in a hidden tab: land on the final number anyway
    counting.set(el, rec);
  });
}

/**
 * Lights elements up one after another: adds `className` to each in turn, holds it, then takes it off again.
 * @param {Iterable<Element> | ArrayLike<Element>} elements
 * @param {{ className?: string, stepMs?: number, holdMs?: number }} [opts]
 * @returns {Promise<void>}
 */
export function sweep(elements, { className = 'is-sweep', stepMs = 120, holdMs } = {}) {
  const list = asList(elements);
  if (!list.length || still()) {
    for (const el of list) el.classList?.remove(className);
    return Promise.resolve();
  }
  const hold = holdMs ?? Math.max(stepMs * 2, 260);
  return new Promise((resolve) => {
    list.forEach((el, i) => {
      setTimeout(() => {
        el.classList.remove(className);
        void el.getBoundingClientRect?.(); // restart the class's animation if it was already on
        el.classList.add(className);
      }, i * stepMs);
      setTimeout(() => {
        el.classList.remove(className);
        if (i === list.length - 1) resolve();
      }, i * stepMs + hold);
    });
  });
}

/**
 * Flashes rows that changed: a warm highlight with an accent edge that fades back to the row's own background.
 * The colour is the element's `--fx-flash`, else `--warn`.
 * @param {Iterable<Element> | ArrayLike<Element>} elements
 * @param {{ ms?: number, stepMs?: number, color?: string }} [opts]
 * @returns {Promise<void>}
 */
export function flashRows(elements, { ms = 1100, stepMs = 80, color } = {}) {
  const list = asList(elements).filter((el) => typeof el.animate === 'function');
  if (!list.length || still()) return Promise.resolve();
  const anims = list.map((el, i) => {
    const c = color || cssVar(el, '--fx-flash') || cssVar(el, '--warn') || '#f59e0b';
    const cs = getComputedStyle(el);
    const hi = `color-mix(in srgb, ${c} 22%, transparent)`;
    const edge = cs.boxShadow === 'none' || !cs.boxShadow;
    const on = edge ? { backgroundColor: hi, boxShadow: `inset 3px 0 0 0 ${c}` } : { backgroundColor: hi };
    const off = edge ? { backgroundColor: cs.backgroundColor, boxShadow: `inset 0 0 0 0 ${c}` } : { backgroundColor: cs.backgroundColor };
    return el.animate([{ ...on, offset: 0 }, { ...on, offset: 0.35 }, { ...off, offset: 1 }], {
      duration: ms,
      delay: i * stepMs,
      easing: 'ease-out',
      fill: 'backwards',
    });
  });
  return settle(anims, ms + list.length * stepMs);
}

/**
 * Grows every bar inside `container` (any element whose inline style sets `--w`, which its CSS turns into a width)
 * from nothing to its value, one after another.
 * @param {Element} container
 * @param {{ ms?: number, stepMs?: number }} [opts]
 * @returns {Promise<void>}
 */
export function grow(container, { ms = 750, stepMs = 60 } = {}) {
  if (!container) return Promise.resolve();
  const all = [container, ...container.querySelectorAll('*')];
  const bars = all.filter((el) => el.style?.getPropertyValue('--w') && typeof el.animate === 'function');
  if (!bars.length || still()) return Promise.resolve();
  const anims = bars.map((el, i) => {
    const width = getComputedStyle(el).width;
    if (!/px$/.test(width)) return null; // not laid out (hidden tab panel): nothing to grow
    return el.animate([{ width: '0px' }, { width }], { duration: ms, delay: i * stepMs, easing: EASE, fill: 'backwards' });
  });
  return settle(anims, ms + bars.length * stepMs);
}

/**
 * Two soft rings around an element ("look here"), with a slight lift when the element has no transform of its own.
 * The colour is the element's `--fx-accent`, else `--treatment`.
 * @param {Element} el
 * @param {{ ms?: number, times?: number, color?: string }} [opts]
 * @returns {Promise<void>}
 */
export function pulse(el, { ms = 700, times = 2, color } = {}) {
  if (!el || typeof el.animate !== 'function' || still()) return Promise.resolve();
  const c = color || cssVar(el, '--fx-accent') || cssVar(el, '--treatment') || '#16a34a';
  const lift = getComputedStyle(el).transform === 'none';
  const frames = [
    { offset: 0, boxShadow: `0 0 0 0 color-mix(in srgb, ${c} 55%, transparent)`, ...(lift ? { transform: 'scale(1)' } : {}) },
    { offset: 0.35, ...(lift ? { transform: 'scale(1.02)' } : {}) },
    { offset: 1, boxShadow: `0 0 0 14px color-mix(in srgb, ${c} 0%, transparent)`, ...(lift ? { transform: 'scale(1)' } : {}) },
  ];
  return settle([el.animate(frames, { duration: ms, iterations: times, easing: 'ease-out' })], ms * times);
}
