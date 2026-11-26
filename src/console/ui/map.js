// The traffic map: an SVG rail junction. Visitors come in on one track, the flag's switch sends each one onto
// its release's track, and every routed request is a dot. Counters at each platform cover the last 60 s.
// Faint ghost dots always move along the tracks the flag routes to now (where the next visitor goes), so the map is
// never still; they are not visitors and the legend says so. A YOU pin marks the release this browser gets.
// Narrow containers (phones) get a compact junction with bigger type, and the counters as HTML below it.

const NS = 'http://www.w3.org/2000/svg';
const WIDE = { W: 960, ENTRY_X: 36, SWITCH_X: 330, CURVE_END_X: 480, TRACK_END_X: 694, STATION_X: 696, STATION_W: 256, STATION_H: 88, ROW: 100, MIN_H: 270, PAD: 62 };
const COMPACT = { W: 480, ENTRY_X: 14, SWITCH_X: 150, CURVE_END_X: 250, TRACK_END_X: 300, STATION_X: 302, STATION_W: 170, STATION_H: 72, ROW: 96, MIN_H: 230, PAD: 56 };
const COMPACT_BELOW_PX = 520; // the console's middle column on a laptop (about 560 px) keeps the full junction
const DURATION_MS = 2100;
const MAX_DOTS = 90;
const SAMPLE_POINTS = 160;
const SAMPLING_WINDOW_MS = 10_000;

const el = (name, attrs = {}, parent) => {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (parent) parent.appendChild(node);
  return node;
};

const text = (parent, attrs, content) => {
  const t = el('text', attrs, parent);
  t.textContent = content;
  return t;
};

export class TrafficMap {
  /**
   * @param {HTMLElement} container
   * @param {{ reducedMotion: boolean, onSampling?: (received: number, drawn: number) => void }} opts
   */
  constructor(container, opts) {
    this.container = container;
    this.reducedMotion = opts.reducedMotion;
    this.onSampling = opts.onSampling ?? (() => {});
    this.tracks = new Map(); // key → { variant, points, branch, station, counters, share }
    this.dots = [];
    this.received = [];
    this.drawn = [];
    this.layoutKey = '';
    this.frame = 0;
    this.compact = false;
    this.last = { variants: null, flagName: '', shares: {}, counts: {} };
    this.tick = this.tick.bind(this);
    // Rebuild in the other geometry when the container crosses the phone breakpoint.
    if (typeof ResizeObserver === 'function') {
      this.resize = new ResizeObserver(() => {
        if (!this.last.variants || this.wantsCompact() === this.compact) return;
        this.build(this.last.variants, this.last.flagName);
        this.setShares(this.last.shares);
        this.setCounts(this.last.counts);
      });
      this.resize.observe(container);
    }
  }

  wantsCompact() {
    const w = this.container.clientWidth;
    return w > 0 && w < COMPACT_BELOW_PX;
  }

  setReducedMotion(reduced) {
    this.reducedMotion = reduced;
    if (reduced) this.clearDots();
  }

  /** Rebuilds the junction when the set of variants changes; otherwise only updates weights and states. */
  setLayout(variants, shares, flagName) {
    this.last.variants = variants;
    this.last.flagName = flagName;
    const key = variants.map((v) => `${v.key}=${v.label}`).join('|') + `|${flagName}|${this.wantsCompact()}`;
    if (key !== this.layoutKey) this.build(variants, flagName);
    this.setShares(shares);
  }

  build(variants, flagName) {
    this.clearDots();
    this.tracks.clear();
    this.container.textContent = '';
    this.compact = this.wantsCompact();
    const G = this.compact ? COMPACT : WIDE;
    const { W, ENTRY_X, SWITCH_X, CURVE_END_X, TRACK_END_X, STATION_X, STATION_W, STATION_H } = G;
    this.layoutKey = variants.map((v) => `${v.key}=${v.label}`).join('|') + `|${flagName}|${this.compact}`;
    const n = Math.max(1, variants.length);
    const H = Math.max(G.MIN_H, 70 + n * G.ROW);
    const mid = H / 2;
    const ys = n === 1 ? [mid] : variants.map((_, i) => G.PAD + (i * (H - 2 * G.PAD)) / (n - 1));
    this.mid = mid;
    this.angles = variants.map((_, i) => (n === 1 ? 0 : -34 + (68 * i) / (n - 1)));

    const svg = el('svg', {
      viewBox: `0 0 ${W} ${H}`,
      class: this.compact ? 'junction compact' : 'junction',
      role: 'group',
      'aria-label': `Rail junction: visitors enter on the left and the ${flagName || 'release'} flag switches each one onto a release track`,
    });
    // Attached before measuring: Firefox can't measure paths outside the document.
    this.container.appendChild(svg);
    this.svg = svg;
    const defs = el('defs', {}, svg);
    const grid = el('pattern', { id: 'map-grid', width: 24, height: 24, patternUnits: 'userSpaceOnUse' }, defs);
    el('circle', { cx: 1, cy: 1, r: 1, class: 'grid-dot' }, grid);
    el('rect', { x: 0, y: 0, width: W, height: H, fill: 'url(#map-grid)', class: 'map-grid' }, svg);

    const rails = el('g', { class: 'rails' }, svg);
    const labels = el('g', { class: 'labels' }, svg);
    this.flowLayer = el('g', { class: 'flows', 'aria-hidden': 'true' }, svg);
    this.dotLayer = el('g', { class: 'dots', 'aria-hidden': 'true' }, svg);
    const stations = el('g', { class: 'stations' }, svg);

    // Entry track.
    const entryD = `M${ENTRY_X},${mid} L${SWITCH_X},${mid}`;
    this.drawRail(rails, entryD, 'entry');
    el('path', { d: entryD, class: 'flow entry' }, this.flowLayer);
    text(labels, { x: ENTRY_X, y: mid - 22, class: 'map-label' }, 'Visitors');
    if (this.compact) {
      text(labels, { x: ENTRY_X, y: mid + 38, class: 'map-caption' }, flagName ? `flag ${flagName}` : 'flag');
    } else {
      text(labels, { x: ENTRY_X, y: mid + 34, class: 'map-caption' }, 'through the Turnout proxy');
      text(labels, { x: SWITCH_X - 8, y: mid - 22, class: 'map-label', 'text-anchor': 'end' }, flagName ? `flag ${flagName}` : 'flag');
    }
    // Compact: the counters are HTML under the junction, where phone-sized type stays readable.
    const platforms = this.compact ? document.createElement('ul') : null;
    if (platforms) {
      platforms.className = 'map-platforms';
      platforms.setAttribute('aria-label', 'Requests per release in the last 60 s');
    }

    variants.forEach((v, i) => {
      const y = ys[i];
      const branchD = `M${SWITCH_X},${mid} C${SWITCH_X + 80},${mid} ${CURVE_END_X - 80},${y} ${CURVE_END_X},${y} L${TRACK_END_X},${y}`;
      const g = el('g', { class: 'track', style: `--c:${v.color}` }, rails);
      this.drawRail(g, branchD, 'branch');
      const flow = el('path', { d: branchD, class: 'flow', style: `--c:${v.color}` }, this.flowLayer);
      const motion = el('path', { d: `${entryD} ${branchD.replace(/^M[^ ]+ /, '')}`, fill: 'none', stroke: 'none' }, svg);
      const total = motion.getTotalLength();
      const points = [];
      for (let s = 0; s <= SAMPLE_POINTS; s++) {
        const p = motion.getPointAtLength((total * s) / SAMPLE_POINTS);
        points.push([p.x, p.y]);
      }
      motion.remove();

      const share = this.compact
        ? text(labels, { x: STATION_X - 8, y: y - 14, class: 'share-label', 'text-anchor': 'end', style: `--c:${v.color}` }, '')
        : text(labels, { x: CURVE_END_X + 8, y: y - 16, class: 'share-label', style: `--c:${v.color}` }, '');

      const st = el('g', { class: 'station', style: `--c:${v.color}`, transform: `translate(${STATION_X} ${y - STATION_H / 2})` }, stations);
      el('rect', { x: 0, y: 0, width: STATION_W, height: STATION_H, rx: 12, class: 'station-box' }, st);
      el('rect', { x: 0, y: 0, width: 6, height: STATION_H, rx: 3, class: 'station-stripe' }, st);
      // Arrival signals: opacity-only overlays, so frequent arrivals never blend colours mid-animation.
      el('rect', { x: 0, y: 0, width: STATION_W, height: STATION_H, rx: 12, class: 'station-glow glow-page' }, st);
      el('rect', { x: 0, y: 0, width: STATION_W, height: STATION_H, rx: 12, class: 'station-glow glow-conversion' }, st);
      el('rect', { x: 0, y: 0, width: STATION_W, height: STATION_H, rx: 12, class: 'station-glow glow-error' }, st);
      const state = text(st, { x: STATION_W - 4, y: -8, class: 'station-state', 'text-anchor': 'end' }, '');
      const counters = {};
      if (this.compact) {
        text(st, { x: 18, y: 32, class: 'station-title' }, v.label);
        text(st, { x: 18, y: 58, class: 'station-key' }, v.key);
        const li = document.createElement('li');
        li.style.setProperty('--c', v.color);
        const name = document.createElement('span');
        name.className = 'pf-name';
        name.textContent = `${v.label} `;
        const key = document.createElement('span');
        key.className = 'pf-key';
        key.textContent = v.key;
        name.append(key);
        li.append(name);
        for (const unit of ['requests', 'pages', 'conversions']) {
          const cell = document.createElement('span');
          cell.className = 'pf-count';
          counters[unit] = document.createElement('strong');
          counters[unit].textContent = '0';
          cell.append(counters[unit], ` ${unit}`);
          li.append(cell);
        }
        platforms.append(li);
      } else {
        const title = text(st, { x: 18, y: 28, class: 'station-title' }, v.label);
        const keyT = el('tspan', { class: 'station-key', dx: 8 }, title);
        keyT.textContent = v.key;
        [
          ['requests', 18],
          ['pages', 106],
          ['conversions', 182],
        ].forEach(([name, x]) => {
          counters[name] = text(st, { x, y: 60, class: 'station-count' }, '0');
          text(st, { x, y: 78, class: 'station-unit' }, name);
        });
      }
      this.tracks.set(v.key, { variant: v, points, branch: g, flow, station: st, share, state, counters, idle: false, y });
    });

    if (platforms) this.container.appendChild(platforms);
    this.G = G;
    this.youLayer = el('g', { class: 'you-layer' }, svg);
    if (this.youKey) this.setYou(this.youKey);
    if (this.compact) {
      this.leverArm = null; // the share labels carry the weights on phones
      return;
    }
    // The lever: a ground frame below the switch whose handle leans toward the tracks by the flag's weights.
    const lever = el('g', { class: 'lever', transform: `translate(${SWITCH_X - 58} ${mid + 70})` }, labels);
    el('rect', { x: -26, y: 10, width: 52, height: 12, rx: 3, class: 'lever-base' }, lever);
    this.leverArm = el('g', { class: 'lever-arm' }, lever);
    el('line', { x1: 0, y1: 0, x2: 40, y2: 0, class: 'lever-handle' }, this.leverArm);
    el('circle', { cx: 40, cy: 0, r: 6, class: 'lever-knob' }, this.leverArm);
    el('circle', { cx: 0, cy: 0, r: 5, class: 'lever-pivot' }, lever);
    text(lever, { x: 0, y: 40, class: 'map-caption', 'text-anchor': 'middle' }, 'lever = flag weights');

  }

  drawRail(parent, d, kind) {
    el('path', { d, class: `ties ${kind}` }, parent);
    el('path', { d, class: `rail-outer ${kind}` }, parent);
    el('path', { d, class: `rail-inner ${kind}` }, parent);
  }

  setShares(shares) {
    this.last.shares = shares ?? {};
    let angle = 0;
    let total = 0;
    [...this.tracks.values()].forEach((t, i) => {
      const share = Number(shares?.[t.variant.key] ?? 0);
      t.shareValue = share;
      t.idle = share <= 0;
      t.share.textContent = `${Number.isInteger(share) ? share : share.toFixed(1)}%`;
      t.branch.classList.toggle('idle', t.idle);
      t.flow?.classList.toggle('idle', t.idle);
      t.station.classList.toggle('idle', t.idle);
      t.share.classList.toggle('idle', t.idle);
      t.state.textContent = t.idle ? (this.compact ? 'idle' : 'idle: no traffic routed') : share >= 100 ? 'all traffic' : '';
      angle += (this.angles[i] ?? 0) * share;
      total += share;
    });
    // Idle tracks go underneath the live ones.
    for (const t of this.tracks.values()) if (t.idle) t.branch.parentNode.prepend(t.branch);
    if (this.leverArm) this.leverArm.style.transform = `rotate(${total ? angle / total : 0}deg)`;
  }

  /** Marks the release this browser gets (its variant key), or clears the mark with null. */
  setYou(key) {
    this.youKey = key ?? null;
    if (!this.youLayer) return;
    this.youLayer.textContent = '';
    const t = key ? this.tracks.get(key) : null;
    if (!t || !this.G) return;
    // On the track, just before the release's platform: where this browser's visits arrive.
    const { STATION_X } = this.G;
    const x = STATION_X - 50;
    const y = t.y - 9;
    const pin = el('g', { class: 'you-pin', transform: `translate(${x} ${y})` }, this.youLayer);
    el('rect', { x: 0, y: 0, width: 40, height: 18, rx: 9, class: 'you-ring' }, pin);
    el('rect', { x: 0, y: 0, width: 40, height: 18, rx: 9 }, pin);
    text(pin, { x: 20, y: 13, 'text-anchor': 'middle' }, 'YOU');
  }

  setCounts(byVariant) {
    this.last.counts = byVariant ?? {};
    for (const [key, t] of this.tracks) {
      const c = byVariant?.[key] ?? { requests: 0, pages: 0, conversions: 0 };
      for (const name of ['requests', 'pages', 'conversions']) {
        const v = String(c[name] ?? 0);
        if (t.counters[name].textContent !== v) t.counters[name].textContent = v;
      }
    }
  }

  /** One routed request from the proxy's feed. */
  spawn(event) {
    const t = this.tracks.get(event.variant);
    if (!t) return;
    const now = performance.now();
    this.received.push(now);
    if (this.reducedMotion || document.hidden) {
      this.flash(t, event);
      this.reportSampling(now);
      return;
    }
    // Over the cap, plain requests are dropped (and the sampling label says so); conversions and errors still
    // get their marker, up to a hard ceiling.
    const notable = event.converted || event.status >= 500;
    if (this.dots.length >= (notable ? MAX_DOTS + 30 : MAX_DOTS)) {
      this.reportSampling(now);
      return;
    }
    this.drawn.push(now);
    const error = event.status >= 500;
    let node;
    if (event.converted) {
      node = el('path', { d: 'M0,-8 L8,0 L0,8 L-8,0 Z', class: 'dot conversion' });
    } else {
      const r = (event.document ? 5.5 : 3.2) * (this.compact ? 1.5 : 1);
      node = el('circle', { r, class: `dot${event.document ? ' page' : ' asset'}` });
    }
    if (error) node.classList.add('error');
    node.style.setProperty('--c', t.variant.color);
    const [x, y] = t.points[0];
    node.setAttribute('transform', `translate(${x} ${y})`);
    this.dotLayer.appendChild(node);
    this.dots.push({ node, track: t, start: now, event, duration: DURATION_MS * (event.document || event.converted ? 1 : 0.85) });
    this.reportSampling(now);
    if (!this.frame) this.frame = requestAnimationFrame(this.tick);
  }

  tick(now) {
    this.frame = 0;
    const keep = [];
    for (const d of this.dots) {
      // rAF's timestamp is the frame's start, which can be just before a dot spawned this frame.
      const t = Math.min(1, Math.max(0, (now - d.start) / d.duration));
      const pts = d.track.points;
      const eased = t < 0.85 ? t : 0.85 + (1 - Math.pow(1 - (t - 0.85) / 0.15, 2)) * 0.15;
      const f = eased * (pts.length - 1);
      const i = Math.floor(f);
      const a = pts[i];
      const b = pts[Math.min(i + 1, pts.length - 1)];
      const r = f - i;
      d.node.setAttribute('transform', `translate(${(a[0] + (b[0] - a[0]) * r).toFixed(1)} ${(a[1] + (b[1] - a[1]) * r).toFixed(1)})`);
      if (t >= 1) {
        d.node.remove();
        this.arrive(d.track, d.event);
      } else {
        keep.push(d);
      }
    }
    this.dots = keep;
    if (this.dots.length) this.frame = requestAnimationFrame(this.tick);
  }

  arrive(track, event) {
    this.signal(track, event);
  }

  flash(track, event) {
    this.signal(track, event);
  }

  // Rate-limited so a busy track glows in beats instead of staying lit: pages every 450 ms, conversions and errors every 1 s.
  signal(track, event) {
    const kind = event.status >= 500 ? 'error' : event.converted ? 'conversion' : 'page';
    const now = performance.now();
    track.lastSignal ??= {};
    if (now - (track.lastSignal[kind] ?? 0) < (kind === 'page' ? 450 : 1000)) return;
    track.lastSignal[kind] = now;
    const glow = track.station.querySelector(`.glow-${kind}`);
    if (!glow) return;
    glow.classList.remove('on');
    void glow.getBoundingClientRect(); // restart the animation
    glow.classList.add('on');
  }

  reportSampling(now) {
    const cutoff = now - SAMPLING_WINDOW_MS;
    while (this.received.length && this.received[0] < cutoff) this.received.shift();
    while (this.drawn.length && this.drawn[0] < cutoff) this.drawn.shift();
    this.onSampling(this.received.length, this.drawn.length);
  }

  clearDots() {
    for (const d of this.dots) d.node.remove();
    this.dots = [];
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }
}
