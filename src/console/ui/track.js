// The live track diagram on the judge page: visitors enter Turnover, Turnover asks the flag, and each request
// rides the track the flag chose (the preview segment, the experiment's split, or the default for everyone else) to
// the release that served it. Drawn in plain SVG at the container's real pixel size, so text stays readable from a
// phone to a wide laptop dashboard; switches to a top-to-bottom layout below WIDE (576 px). Boxes keep their identity
// between redraws, so when the routing changes they glide to their new places and the rails cross-fade instead of
// the whole picture being swapped. Every label goes in through textContent.
import { perSecond, formatRate } from './judge-format.js';

const NS = 'http://www.w3.org/2000/svg';
const MAX_DOTS = 60;
const DOT_MS = 1500;
const DEMO_MS = 1150; // a demo dot's ride: the demo's last dot lands inside 2 s
const DEMO_SPREAD_MS = 700; // the demo's dots leave over this long
const FADE_MS = 450;
// Below WIDE, the vertical phone layout. WIDE fits the dashboard's centre column on every laptop width (about 584 px
// of map at 1024 and at 1280 px).
export const WIDE = 576;
export const ROOMY = 600; // from this, the desktop sizes: taller rows, wider boxes

// Horizontal columns, left to right: visitors, gap, Turnover, gap, the flag's rules, gap, releases.
// The rules column grows first (its notes are the longest text: "bots, and anyone outside the rollout"), then the
// others towards their maximum; anything wider goes into the two long gaps.
const COL_MIN = [76, 16, 92, 20, 192, 56, 100];
const COL_MAX = [130, 60, 150, 140, 268, 160, 200];
const RULES_COL = 4;

function el(tag, attrs = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, String(v));
  if (text != null) node.textContent = String(text);
  return node;
}

/** Text that fits a width: shortens with an ellipsis rather than spilling out of its box. */
function fit(node, full, maxWidth) {
  node.textContent = full;
  if (!node.getComputedTextLength || maxWidth <= 0 || !full) return;
  let text = full;
  try {
    while (text.length > 3 && node.getComputedTextLength() > maxWidth) {
      text = text.slice(0, -2);
      node.textContent = `${text}…`;
    }
  } catch {
    node.textContent = full; // not rendered yet (hidden tab): keep the full text
  }
}

const r1 = (n) => Math.round(n * 10) / 10;

const curve = (x1, y1, x2, y2, vertical) =>
  vertical
    ? `C ${r1(x1)} ${r1((y1 + y2) / 2)}, ${r1(x2)} ${r1((y1 + y2) / 2)}, ${r1(x2)} ${r1(y2)}`
    : `C ${r1((x1 + x2) / 2)} ${r1(y1)}, ${r1((x1 + x2) / 2)} ${r1(y2)}, ${r1(x2)} ${r1(y2)}`;

/** The seven horizontal column widths for an inner width. Pure. */
export function columns(inner) {
  const minSum = COL_MIN.reduce((a, b) => a + b, 0);
  const w = [...COL_MIN];
  let left = Math.max(0, inner - minSum);
  const first = Math.min(left, COL_MAX[RULES_COL] - COL_MIN[RULES_COL]);
  w[RULES_COL] += first;
  left -= first;
  const range = COL_MAX.reduce((a, m, i) => a + (i === RULES_COL ? 0 : m - COL_MIN[i]), 0);
  const t = range > 0 ? Math.min(1, left / range) : 0;
  for (let i = 0; i < w.length; i++) if (i !== RULES_COL) w[i] += (COL_MAX[i] - COL_MIN[i]) * t;
  const extra = inner - w.reduce((a, b) => a + b, 0);
  if (extra > 0) {
    w[3] += extra / 2;
    w[5] += extra / 2;
  }
  return w;
}

/** Boxes and paths for a width. Pure geometry: no DOM. */
export function layout(width, rules, releases) {
  const W = Math.max(300, Math.round(width));
  const vertical = W < WIDE;
  const nU = Math.max(1, rules.length);
  const nR = Math.max(1, releases.length);
  const box = {};
  /** @type {{ x: number, y: number, w: number, text: string }[]} */
  let captions = [];
  let H;
  let pad;
  if (!vertical) {
    const roomy = W >= ROOMY;
    pad = roomy ? 20 : 12;
    const capH = 30; // the column captions along the top
    const RH = roomy ? 88 : 74; // row pitch
    const BH = roomy ? 60 : 54; // rule and release box height
    H = Math.max(roomy ? 340 : 288, capH + Math.max(nU, nR, 3) * RH + pad);
    const mid = capH + (H - capH - pad) / 2;
    const row = (i, n) => mid + (i - (n - 1) / 2) * RH;
    const [cS, g1, cJ, g2, cU, g3, cR] = columns(W - pad * 2);
    const xS = pad;
    const xJ = xS + cS + g1;
    const xU = xJ + cJ + g2;
    const xR = xU + cU + g3;
    box.source = { x: xS, y: mid - 26, w: cS, h: 52 };
    box.junction = { x: xJ, y: mid - 34, w: cJ, h: 68 };
    box.rules = rules.map((r, i) => ({ id: r.id, x: xU, y: row(i, nU) - BH / 2, w: cU, h: BH }));
    box.releases = releases.map((r, i) => ({ id: r, x: xR, y: row(i, nR) - BH / 2, w: cR, h: BH }));
    captions = [
      { x: xS + cS / 2, y: 17, w: cS, text: 'Traffic' },
      { x: xJ + cJ / 2, y: 17, w: cJ, text: 'Proxy' },
      { x: xU + cU / 2, y: 17, w: cU, text: 'Flagsmith rules' },
      { x: xR + cR / 2, y: 17, w: cR, text: 'Releases' },
    ];
  } else {
    pad = 10;
    const gap = 8;
    box.source = { x: W / 2 - 60, y: pad, w: 120, h: 40 };
    box.junction = { x: W / 2 - 85, y: pad + 40 + 26, w: 170, h: 52 };
    const ruleTop = box.junction.y + box.junction.h + 44;
    const ruleW = (W - pad * 2 - gap * (nU - 1)) / nU;
    box.rules = rules.map((r, i) => ({ id: r.id, x: pad + i * (ruleW + gap), y: ruleTop, w: ruleW, h: 54 }));
    const relTop = ruleTop + 54 + 64;
    const relW = (W - pad * 2 - gap * (nR - 1)) / nR;
    box.releases = releases.map((r, i) => ({ id: r, x: pad + i * (relW + gap), y: relTop, w: relW, h: 56 }));
    H = relTop + 56 + pad;
  }
  const out = (b) => (vertical ? [b.x + b.w / 2, b.y + b.h] : [b.x + b.w, b.y + b.h / 2]);
  const inn = (b) => (vertical ? [b.x + b.w / 2, b.y] : [b.x, b.y + b.h / 2]);
  const [sx, sy] = out(box.source);
  const [jx1, jy1] = inn(box.junction);
  const [jx2, jy2] = out(box.junction);
  const M = (x, y) => `M ${r1(x)} ${r1(y)}`;
  const L = (x, y) => `L ${r1(x)} ${r1(y)}`;
  const paths = { feed: `${M(sx, sy)} ${L(jx1, jy1)}`, toRule: {}, toRelease: [], ride: {} };
  rules.forEach((r, i) => {
    const b = box.rules[i];
    const [rx1, ry1] = inn(b);
    const [rx2, ry2] = out(b);
    paths.toRule[r.id] = `${M(jx2, jy2)} ${curve(jx2, jy2, rx1, ry1, vertical)}`;
    for (const t of r.targets) {
      const rb = box.releases[releases.indexOf(t.release)];
      if (!rb) continue;
      const [tx, ty] = inn(rb);
      const leg = curve(rx2, ry2, tx, ty, vertical);
      paths.toRelease.push({ rule: r.id, release: t.release, pct: t.pct, many: r.targets.length > 1, d: `${M(rx2, ry2)} ${leg}`, mid: [(rx2 + tx) / 2, (ry2 + ty) / 2] });
      // One continuous path per rule and release, for the dots: feed, through Turnover, through the rule, out.
      const end = vertical ? [tx, ty + rb.h / 2] : [tx + rb.w / 2, ty];
      paths.ride[`${r.id}|${t.release}`] =
        `${M(sx, sy)} ${L(jx1, jy1)} ${L(jx2, jy2)} ${curve(jx2, jy2, rx1, ry1, vertical)} ${L(rx2, ry2)} ${leg} ${L(end[0], end[1])}`;
    }
  });
  return { W, H, vertical, pad, box, paths, captions };
}

/**
 * The dots a demo sends: `n` of them shared out along the live tracks in proportion to each track's pct (the
 * experiment's split counts double, since it is the interesting part), interleaved so the split is visible while
 * they ride. Every fifth dot is an order. Pure.
 * @returns {{ rule: string, release: string, kind: 'page' | 'order' }[]}
 */
export function demoPlan(rules, n = 14) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  const routes = [];
  for (const r of rules ?? []) {
    const live = (r.targets ?? []).filter((t) => t.release && Number(t.pct) > 0);
    const sum = live.reduce((a, t) => a + Number(t.pct), 0);
    if (sum <= 0) continue;
    const weight = r.id === 'experiment' ? 2 : 1;
    for (const t of live) routes.push({ rule: r.id, release: t.release, w: (weight * Number(t.pct)) / sum });
  }
  if (!routes.length || !count) return [];
  // Largest remainder: whole dots that add up to exactly n.
  const total = routes.reduce((a, r) => a + r.w, 0);
  const quota = routes.map((r) => (r.w / total) * count);
  const share = quota.map(Math.floor);
  let left = count - share.reduce((a, b) => a + b, 0);
  const order = quota.map((q, i) => [q - Math.floor(q), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) share[order[k][1]]++;
  // Smooth weighted round robin: spreads each track's dots evenly through the sequence.
  const credit = routes.map(() => 0);
  const plan = [];
  for (let i = 0; i < count; i++) {
    let best = -1;
    for (let j = 0; j < routes.length; j++) {
      credit[j] += share[j];
      if (share[j] > 0 && (best < 0 || credit[j] > credit[best])) best = j;
    }
    credit[best] -= count;
    plan.push({ rule: routes[best].rule, release: routes[best].release, kind: i % 5 === 3 ? 'order' : 'page' });
  }
  return plan;
}

export function createTrack(root, { colorOf, summary }) {
  const svg = el('svg', { class: 'track-svg', role: 'img', 'aria-labelledby': 'track-title' });
  const title = el('title', { id: 'track-title' }, 'Who gets which release');
  const captionsG = el('g', { class: 'track-captions', 'aria-hidden': 'true' });
  let railsG = el('g', { class: 'track-rails' });
  let pctsG = el('g', { class: 'track-pcts' });
  const nodesG = el('g', { class: 'track-nodes' });
  let rideG = el('g', { class: 'track-ride', 'aria-hidden': 'true' });
  const layer = el('g', { class: 'track-dots', 'aria-hidden': 'true' }); // where the dots go
  // The dots ride under the boxes: an arriving dot slides beneath its release's label, and the box flashes instead.
  svg.append(title, captionsG, railsG, layer, rideG, pctsG, nodesG);
  root.replaceChildren(svg);

  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let rules = [];
  let releases = [];
  let geo = null;
  let ride = new Map(); // "rule|release" → hidden <path> for the dots
  const times = new Map(); // release → arrival times (real traffic only)
  const rateText = new Map(); // release → <text>
  /** @type {Map<string, { g: SVGGElement, rect: SVGRectElement, t1: SVGTextElement, t2: SVGTextElement, mark: SVGCircleElement | null, full1: string, full2: string, w: number }>} */
  const nodes = new Map(); // "source" | "junction" | "rule:<id>" | "rel:<release>" → its box, kept between redraws
  const dots = [];
  let raf = 0;
  let sig = '';
  let focus = null; // the highlighted rule id
  let animTimer = 0;
  let demos = 0;

  const animated = () => !reduced.matches && !document.hidden;

  /** Puts `next` in place of `old`: cross-fades when animating, otherwise swaps at once. */
  function swap(old, next, animate) {
    old.after(next);
    if (!animate) return old.remove();
    next.classList.add('is-entering');
    old.classList.add('is-leaving');
    old.setAttribute('aria-hidden', 'true');
    setTimeout(() => old.remove(), FADE_MS + 50);
  }

  function leave(g, animate) {
    if (!animate) return g.remove();
    g.classList.add('is-leaving');
    setTimeout(() => g.remove(), FADE_MS + 50);
  }

  function draw(animate = false) {
    const width = root.clientWidth || 640;
    geo = layout(width, rules, releases);
    animate = animate && animated();
    svg.setAttribute('viewBox', `0 0 ${geo.W} ${geo.H}`);
    svg.setAttribute('width', String(geo.W));
    svg.setAttribute('height', String(geo.H));
    svg.classList.toggle('is-vertical', geo.vertical);
    if (animate) {
      svg.classList.add('is-animating');
      clearTimeout(animTimer);
      animTimer = setTimeout(() => svg.classList.remove('is-animating'), FADE_MS + 150);
    }
    clear(); // dots in flight follow the old paths
    rateText.clear();
    const now = performance.now();

    captionsG.replaceChildren(...geo.captions.map((c) => el('text', { x: r1(c.x), y: c.y, 'text-anchor': 'middle', class: 'track-caption' }, c.text)));

    const nextRails = el('g', { class: 'track-rails' });
    nextRails.append(el('path', { d: geo.paths.feed, class: 'rail rail-feed' }));
    for (const r of rules) nextRails.append(el('path', { d: geo.paths.toRule[r.id], class: `rail rail-rule rail-${r.id}`, 'data-rule': r.id }));
    for (const p of geo.paths.toRelease) {
      const w = 2 + (6 * Math.max(0, Math.min(100, p.pct))) / 100;
      nextRails.append(
        el('path', { d: p.d, class: `rail rail-out${p.pct <= 0 ? ' rail-empty' : ''}`, 'data-rule': p.rule, style: `stroke:${colorOf(p.release)};stroke-width:${w}px` }),
      );
    }
    swap(railsG, nextRails, animate);
    railsG = nextRails;

    const nextPcts = el('g', { class: 'track-pcts' });
    for (const p of geo.paths.toRelease) {
      if (!p.many) continue;
      const g = el('g', { class: 'pct-tag', 'data-rule': p.rule, transform: `translate(${r1(p.mid[0])} ${r1(p.mid[1])})` });
      g.append(el('rect', { x: -26, y: -12, width: 52, height: 24, rx: 12, style: `stroke:${colorOf(p.release)}` }));
      g.append(el('text', { x: 0, y: 4.5, 'text-anchor': 'middle' }, `${Math.round(p.pct * 10) / 10}%`));
      nextPcts.append(g);
    }
    swap(pctsG, nextPcts, animate);
    pctsG = nextPcts;

    const seen = new Set();
    const put = (key, b, cls, line1, line2, { color = null, rule = null, flagsmith = false } = {}) => {
      seen.add(key);
      let n = nodes.get(key);
      const fresh = !n;
      if (!n) {
        const g = el('g');
        const rect = el('rect', { rx: 10 });
        const t1 = el('text', { 'text-anchor': 'middle', class: 'tnode-title' });
        const t2 = el('text', { 'text-anchor': 'middle', class: 'tnode-sub' });
        g.append(rect, t1, t2);
        n = { g, rect, t1, t2, mark: null, full1: '', full2: '', w: 0 };
        nodes.set(key, n);
        nodesG.append(g);
      }
      n.g.setAttribute('class', `tnode ${cls}`);
      if (fresh && animate) n.g.classList.add('is-entering');
      if (rule) n.g.setAttribute('data-rule', rule);
      else n.g.removeAttribute('data-rule');
      n.g.style.transform = `translate(${r1(b.x)}px, ${r1(b.y)}px)`;
      n.rect.setAttribute('width', String(r1(b.w)));
      n.rect.setAttribute('height', String(r1(b.h)));
      if (color) n.rect.setAttribute('style', `stroke:${color};fill:color-mix(in srgb, ${color} 10%, var(--surface))`);
      else n.rect.removeAttribute('style');
      n.full1 = String(line1 ?? '');
      n.full2 = line2 == null ? '' : String(line2);
      n.w = b.w;
      n.t1.setAttribute('x', String(r1(b.w / 2)));
      n.t1.setAttribute('y', String(r1(line2 != null ? b.h / 2 - 4 : b.h / 2 + 5)));
      n.t1.textContent = n.full1;
      n.t2.setAttribute('x', String(r1(b.w / 2)));
      n.t2.setAttribute('y', String(r1(b.h / 2 + 15)));
      n.t2.textContent = n.full2;
      n.t2.style.display = line2 == null ? 'none' : '';
      if (flagsmith) {
        if (!n.mark) {
          n.mark = el('circle', { r: 3.5, class: 'tnode-fs' });
          n.g.append(n.mark);
        }
        n.mark.setAttribute('cx', String(r1(b.w - 11)));
        n.mark.setAttribute('cy', '11');
      } else if (n.mark) {
        n.mark.remove();
        n.mark = null;
      }
      return n;
    };

    put('source', geo.box.source, 'tnode-source', 'Visitors', geo.vertical || geo.box.source.w < 104 ? null : 'cookie ID only');
    put('junction', geo.box.junction, 'tnode-junction', 'Turnover', 'asks the flag');
    rules.forEach((r, i) => put(`rule:${r.id}`, geo.box.rules[i], `tnode-rule tnode-rule-${r.id}`, r.title, r.note, { rule: r.id, flagsmith: true }));
    const served = new Set(rules.flatMap((r) => r.targets.filter((t) => t.pct > 0).map((t) => t.release)));
    releases.forEach((rel, i) => {
      const live = served.has(rel);
      const sub = live ? formatRate(perSecond(times.get(rel) ?? [], now)) : 'not served';
      const n = put(`rel:${rel}`, geo.box.releases[i], `tnode-release${live ? '' : ' tnode-idle'}`, rel, sub, { color: colorOf(rel) });
      if (live) rateText.set(rel, n.t2);
    });
    for (const [key, n] of nodes) {
      if (seen.has(key)) continue;
      leave(n.g, animate);
      nodes.delete(key);
    }

    // fit() needs the text in the document, which it now is.
    for (const n of nodes.values()) {
      fit(n.t1, n.full1, n.w - 16);
      if (n.full2) fit(n.t2, n.full2, n.w - 16);
    }
    for (const t of captionsG.children) {
      const c = geo.captions.find((x) => x.text === t.textContent);
      if (c) fit(/** @type {SVGTextElement} */ (t), c.text, c.w);
    }

    const nextRide = el('g', { class: 'track-ride', 'aria-hidden': 'true' });
    ride = new Map();
    for (const [key, d] of Object.entries(geo.paths.ride)) {
      const p = el('path', { d, fill: 'none', stroke: 'none' });
      nextRide.append(p);
      ride.set(key, p);
    }
    rideG.replaceWith(nextRide);
    rideG = nextRide;

    if (animate) {
      void svg.getBoundingClientRect(); // commit the starting opacity, so taking the class off fades in
      for (const g of svg.querySelectorAll('.is-entering')) g.classList.remove('is-entering');
    }
    applyFocus();
  }

  function update(nextRules, nextReleases) {
    const all = [...nextReleases];
    for (const r of nextRules) for (const t of r.targets) if (t.release && !all.includes(t.release)) all.push(t.release);
    const s = JSON.stringify([nextRules, all]);
    if (s === sig) return;
    sig = s;
    rules = nextRules;
    releases = all;
    title.textContent = summary(rules);
    draw(geo != null);
  }

  function frame(now) {
    for (let i = dots.length - 1; i >= 0; i--) {
      const d = dots[i];
      const t = Math.min(1, Math.max(0, (now - d.start) / d.ms));
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const pt = d.path.getPointAtLength(eased * d.len);
      d.node.setAttribute('cx', pt.x.toFixed(1));
      d.node.setAttribute('cy', pt.y.toFixed(1));
      if (t >= 1) {
        d.node.remove();
        dots.splice(i, 1);
        d.done?.();
      }
    }
    raf = dots.length ? requestAnimationFrame(frame) : 0;
  }

  function flash(release) {
    const g = nodes.get(`rel:${release}`)?.g;
    if (!g) return;
    g.classList.remove('tnode-flash');
    void g.getBoundingClientRect();
    g.classList.add('tnode-flash');
  }

  /** Sends one dot along a rule's track to a release. Returns false when there is no such track. */
  function launch(rule, release, kind, ms, done) {
    const path = ride.get(`${rule}|${release}`);
    if (!path) return false;
    const r = kind === 'order' ? 6 : kind === 'asset' ? 3 : 4.5;
    const cls = `tdot tdot-${kind}${done ? ' tdot-demo' : ''}${focus && focus === rule ? ' is-focus' : ''}`;
    const node = el('circle', { r, class: cls, 'data-rule': rule, style: `fill:${colorOf(release)}` });
    const start = path.getPointAtLength(0);
    node.setAttribute('cx', start.x.toFixed(1));
    node.setAttribute('cy', start.y.toFixed(1));
    layer.append(node);
    dots.push({ node, path, len: path.getTotalLength(), start: performance.now(), ms, done });
    if (!raf) raf = requestAnimationFrame(frame);
    return true;
  }

  /** One proxied request: count it, and send a dot down the track it took. */
  function pulse(ev, route) {
    const release = ev.release;
    if (!release) return;
    const list = times.get(release) ?? [];
    list.push(performance.now());
    times.set(release, list);
    if (!animated()) return flash(release);
    if (dots.length >= MAX_DOTS) return;
    const kind = ev.status >= 500 ? 'error' : ev.converted ? 'order' : ev.document ? 'page' : 'asset';
    if (kind === 'asset' && dots.length > MAX_DOTS / 2) return; // keep room for pages and orders when it's busy
    launch(route, release, kind, DOT_MS, null);
  }

  /**
   * A short show of how traffic splits right now: `n` synthetic dots ride the live tracks in proportion to their pct.
   * They are not requests, so the rates never count them. Resolves when the last one lands (under 2 s); at once,
   * with the served releases flashed, under reduced motion or in a hidden tab.
   * @returns {Promise<void>}
   */
  function demo(n = 14) {
    const plan = demoPlan(rules, n);
    if (!plan.length) return Promise.resolve();
    if (!animated()) {
      for (const rel of new Set(plan.map((p) => p.release))) flash(rel);
      return Promise.resolve();
    }
    demos++;
    svg.classList.add('is-demo');
    const step = plan.length > 1 ? Math.min(90, DEMO_SPREAD_MS / (plan.length - 1)) : 0;
    return new Promise((resolve) => {
      let left = plan.length;
      let over = false;
      const end = () => {
        if (over) return;
        over = true;
        clearTimeout(safety);
        if (--demos <= 0) {
          demos = 0;
          svg.classList.remove('is-demo');
        }
        resolve();
      };
      const landed = (release) => {
        if (release) flash(release);
        if (--left <= 0) end();
      };
      const safety = setTimeout(end, DEMO_SPREAD_MS + DEMO_MS + 400); // frames stop in a hidden tab
      plan.forEach((p, i) =>
        setTimeout(() => {
          if (over) return;
          if (!launch(p.rule, p.release, p.kind, DEMO_MS, () => landed(p.release))) landed(null);
        }, i * step),
      );
    });
  }

  function applyFocus() {
    const known = focus != null && rules.some((r) => r.id === focus);
    svg.classList.toggle('has-focus', known);
    const targets = new Set(known ? rules.find((r) => r.id === focus).targets.filter((t) => t.pct > 0).map((t) => t.release) : []);
    for (const node of svg.querySelectorAll('[data-rule]')) node.classList.toggle('is-focus', known && node.getAttribute('data-rule') === focus);
    for (const [key, n] of nodes) if (key.startsWith('rel:')) n.g.classList.toggle('is-focus', targets.has(key.slice(4)));
  }

  /** Puts one rule's track in front and dims the rest; null shows them all again. */
  function highlight(ruleId) {
    focus = ruleId ?? null;
    applyFocus();
  }

  /** Requests per second per release over the last 5 s, from the real traffic only. */
  function rates() {
    const now = performance.now();
    /** @type {Record<string, number>} */
    const out = {};
    for (const [release, list] of times) out[release] = perSecond(list, now);
    return out;
  }

  function tickRates() {
    const now = performance.now();
    for (const [release, list] of times) {
      const kept = list.filter((t) => t > now - 5000);
      times.set(release, kept);
      const node = rateText.get(release);
      const text = formatRate(perSecond(kept, now));
      if (node && node.textContent !== text) node.textContent = text;
    }
  }

  /** Drops the dots in flight (the tab was hidden, or the tracks moved). */
  function clear() {
    const gone = dots.splice(0, dots.length);
    for (const d of gone) {
      d.node.remove();
      d.done?.();
    }
    cancelAnimationFrame(raf);
    raf = 0;
  }

  let pending = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      if (geo && Math.abs((root.clientWidth || 0) - geo.W) > 2) draw(false);
    });
  }).observe(root);

  return { update, pulse, tickRates, clear, demo, highlight, rates };
}
