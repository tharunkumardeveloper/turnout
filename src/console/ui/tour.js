// The judge tour: a spotlight on the one thing to look at or click, and a bubble that explains it. Every beat plays
// in two phases. SHOW: the spotlight glides to the target, the page runs a short demo animation on it, and the bubble
// is a compact "Look here" + title. EXPLAIN: the bubble opens to the full text and controls. Between beats the bubble
// morphs (position, width, height) and its content cross-fades; it never fades out and back in.
//
// Two modes: "Guide me" (the judge reads and clicks) and "Play it for me" (autoplay: a timer advances, the cursor
// glides to the button and clicks it). A third, "watch", is for server mode's public, read-only view: narration only,
// following the steps the autopilot runs (no clicks, no Flagsmith links). The script lives in tour-plan.js; judge.js tells the tour about every state
// change through update(). Every string goes into the DOM through textContent.
import * as P from './tour-plan.js';
import { autopilotLine, coachLine, JOB_STEP, actionText, formatInt } from './judge-format.js';

const PAD = 10; // the spotlight's margin around its target
const GAP = 18; // between the spotlight and the bubble
const EDGE = 16; // the bubble's margin from the viewport edge
const SHEET_BELOW = 640; // narrower than this: the bubble is a bottom sheet
const W_COMPACT = 300;
const SHOW_CAP_MS = 2300; // the SHOW phase never lasts longer than this
const FLAGSMITH_TAB = 'turnout-flagsmith';
const NS = 'http://www.w3.org/2000/svg';

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'on') for (const [name, fn] of Object.entries(v)) node.addEventListener(name, fn);
    else if (k.startsWith('data-') || k.startsWith('aria-') || k === 'role' || k === 'tabindex') node.setAttribute(k, v === true ? '' : String(v));
    else node[k] = v;
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

/** A small inline SVG icon from path data (stroked, currentColor). */
function icon(d, size = 14) {
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: String(size), height: String(size), 'aria-hidden': 'true', focusable: 'false', class: 'tour-icon' })) svg.setAttribute(k, v);
  for (const part of d.split('|')) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', part);
    svg.append(p);
  }
  return svg;
}
const ICON = {
  pause: 'M9 5v14|M15 5v14',
  play: 'M7 5l12 7-12 7z',
  close: 'M6 6l12 12|M18 6L6 18',
  out: 'M14 4h6v6|M20 4l-9 9|M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Where the bubble goes beside its target (right, then left, below, above; the side it had stays while it fits),
 * never over it unless nothing else fits. Pure: sizes in, { side, x, y } out.
 *   target   the spotlight's rect { x, y, w, h }, or null for a centred card
 *   bw, bh   the bubble's size now; fw, fh the open bubble's size (a side is chosen so it still fits once open)
 *   compactH the compact bubble's height; minY the top edge below the app bar; prefer the side it had
 */
export function bubbleSpot({ target: r, vw, vh, minY, compact, bw, bh, fw, fh, compactH, prefer = null }) {
  // Room for the open bubble below wherever the compact one sits, so opening only grows it down.
  const yh = compact ? fh : bh;
  const clampX = (x) => Math.max(EDGE, Math.min(x, vw - bw - EDGE));
  const clampY = (y) => Math.max(minY, Math.min(y, vh - yh - EDGE));
  if (!r) return { side: 'center', x: clampX((vw - bw) / 2), y: clampY(Math.max(minY, (vh - bh) / 2)) };
  const fits = {
    right: () => r.x + r.w + GAP + fw <= vw - EDGE,
    left: () => r.x - GAP - fw >= EDGE,
    below: () => r.y + r.h + GAP + fh <= vh - EDGE,
    above: () => r.y - GAP - fh >= minY,
  };
  const order = [...new Set([prefer, 'right', 'left', 'below', 'above'])].filter((s) => s && fits[s]);
  const side = order.find((s) => fits[s]()) ?? 'overlap';
  // Beside the target, the bubble's top sits where the compact bubble is centred on it, compact or open. Centring
  // at the open bubble's height made the compact one ride up over whatever sits above a small target (the stage's
  // heading above its button); clampY still keeps room below for the open bubble.
  const midY = clampY(r.y + Math.min(r.h, vh) / 2 - compactH / 2);
  const midX = clampX(r.x + r.w / 2 - bw / 2);
  let x;
  let y;
  if (side === 'right') [x, y] = [r.x + r.w + GAP, midY];
  else if (side === 'left') [x, y] = [r.x - GAP - bw, midY];
  else if (side === 'below') [x, y] = [midX, r.y + r.h + GAP];
  else if (side === 'above') [x, y] = [midX, r.y - GAP - yh];
  else {
    // The target fills the screen (a frame): the bubble takes the corner with the most room.
    x = vw - r.x - r.w >= r.x ? vw - bw - EDGE : EDGE;
    y = vh - yh - EDGE;
  }
  return { side, x: clampX(x), y: clampY(y) };
}

/**
 * app: {
 *   state(): the latest /api/judge/state body
 *   showTab(id): switches the page's tab; resolves when it's shown
 *   loadShop(mode): 'reload' | 'preview'
 *   signin(): Promise<{ email, password?, dashboardUrl }>
 *   unhealthy(): Promise<boolean | null>   Flagsmith Feature Health shows the flag Unhealthy (null: not reported here)
 *   recommended(state): 'ship' | 'revert' | 'keep-running'
 *   run(action): starts a judge job ("Start over", the restart beat)
 *   onChange(active, mode): the page shows or hides its welcome overlay
 *   demo(name, targetEl): Promise<void>  the SHOW animation (<= 2 s; immediate under reduced motion)
 *   openWelcome(): shows the welcome overlay (for the next judge)
 * }
 */
export function createTour(app) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  // ---- the elements ---------------------------------------------------------------------------------------------

  const blocks = ['top', 'bottom', 'left', 'right'].map((side) => h('div', { class: `tour-block tour-block-${side}` }));
  const hole = h('div', { class: 'tour-hole', 'aria-hidden': 'true' });
  const arrow = h('div', { class: 'tour-arrow', 'aria-hidden': 'true' });
  const cursor = h('div', { class: 'tour-cursor', 'aria-hidden': 'true' });
  const pointer = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '26', height: '26' })) pointer.setAttribute(k, v);
  const tip = document.createElementNS(NS, 'path');
  tip.setAttribute('d', 'M4 2l15 11-6.5 1.2L16 21l-3 1.4-3-6.6L5 20z');
  pointer.append(tip);
  cursor.append(pointer);

  // Progress reads by chapter ("Results", "Decision") with a segmented bar; the beat count is for screen readers only,
  // so an estimate that grows mid-tour never shows.
  const chap = h('span', { class: 'tour-chapter' });
  const count = h('span', { class: 'tour-count sr-only' });
  const segs = h('div', { class: 'tour-segs', 'aria-hidden': 'true' });
  const guideBtn = h('button', { type: 'button', class: 'tour-mode-btn', 'data-mode': 'guide' }, 'Guide me');
  const autoBtn = h('button', { type: 'button', class: 'tour-mode-btn', 'data-mode': 'auto' }, 'Play it for me');
  const modeGroup = h('div', { class: 'tour-mode', role: 'group', 'aria-label': 'Tour mode' }, guideBtn, autoBtn);
  const pauseIcon = h('span', { class: 'tour-pause-icon' });
  const pauseText = h('span', { class: 'tour-ctl-text' }, 'Pause');
  const pauseBtn = h('button', { type: 'button', class: 'tour-ctl tour-pause', 'aria-pressed': 'false', title: 'Pause or resume (Space)' }, pauseIcon, pauseText);
  const exitBtn = h('button', { type: 'button', class: 'tour-ctl tour-exit', 'aria-label': 'Exit the tour', title: 'Exit the tour (Esc)' }, icon(ICON.close), h('span', { class: 'tour-ctl-text' }, 'Exit'));
  const head = h(
    'div',
    { class: 'tour-head tour-more' },
    h('div', { class: 'tour-head-row' }, modeGroup, pauseBtn, exitBtn),
    h('div', { class: 'tour-progress' }, chap, count, segs),
  );
  const look = h('span', { class: 'tour-look' }, h('span', { class: 'tour-look-dot', 'aria-hidden': 'true' }), 'Look here');
  const title = h('h2', { class: 'tour-title', id: 'tour-title' });
  const tag = h('span', { class: 'tour-tag tour-more' }, h('span', { class: 'tour-tag-dot', 'aria-hidden': 'true' }), "Read from Flagsmith's API");
  const body = h('p', { class: 'tour-body tour-more' });
  const extra = h('div', { class: 'tour-extra tour-more' });
  const workText = h('span', { class: 'tour-work-text' });
  const workCount = h('span', { class: 'tour-work-count' });
  const workFill = h('span', { class: 'tour-mini-fill' });
  const work = h(
    'div',
    { class: 'tour-work tour-more', hidden: true },
    h('div', { class: 'tour-work-line' }, h('span', { class: 'tour-spin', 'aria-hidden': 'true' }), workText, workCount),
    h('div', { class: 'tour-mini', role: 'progressbar', 'aria-label': 'Step progress', 'aria-valuemin': '0', 'aria-valuemax': '100' }, workFill),
  );
  const status = h('p', { class: 'tour-status tour-more', role: 'status', 'aria-live': 'polite' });
  const timerFill = h('span');
  const timer = h('div', { class: 'tour-timer', 'aria-hidden': 'true' }, timerFill);
  const keys = h('span', { class: 'tour-keys', 'aria-hidden': 'true' });
  const quitBtn = h('button', { type: 'button', class: 'btn tour-quit', hidden: true }, 'Exit tour');
  const nextBtn = h('button', { type: 'button', class: 'btn btn-primary tour-next' }, 'Next');
  const foot = h('div', { class: 'tour-foot tour-more' }, timer, keys, quitBtn, nextBtn);
  const inner = h('div', { class: 'tour-inner' }, head, h('div', { class: 'tour-lead' }, look, title), tag, body, extra, work, status, foot);
  const bubble = h('section', { class: 'tour-bubble', role: 'dialog', 'aria-labelledby': 'tour-title', 'aria-modal': 'false', tabindex: '-1', 'data-size': 'compact' }, inner);
  const root = h('div', { class: 'tour', hidden: true }, ...blocks, hole, arrow, cursor, bubble);
  document.body.append(root);

  const t = {
    active: false,
    mode: 'guide',
    paused: false,
    beat: null,
    phase: 'idle', // 'show' | 'read' | 'armed' | 'working' | 'after' | 'failed' | 'waiting'
    queue: [],
    shown: 0,
    total: 0,
    jobId: null,
    jobAction: null,
    outroDone: false,
    target: null,
    side: null, // where the bubble sits beside the target; kept while it still fits
    fullH: 240, // the open bubble's last height, for choosing a side before it opens
    compactH: 80, // the compact bubble's last height: beside the target, the bubble is placed level with it
    timer: null, // { ms, spent, last, done }
    timerRaf: 0,
    raf: 0,
    clickTimer: 0,
    skipShow: null,
    hovered: null,
    cursorAt: null,
    fsWin: null,
    seq: 0, // bumps on every beat, so stale async work gives up
    run: 0, // bumps on every start and end: a whole tour's async work (the Feature Health wait) gives up
    targetSel: null, // the selector the target came from: a re-rendered target is looked up again
    lastRect: null, // the last rect a connected target had, so the spotlight never jumps to the corner
    pressing: false, // autoplay is gliding to a button and will press it
    healthWait: null, // Promise<boolean>: Flagsmith's Feature Health shows the flag Unhealthy
    notes: [], // what each decision this tour watched was based on, for the closing beat
    jobNote: '',
    flavor: 'quick', // 'quick' (one loop) or 'full' (both releases, the map and the setup check)
    signinShown: false, // the Flagsmith sign-in was shown once, after the first Flagsmith link
    afterFor: null, // the watch tour: the job whose after-beats were queued
  };

  // ---- placement: the hole, the four blockers around it, the bubble and its arrow --------------------------------

  const sheet = () => innerWidth < SHEET_BELOW;
  // 380 up to 1600 px: wide enough to read, narrow enough to sit beside the centre column instead of over it.
  const fullWidth = () => (innerWidth >= 1600 ? 420 : 380);

  function headerBottom() {
    const bar = document.querySelector('header');
    if (!bar) return 0;
    const r = bar.getBoundingClientRect();
    const pos = getComputedStyle(bar).position;
    return pos === 'sticky' || pos === 'fixed' ? Math.max(0, r.bottom) : 0;
  }

  function rectOf(el) {
    const vw = innerWidth;
    const vh = innerHeight;
    if (!el) return { x: vw / 2, y: vh / 2, w: 0, h: 0 };
    const r = el.getBoundingClientRect();
    // Whole pixels: fractional edges leave hairline seams between the four shade blocks.
    const x = Math.round(Math.max(4, r.left - PAD));
    const y = Math.round(Math.max(4, r.top - PAD));
    return { x, y, w: Math.max(0, Math.round(Math.min(vw - 4, r.right + PAD)) - x), h: Math.max(0, Math.round(Math.min(vh - 4, r.bottom + PAD)) - y) };
  }

  /** The target, looked up again when the page re-rendered it (a removed element measures as 0×0 at the corner). */
  function liveTarget() {
    if (t.target && !t.target.isConnected && t.targetSel) {
      const again = document.querySelector(t.targetSel);
      if (again && again.getClientRects().length) t.target = again;
    }
    return t.target;
  }

  let lastSig = '';
  function place() {
    if (!t.active) return;
    const el = liveTarget();
    let r;
    if (el && (!el.isConnected || !el.getClientRects().length) && t.lastRect) r = t.lastRect;
    else {
      r = rectOf(el);
      if (el) t.lastRect = r;
    }
    const sig = [r.x, r.y, r.w, r.h, innerWidth, innerHeight, inner.offsetHeight, inner.offsetWidth].map(Math.round).join(',');
    if (sig !== lastSig) {
      lastSig = sig;
      const [top, bottom, left, right] = blocks;
      Object.assign(top.style, { left: '0px', top: '0px', width: '100vw', height: `${r.y}px` });
      Object.assign(bottom.style, { left: '0px', top: `${r.y + r.h}px`, width: '100vw', height: `${Math.max(0, innerHeight - r.y - r.h)}px` });
      Object.assign(left.style, { left: '0px', top: `${r.y}px`, width: `${r.x}px`, height: `${r.h}px` });
      Object.assign(right.style, { left: `${r.x + r.w}px`, top: `${r.y}px`, width: `${Math.max(0, innerWidth - r.x - r.w)}px`, height: `${r.h}px` });
      Object.assign(hole.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      hole.hidden = !t.target;
      syncHeight();
      placeBubble(r);
    }
    t.raf = requestAnimationFrame(place);
  }

  /** The bubble beside the target (right, then left, below, above), never over it unless nothing else fits. */
  function placeBubble(r) {
    const vw = innerWidth;
    const vh = innerHeight;
    if (sheet()) {
      bubble.dataset.dock = 'sheet';
      bubble.style.left = bubble.style.top = '';
      arrow.hidden = true;
      return;
    }
    const compact = bubble.dataset.size === 'compact';
    const bw = compact ? W_COMPACT : fullWidth();
    const bh = Math.min(inner.offsetHeight + 2, vh - 2 * EDGE);
    const { side, x, y } = bubbleSpot({
      target: t.target ? r : null,
      vw,
      vh,
      minY: Math.max(EDGE, headerBottom() + 8),
      compact,
      bw,
      bh,
      fw: fullWidth(),
      fh: Math.min(Math.max(bh, t.fullH), vh - 2 * EDGE),
      compactH: t.compactH,
      prefer: t.side,
    });
    if (side !== 'overlap' && side !== 'center') t.side = side;
    bubble.dataset.dock = side === 'overlap' ? 'corner' : 'float';
    bubble.style.left = `${Math.round(x)}px`;
    bubble.style.top = `${Math.round(y)}px`;
    placeArrow(side, r, x, y, bw, bh);
  }

  function placeArrow(side, r, x, y, bw, bh) {
    const cy = Math.max(y + 18, Math.min(r.y + Math.min(r.h, innerHeight - r.y) / 2, y + bh - 18));
    const cx = Math.max(x + 18, Math.min(r.x + r.w / 2, x + bw - 18));
    const at = { right: [x, cy], left: [x + bw, cy], below: [cx, y], above: [cx, y + bh] }[side];
    arrow.hidden = !at;
    if (!at) return;
    arrow.dataset.side = side;
    arrow.style.left = `${Math.round(at[0] - 7)}px`;
    arrow.style.top = `${Math.round(at[1] - 7)}px`;
  }

  /** The bubble's height follows its content, so every change of content animates as a resize. */
  function syncHeight() {
    const max = sheet() ? Math.round(innerHeight * 0.6) : innerHeight - 2 * EDGE;
    const want = inner.offsetHeight + 2;
    if (bubble.dataset.size === 'full') t.fullH = want;
    else t.compactH = want;
    bubble.style.height = `${Math.min(want, max)}px`;
    bubble.classList.toggle('is-scroll', want > max);
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => t.active && syncHeight()).observe(inner);

  let growTimer = 0;
  function setSize(size) {
    const growing = size === 'full' && bubble.dataset.size === 'compact' && bubble.classList.contains('is-in');
    bubble.dataset.size = size;
    if (size === 'compact') bubble.scrollTop = 0;
    clearTimeout(growTimer);
    // While the bubble widens, the new text waits: it fades in once the bubble has its final size.
    inner.classList.toggle('is-grow', growing && !reduced.matches && !sheet());
    if (growing) growTimer = setTimeout(() => inner.classList.remove('is-grow'), 160); // short: a long wait reads as an empty card
    if (sheet()) {
      bubble.style.width = inner.style.width = '';
      return;
    }
    const w = size === 'compact' ? W_COMPACT : fullWidth();
    bubble.style.width = `${w}px`;
    inner.style.width = `${w - 2}px`; // the content takes its final width at once; the bubble's clip grows to it
    syncHeight();
  }

  async function findTarget(selector, ms = 4000) {
    if (!selector) return null;
    const until = performance.now() + ms;
    for (;;) {
      const el = document.querySelector(selector);
      if (el && el.getClientRects().length) return el;
      if (performance.now() > until) return null;
      await wait(120);
    }
  }

  /** Scrolls the target into the room the app bar and the sheet leave; resolves once it's there. */
  async function ensureVisible(el) {
    if (!el) return;
    // A card inside a sticky column with its own scroll (the steps, the Flagsmith column): scroll that column first.
    const box = el.closest('.col-left, .fs-panel');
    const sticky = !!box && getComputedStyle(box).position === 'sticky';
    if (box && box !== el && box.scrollHeight > box.clientHeight + 1) {
      const br = box.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      let top = box.scrollTop;
      if (er.top < br.top) top += er.top - br.top - 8;
      else if (er.bottom > br.bottom) top += Math.min(er.bottom - br.bottom + 8, er.top - br.top - 8);
      if (top !== box.scrollTop) {
        box.scrollTo({ top: Math.max(0, top), behavior: reduced.matches ? 'auto' : 'smooth' });
        if (!reduced.matches) await wait(380);
      }
    }
    const r = el.getBoundingClientRect();
    const topRoom = headerBottom() + 16;
    const bottomRoom = innerHeight - (sheet() ? Math.min(innerHeight * 0.6, 360) : 0) - 16;
    if (r.top >= topRoom && r.bottom <= bottomRoom) return;
    // A sticky column already sits in view: scrolling the page under it only moves the rest away.
    if (sticky && r.top >= topRoom - 16 && r.top < bottomRoom) return;
    const room = bottomRoom - topRoom;
    const offset = r.height >= room ? topRoom : topRoom + (room - r.height) / 2;
    window.scrollTo({ top: Math.max(0, scrollY + r.top - offset), behavior: reduced.matches ? 'auto' : 'smooth' });
    if (!reduced.matches) await wait(480);
  }

  // ---- the bubble's contents ------------------------------------------------------------------------------------

  /** Cross-fades the bubble's content while it changes; the bubble itself stays and morphs. */
  async function swap(fn) {
    if (!bubble.classList.contains('is-in') || reduced.matches) return fn();
    const seq = t.seq;
    inner.classList.add('is-swap');
    await wait(140);
    // A newer beat (or an exit) took over during the fade: its own swap draws the content.
    if (seq === t.seq && t.active) fn();
    const show = () => inner.classList.remove('is-swap');
    requestAnimationFrame(show);
    setTimeout(show, 60); // frames pause in a background tab: never leave the content invisible
    // Safety net: a fade-in that stalled (a paused compositor, a tab switch mid-fade) is cancelled, which lands the
    // content on full opacity.
    setTimeout(() => {
      if (inner.classList.contains('is-swap')) return;
      inner.style.transition = 'none';
      void inner.offsetWidth;
      inner.style.transition = '';
    }, 420);
  }

  function setPhase(phase) {
    t.phase = phase;
    root.dataset.phase = phase;
    bubble.dataset.phase = phase;
  }

  function setStatus(text, tone = '') {
    if (status.textContent !== text) status.textContent = text;
    status.dataset.tone = tone;
  }

  function renderHeader() {
    const s = app.state();
    let rest = P.remainingBeats(s, t.flavor);
    if (t.outroDone) rest = 0;
    else if (t.beat?.action && !t.beat.bubbleAction && t.phase !== 'after') rest -= 1; // this click is counted in `shown`
    // Never shrink the bar's length mid-tour; only the filled part moves.
    const total = Math.max(t.shown, t.shown + t.queue.length + Math.max(0, rest), t.outroDone ? 0 : t.total);
    t.total = total;
    chap.textContent = P.chapter(t.beat);
    count.textContent = `, part ${t.shown} of about ${total}`;
    const n = Math.min(total, 36);
    if (segs.childElementCount !== n) segs.replaceChildren(...Array.from({ length: n }, () => h('span', { class: 'tour-seg' })));
    const at = Math.max(1, Math.round((t.shown / total) * n));
    [...segs.children].forEach((seg, i) => {
      /** @type {HTMLElement} */ (seg).dataset.s = i < at - 1 ? 'done' : i === at - 1 ? 'current' : 'todo';
    });
  }

  function renderMode() {
    guideBtn.setAttribute('aria-pressed', String(t.mode === 'guide'));
    autoBtn.setAttribute('aria-pressed', String(t.mode === 'auto'));
    pauseBtn.hidden = t.mode === 'guide';
    modeGroup.hidden = t.mode === 'watch';
    pauseBtn.setAttribute('aria-pressed', String(t.paused));
    pauseIcon.replaceChildren(icon(t.paused ? ICON.play : ICON.pause, 13));
    pauseText.textContent = t.paused ? 'Resume' : 'Pause';
    root.dataset.mode = t.mode;
    root.dataset.paused = String(t.paused);
  }

  function renderFoot() {
    const b = t.beat;
    const p = t.phase;
    const auto = t.mode !== 'guide';
    nextBtn.hidden = !(p === 'read' || (p === 'armed' && auto) || p === 'failed');
    const label = p === 'failed' ? 'Try again' : p === 'armed' ? 'Click it now' : b?.last ? 'Finish' : 'Next';
    // Next and Finish show the key that does the same: → on the keyboard.
    nextBtn.replaceChildren(label, ...(label === 'Next' || label === 'Finish' ? [h('kbd', { class: 'tour-key', 'aria-hidden': 'true' }, '→')] : []));
    nextBtn.setAttribute('aria-keyshortcuts', 'ArrowRight Enter');
    timer.hidden = !(auto && ((p === 'read' && !b?.last) || p === 'armed'));
    quitBtn.hidden = p !== 'failed';
    keys.textContent = p === 'failed' ? '' : auto ? (t.paused ? 'Paused · Space resumes' : 'Space pauses · → skips') : p === 'read' ? '→ or Enter for next' : '';
    keys.hidden = !keys.textContent;
    foot.hidden = nextBtn.hidden && timer.hidden && quitBtn.hidden && keys.hidden;
  }

  function openFlagsmith(url) {
    // One named tab, reused at every step: autoplay may move it on later.
    t.fsWin = window.open(url, FLAGSMITH_TAB);
    if (!t.signinShown) showSignin();
  }

  // The Flagsmith sign-in, in the bubble, the first time the judge opens a Flagsmith link (no beat of its own).
  function showSignin() {
    t.signinShown = true;
    const seq = t.seq;
    app.signin().then(
      (login) => {
        if (seq !== t.seq || !login?.email) return;
        const copy = (label, value) =>
          h(
            'div',
            { class: 'tour-cred' },
            h('span', { class: 'tour-cred-label' }, label),
            h('code', {}, value),
            h('button', { type: 'button', class: 'tour-link', on: { click: (ev) => { navigator.clipboard?.writeText(value); ev.target.textContent = 'Copied'; } } }, 'Copy'),
          );
        extra.prepend(
          h(
            'div',
            { class: 'tour-creds' },
            h('p', { class: 'tour-fs-note' }, 'Sign in to Flagsmith once in that tab, then come back here.'),
            copy('Email', login.email),
            login.password ? copy('Password', login.password) : h('p', { class: 'tour-fs-note' }, 'Password: FLAGSMITH_ADMIN_PASSWORD in the .env file.'),
          ),
        );
        syncHeight();
      },
      () => {},
    );
  }

  // The quick tour's "Play round two": carry on as the full tour from where the demo is.
  function playOn() {
    if (!t.active) return;
    t.flavor = 'full';
    t.outroDone = false;
    t.queue = [];
    stopTimer();
    next();
  }

  function renderExtra(b) {
    const parts = [];
    tag.hidden = !(typeof b.target === 'string' && b.target.startsWith('#fs-'));
    if (b.flagsmith && t.mode !== 'watch') {
      const reuse = t.fsWin && !t.fsWin.closed;
      let steered = false;
      // Autoplay moves a Flagsmith tab the judge already opened along with the story.
      if (t.mode === 'auto' && reuse) {
        try {
          t.fsWin.location.href = b.flagsmith.url;
          steered = true;
        } catch {
          // the tab went somewhere we can't steer: the button still works
        }
      }
      const inPage = !tag.hidden;
      const note = steered ? 'Your Flagsmith tab now shows this too.' : reuse ? 'Opens in your Flagsmith tab.' : inPage ? 'Shown here from the API; also in Flagsmith itself, in a new tab.' : 'Opens Flagsmith in a new tab; come back here after.';
      parts.push(
        h(
          'div',
          { class: 'tour-fs' },
          h('button', { type: 'button', class: 'btn tour-fs-btn', on: { click: () => openFlagsmith(b.flagsmith.url) } }, b.flagsmith.label, icon(ICON.out, 13)),
          h('span', { class: 'tour-fs-note' }, note),
        ),
      );
    }
    if (b.bubbleAction) {
      parts.push(h('div', { class: 'tour-fs' }, h('button', { type: 'button', id: 'tour-action', class: 'btn btn-primary tour-action', on: { click: () => app.run(b.action) } }, b.bubbleAction)));
    }
    if (b.skippable && t.mode === 'guide') {
      const skip = h(
        'button',
        {
          type: 'button',
          class: 'tour-link',
          on: {
            click: () => {
              if (!t.active || t.beat !== b || !['armed', 'read', 'failed'].includes(t.phase)) return;
              skip.disabled = true;
              next();
            },
          },
        },
        'Skip: carry on from where the demo is',
      );
      parts.push(skip);
    }
    if (b.more && t.flavor === 'quick' && t.mode !== 'watch') {
      parts.push(
        h(
          'div',
          { class: 'tour-fs' },
          h('button', { type: 'button', class: 'btn tour-fs-btn', on: { click: playOn } }, 'Play round two (about 4 min)'),
          h('span', { class: 'tour-fs-note' }, 'Or carry on: the quick tour ends here.'),
        ),
      );
    }
    if (b.last && t.mode !== 'watch') {
      parts.push(
        h(
          'div',
          { class: 'tour-fs' },
          h(
            'button',
            {
              type: 'button',
              class: 'btn tour-fs-btn',
              on: {
                click: () => {
                  end();
                  app.run('reset');
                  app.openWelcome?.();
                },
              },
            },
            'Start over for the next judge',
          ),
        ),
      );
    }
    extra.replaceChildren(...parts);
  }

  // ---- the cursor ------------------------------------------------------------------------------------------------

  function cursorTo(x, y, instant = false) {
    if (instant) cursor.style.transition = 'none';
    cursor.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    t.cursorAt = { x, y };
    if (instant) {
      void cursor.offsetWidth;
      cursor.style.transition = '';
    }
  }

  function cursorOff() {
    cursor.classList.remove('is-on', 'is-click');
    t.cursorAt = null;
  }

  function unhover() {
    t.hovered?.classList.remove('tour-hover', 'tour-pressed');
    t.hovered = null;
  }

  /** SHOW for a button: the cursor glides from the bubble onto it and hovers it. */
  async function hoverDemo(btn, seq) {
    if (!btn) return;
    if (!t.cursorAt) {
      const from = bubble.getBoundingClientRect();
      cursorTo(from.left + 36, from.top + 22, true);
    }
    cursor.classList.add('is-on');
    await wait(40);
    if (seq !== t.seq) return;
    const r = btn.getBoundingClientRect();
    cursorTo(r.left + Math.min(r.width / 2, 64), r.top + r.height / 2);
    await wait(reduced.matches ? 0 : 950);
    if (seq !== t.seq) return;
    unhover();
    btn.classList.add('tour-hover');
    t.hovered = btn;
  }

  // ---- the beat's life ------------------------------------------------------------------------------------------

  async function runDemo(b, el) {
    if (!b.demo || !el) return;
    if (typeof app.demo !== 'function') return wait(reduced.matches ? 0 : 1200);
    try {
      await Promise.race([Promise.resolve().then(() => app.demo(b.demo, el)), wait(2200)]);
    } catch {
      await wait(reduced.matches ? 0 : 1200);
    }
  }

  async function show(b) {
    const seq = ++t.seq;
    t.beat = b;
    // The public page's tours open or close the full view for the beats that need it (judge.js listens).
    if (typeof b.details === 'boolean') document.dispatchEvent(new CustomEvent('turnout:details', { detail: b.details }));
    t.shown += 1;
    t.skipShow = null;
    setPhase('show');
    stopTimer();
    clearTimeout(t.clickTimer);
    t.pressing = false;
    unhover();
    if (!b.action) cursorOff();
    const first = !bubble.classList.contains('is-in');
    // Flagsmith's Feature Health reports on its own tick: say so until it has, and drop the beat if it never does.
    const health = b.id.startsWith('health:');
    await swap(() => {
      setSize('compact');
      title.textContent = health ? 'Waiting for Flagsmith Feature Health…' : b.title;
      body.textContent = b.body;
      work.hidden = true;
      setStatus('');
      renderHeader();
      renderExtra(b);
      renderFoot();
    });
    if (first) requestAnimationFrame(() => bubble.classList.add('is-in'));
    await app.showTab(b.tab);
    if (seq !== t.seq) return;
    if (b.shop) app.loadShop(b.shop);
    const el = await findTarget(b.target);
    if (seq !== t.seq) return;
    if (el !== t.target) t.side = null;
    t.target = el;
    t.targetSel = b.target ?? null;
    await ensureVisible(el);
    if (seq !== t.seq) return;
    if (health) {
      const ok = await (t.healthWait ?? Promise.resolve(false));
      if (seq !== t.seq) return;
      if (!ok) {
        t.shown -= 1;
        return next();
      }
      title.textContent = b.title;
    }

    // SHOW: the page demonstrates the target while the bubble only says where to look.
    const btn = b.action && !b.bubbleAction ? el : null;
    const min = reduced.matches ? 700 : P.showMs(b);
    const shown = Promise.all([wait(min), runDemo(b, el), hoverDemo(btn, seq)]);
    await Promise.race([shown, wait(Math.max(min, SHOW_CAP_MS)), new Promise((r) => (t.skipShow = r))]);
    t.skipShow = null;
    if (seq !== t.seq || t.phase !== 'show') return;

    // EXPLAIN: the bubble opens to the full text.
    setSize('full');
    if (b.watchJob) {
      // A step the autopilot runs: its live stages here; the next beat comes when it ends.
      setPhase('waiting');
      const job = app.state()?.job;
      if (job?.status !== 'running') return next();
      work.hidden = false;
      renderWork(job);
      setStatus('Running by itself: nothing to click.');
      renderFoot();
      return;
    }
    if (b.watchIdle) {
      // Between steps: the status line counts down to the autopilot's next one; update() moves on when it starts.
      setPhase('waiting');
      setStatus(autopilotLine(app.state()).text);
      renderFoot();
      if (app.state()?.job?.status === 'running') next();
      return;
    }
    if (b.wait) {
      setPhase('waiting');
      setStatus('Waiting for it to finish…');
      renderFoot();
      if (app.state()?.job?.status !== 'running') next();
      return;
    }
    if (b.action) arm();
    else startReading();
  }

  function startReading() {
    setPhase('read');
    renderFoot();
    if (t.mode === 'guide' || (t.beat?.last && t.mode !== 'watch')) return;
    startTimer(P.readingMs(t.beat, t.flavor), next);
  }

  // An action beat: wait for its button to be usable, then the judge clicks it (or autoplay does).
  function arm() {
    const b = t.beat;
    setPhase('armed');
    stopTimer();
    clearTimeout(t.clickTimer);
    t.pressing = false;
    renderFoot();
    const seq = t.seq;
    const selector = b.bubbleAction ? '#tour-action' : b.target;
    const poll = () => {
      if (seq !== t.seq || t.phase !== 'armed') return;
      const btn = /** @type {HTMLButtonElement | null} */ (document.querySelector(selector));
      if (!btn || btn.disabled) {
        const countdown = document.querySelector('#stage [data-countdown]')?.textContent;
        const line = coachLine(app.state(), null);
        setStatus(countdown ? `${countdown}. The tour carries on by itself.` : line.kind === 'working' ? line.text : 'Waiting for the button to unlock…');
        t.clickTimer = setTimeout(poll, 1000);
        return;
      }
      if (!b.bubbleAction && t.target !== btn) {
        t.side = null;
        t.target = btn;
        t.targetSel = selector;
      }
      if (t.mode === 'guide') {
        setStatus(b.bubbleAction ? 'Click the button above.' : 'Click the highlighted button.');
        t.clickTimer = setTimeout(() => seq === t.seq && t.phase === 'armed' && cursorOff(), 500);
        renderFoot();
        return;
      }
      setStatus('Playing: the tour clicks it when the bar fills.');
      renderFoot();
      startTimer(P.armMs(b, t.flavor), () => glideAndClick(btn, seq));
    };
    poll();
  }

  function glideAndClick(btn, seq) {
    if (seq !== t.seq || t.phase !== 'armed' || t.pressing) return;
    stopTimer();
    clearTimeout(t.clickTimer);
    if (!btn.isConnected || btn.disabled) return arm();
    t.pressing = true;
    if (!t.cursorAt) {
      const from = bubble.getBoundingClientRect();
      cursorTo(from.left + 36, from.top + 22, true);
    }
    cursor.classList.add('is-on');
    const r = btn.getBoundingClientRect();
    cursorTo(r.left + Math.min(r.width / 2, 64), r.top + r.height / 2);
    const press = () => {
      if (seq !== t.seq || t.phase !== 'armed') return;
      if (t.paused) {
        t.clickTimer = setTimeout(press, 300);
        return;
      }
      if (btn.disabled) return arm();
      cursor.classList.add('is-click');
      btn.classList.add('tour-pressed');
      t.hovered = btn;
      setStatus('Clicked. Starting…');
      btn.click();
      setTimeout(() => btn.classList.remove('tour-pressed'), 400);
      setTimeout(() => cursor.classList.remove('is-click'), 650);
      // If no job shows up (the server refused it), look at the button again.
      t.clickTimer = setTimeout(() => seq === t.seq && t.phase === 'armed' && arm(), 8000);
    };
    t.clickTimer = setTimeout(press, reduced.matches ? 150 : 850);
  }

  function startTimer(ms, done) {
    stopTimer();
    const seq = t.seq;
    t.timer = { ms, spent: 0, last: performance.now(), done };
    const step = () => {
      const tm = t.timer;
      if (seq !== t.seq || !tm) return;
      const now = performance.now();
      if (!document.hidden && !t.paused) tm.spent += now - tm.last;
      tm.last = now;
      timerFill.style.transform = `scaleX(${Math.min(1, tm.spent / tm.ms).toFixed(4)})`;
      if (tm.spent >= tm.ms) {
        t.timer = null;
        return void tm.done();
      }
      t.timerRaf = requestAnimationFrame(step);
    };
    t.timerRaf = requestAnimationFrame(step);
  }

  function stopTimer() {
    cancelAnimationFrame(t.timerRaf);
    t.timer = null;
    timerFill.style.transform = 'scaleX(0)';
  }

  async function next() {
    if (!t.active) return;
    if (t.queue.length) return show(t.queue.shift());
    const s = app.state();
    if (!s) return;
    // The public tours are a fixed set of beats that never wait for the autopilot: when they're shown, the tour ends.
    if (t.mode === 'watch') return end();
    if (s.job?.status === 'running') return show(P.waitBeat()); // a step started elsewhere: carry on when it ends
    if (t.flavor === 'quick' && t.outroDone) return end();
    if (s.current === 'reset') {
      if (t.outroDone) return end();
      t.outroDone = true;
      t.queue = P.outroBeats(t.notes);
      return next();
    }
    const beat = P.actionBeat(s, app.recommended(s), t.flavor);
    if (!beat) return end();
    return show(beat);
  }

  /** The watch tour's next beat: the running step, what its end changed, or what the autopilot runs next. */
  function watchBeat(s) {
    const job = s.job;
    if (job?.status === 'running') {
      t.jobId = job.id;
      return P.watchJobBeat(job, s);
    }
    if (job && job.id === t.jobId && t.afterFor !== job.id) {
      t.afterFor = job.id;
      const after = job.status === 'done' ? P.watchAfter(job.action, s) : [];
      if (after.length) {
        t.queue = after.slice(1);
        return after[0];
      }
    }
    return P.watchIdleBeat(s);
  }

  /** Enter, →, or the Next button: whatever "go on" means right now. */
  function advance() {
    if (!t.active) return;
    switch (t.phase) {
      case 'show':
        return t.skipShow?.();
      case 'read':
        return t.beat?.last ? end() : next();
      case 'armed': {
        if (t.mode !== 'auto') return;
        const btn = /** @type {HTMLButtonElement | null} */ (document.querySelector(t.beat?.bubbleAction ? '#tour-action' : t.beat?.target));
        if (btn && !btn.disabled) glideAndClick(btn, t.seq);
        return;
      }
      case 'failed':
        return arm();
      default:
    }
  }

  // ---- a running job: the spotlight follows the stage, the bubble shows its live stage --------------------------

  function renderWork(job) {
    const stages = Array.isArray(job.stages) ? job.stages : [];
    const n = stages.length;
    const done = stages.filter((st) => st.status === 'done').length;
    const i = stages.findIndex((st) => st.status === 'running');
    const p = job.progress;
    const frac = p && Number.isFinite(p.total) && p.total > 0 ? Math.min(1, p.done / p.total) : n ? Math.min(1, (done + (i >= 0 ? 0.5 : 0)) / n) : 0;
    workText.textContent = i >= 0 ? `${i + 1} of ${n} · ${stages[i].title}` : actionText(job.action);
    workCount.textContent = p && Number.isFinite(p.total) && p.total > 0 ? `${formatInt(p.done)} / ${formatInt(p.total)}` : '';
    workFill.style.width = `${Math.round(frac * 100)}%`;
    work.lastElementChild?.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
  }

  async function startWorking(job) {
    setPhase('working');
    t.jobId = job.id;
    t.jobAction = job.action;
    // The decision's basis, read now: once the experiment is completed its results are no longer the story's.
    t.jobNote = P.decisionNote(job.action, app.state());
    t.pressing = false;
    stopTimer();
    clearTimeout(t.clickTimer);
    t.skipShow?.();
    unhover();
    setTimeout(cursorOff, 500);
    setSize('full');
    work.hidden = false;
    renderWork(job);
    setStatus('Nothing to click: watch it happen.');
    renderFoot();
    const seq = t.seq;
    const el = await findTarget('#stage-visual', 1500);
    if (seq !== t.seq || t.phase !== 'working') return;
    if (el && el !== t.target) {
      t.side = null;
      t.target = el;
      t.targetSel = '#stage-visual';
      ensureVisible(el);
    }
  }

  /** Polls Feature Health until Flagsmith shows the flag Unhealthy: the guard reports on its own ~20 s tick. */
  async function waitUnhealthy(run, ms = 26000) {
    const until = performance.now() + ms;
    for (;;) {
      if (run !== t.run || !t.active) return false;
      const answer = await Promise.resolve(app.unhealthy()).catch(() => false);
      if (answer === true) return true;
      if (answer === null) return false; // Feature Health isn't reported here: no point waiting
      if (performance.now() > until) return false;
      await wait(1500);
    }
  }

  /** Every state the page renders comes through here. */
  async function update(s) {
    if (!t.active || !s) return;
    const job = s.job;
    const b = t.beat;
    const running = job?.status === 'running';
    if (t.mode === 'watch') {
      if (t.phase !== 'waiting') return;
      if (b?.watchJob) return running && job.id === t.jobId ? renderWork(job) : next();
      if (b?.watchIdle) {
        if (running || P.watchIdleBeat(s).id !== b.id) return next();
        setStatus(autopilotLine(s).text);
      }
      return;
    }
    const mine = running && b?.action && (job.action === b.action || JOB_STEP[job.action] === JOB_STEP[b.action]);
    if (mine && (t.phase === 'show' || t.phase === 'armed' || t.phase === 'failed')) await startWorking(job);
    else if (running && job.id !== t.jobId && (t.phase === 'armed' || t.phase === 'read' || t.phase === 'failed')) {
      // A step the beat didn't ask for started (another button, another tab): follow it, carry on when it ends.
      return show(P.waitBeat());
    }
    if (t.phase === 'working' && job?.id === t.jobId) {
      if (job.status === 'running') return renderWork(job);
      if (job.status === 'failed') {
        setPhase('failed');
        work.hidden = true;
        setStatus(`That step stopped: ${job.error ?? 'it failed'}.`, 'bad');
        renderFoot();
        return;
      }
      // Done: what to look at now, here and in Flagsmith.
      setPhase('after');
      renderWork(job);
      workFill.style.width = '100%';
      setStatus('Done.');
      if (t.jobAction === 'reset') t.notes = [];
      else if (t.jobNote) t.notes.push(t.jobNote);
      t.jobNote = '';
      // A losing guardrail: Feature Health turns Unhealthy within one guard tick. Wait for it in the background while
      // the results beats play; the Unhealthy beat waits for the answer and is dropped if it never comes.
      const losing = t.jobAction === 'score' && (s.results?.losingGuardrails?.length ?? 0) > 0;
      t.healthWait = losing ? waitUnhealthy(t.run) : null;
      t.queue = P.afterBeats(t.jobAction, s, { unhealthy: losing, flavor: t.flavor });
      // The quick tour ends after one loop (or once Flagsmith says keep running): the guardrail story in one beat.
      if (t.flavor === 'quick' && (t.jobAction === 'verify' || t.jobAction === 'keep-running')) {
        t.queue.push(...P.quickOutro(s, t.notes));
        t.outroDone = true;
      }
      return next();
    }
    if (t.phase === 'waiting' && !running) return next();
  }

  // ---- start, end, pause, keys ------------------------------------------------------------------------------------

  function setMode(mode) {
    t.mode = mode === 'auto' || mode === 'watch' ? mode : 'guide';
    if (t.mode === 'guide') t.paused = false;
    renderMode();
    app.onChange?.(t.active, t.mode);
    if (!t.active || !t.beat) return;
    if (t.beat) renderExtra(t.beat);
    if (t.phase === 'read') {
      stopTimer();
      startReading();
    } else if (t.phase === 'armed') arm();
    else renderFoot();
  }

  function togglePause() {
    if (!t.active || t.mode === 'guide') return;
    t.paused = !t.paused;
    renderMode();
    renderFoot();
  }

  function start(mode, flavor = 'quick') {
    if (t.active) end();
    t.active = true;
    t.run++;
    t.flavor = flavor === 'full' ? 'full' : 'quick';
    t.signinShown = false;
    t.mode = mode === 'watch' ? 'watch' : t.mode;
    t.queue = mode === 'watch' ? P.publicTour(app.state(), t.flavor) : P.introBeats(app.state(), t.flavor);
    t.jobId = null;
    t.afterFor = null;
    t.shown = 0;
    t.total = 0;
    t.outroDone = false;
    t.paused = false;
    t.side = null;
    t.target = null;
    t.targetSel = null;
    t.lastRect = null;
    t.notes = [];
    t.jobNote = '';
    t.healthWait = null;
    lastSig = '';
    root.hidden = false;
    document.body.classList.add('touring');
    setSize('compact');
    setMode(mode);
    cancelAnimationFrame(t.raf);
    t.raf = requestAnimationFrame(place);
    bubble.focus({ preventScroll: true });
    next();
  }

  function end() {
    t.active = false;
    t.seq++;
    t.run++;
    setPhase('idle');
    t.beat = null;
    t.target = null;
    t.targetSel = null;
    t.pressing = false;
    t.healthWait = null;
    t.queue = [];
    t.paused = false;
    t.skipShow?.();
    t.skipShow = null;
    stopTimer();
    clearTimeout(t.clickTimer);
    cancelAnimationFrame(t.raf);
    unhover();
    cursorOff();
    bubble.classList.remove('is-in');
    root.hidden = true;
    document.body.classList.remove('touring');
    app.onChange?.(false, t.mode);
  }

  nextBtn.addEventListener('click', advance);
  quitBtn.addEventListener('click', end);
  guideBtn.addEventListener('click', () => setMode('guide'));
  autoBtn.addEventListener('click', () => setMode('auto'));
  pauseBtn.addEventListener('click', togglePause);
  exitBtn.addEventListener('click', end);
  // A click on the compact bubble opens it at once.
  bubble.addEventListener('click', (ev) => {
    if (t.phase === 'show' && !(ev.target instanceof Element && ev.target.closest('button, a'))) t.skipShow?.();
  });
  addEventListener('resize', () => t.active && setSize(bubble.dataset.size));
  addEventListener('keydown', (ev) => {
    if (!t.active || ev.defaultPrevented || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const el = ev.target instanceof Element ? ev.target : null;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      return end();
    }
    if (el?.closest('input, textarea, select, [contenteditable="true"]')) return;
    const onControl = el?.closest('button, a, summary, label, [role="tab"], [role="radio"]');
    if (ev.key === 'ArrowRight' && !el?.closest('[role="tab"], [role="radio"]')) {
      ev.preventDefault();
      advance();
    } else if (ev.key === 'Enter' && !onControl) {
      ev.preventDefault();
      advance();
    } else if ((ev.key === ' ' || ev.key === 'Spacebar') && !onControl && t.mode !== 'guide') {
      ev.preventDefault();
      togglePause();
    }
  });

  return {
    start,
    end,
    update,
    get active() {
      return t.active;
    },
    get mode() {
      return t.mode;
    },
  };
}
