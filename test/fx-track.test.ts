import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const UI = fileURLToPath(new URL('../src/console/ui/', import.meta.url));
const read = (name: string) => readFileSync(join(UI, name), 'utf8');

// Browser modules with no types: the tests treat them as untyped. Neither touches the DOM at import time.
const T: any = await import(pathToFileURL(join(UI, 'track.js')).href);
const FX: any = await import(pathToFileURL(join(UI, 'fx.js')).href);
const J: any = await import(pathToFileURL(join(UI, 'judge-format.js')).href);

type Box = { x: number; y: number; w: number; h: number };

const preview = { id: 'preview', title: 'Your team', note: 'preview segment', targets: [{ release: 'shop:1.6', pct: 100 }] };
const experiment = {
  id: 'experiment',
  title: 'Experiment 12',
  note: '100% of visitors · running',
  targets: [
    { release: 'shop:1.4', pct: 50 },
    { release: 'shop:1.5', pct: 50 },
  ],
};
const fallback = { id: 'default', title: 'Everyone else', note: "the flag's default", targets: [{ release: 'shop:1.4', pct: 100 }] };
const RULES = [preview, experiment, fallback];
const RELEASES = ['shop:1.4', 'shop:1.5', 'shop:1.6'];

const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const allBoxes = (g: any): Box[] => [g.box.source, g.box.junction, ...g.box.rules, ...g.box.releases];

describe('track.js layout: geometry at phone, laptop and wide widths', () => {
  for (const width of [360, 800, 1200]) {
    test(`${width} px: every box inside the drawing, none overlapping`, () => {
      const g = T.layout(width, RULES, RELEASES);
      assert.equal(g.W, width);
      assert.equal(g.vertical, width < T.WIDE);
      assert.equal(g.box.rules.length, 3);
      assert.equal(g.box.releases.length, 3);
      for (const b of allBoxes(g)) {
        assert.ok(b.x >= 0 && b.x + b.w <= g.W + 0.01, `box ${JSON.stringify(b)} leaves the width ${g.W}`);
        assert.ok(b.y >= 0 && b.y + b.h <= g.H + 0.01, `box ${JSON.stringify(b)} leaves the height ${g.H}`);
        assert.ok(b.w > 0 && b.h > 0);
      }
      const boxes = allBoxes(g);
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlap(boxes[i]!, boxes[j]!), `boxes ${i} and ${j} overlap at ${width} px`);
      }
    });
  }

  test('below WIDE the tracks run top to bottom; from WIDE left to right, and WIDE fits a laptop centre column', () => {
    const phone = T.layout(360, RULES, RELEASES);
    assert.ok(phone.box.rules.every((b: Box) => b.y > phone.box.junction.y + phone.box.junction.h));
    assert.ok(phone.box.releases.every((b: Box) => b.y > phone.box.rules[0].y + phone.box.rules[0].h));
    assert.deepEqual(phone.captions, []);
    assert.ok(T.WIDE <= 584, `the centre column holds about 584 px of map at 1024 and 1280 px; WIDE is ${T.WIDE}`);
    assert.equal(T.layout(T.WIDE - 1, RULES, RELEASES).vertical, true);
    const laptop = T.layout(T.WIDE, RULES, RELEASES);
    assert.equal(laptop.vertical, false);
    assert.ok(laptop.box.rules.every((b: Box) => b.x > laptop.box.junction.x + laptop.box.junction.w));
    assert.ok(laptop.box.releases.every((b: Box) => b.x > laptop.box.rules[0].x + laptop.box.rules[0].w));
  });

  test('desktop: tall, with roomy boxes and room for the split percentages between rules and releases', () => {
    const g = T.layout(1200, RULES, RELEASES);
    assert.ok(g.H >= 340, `height ${g.H}`);
    assert.ok(g.box.rules[0].h >= 56 && g.box.releases[0].w >= 160);
    const gap = g.box.releases[0].x - (g.box.rules[0].x + g.box.rules[0].w);
    assert.ok(gap >= 56, `pct tags need 52 px between rules and releases, got ${gap}`);
    assert.deepEqual(g.captions.map((c: any) => c.text), ['Traffic', 'Proxy', 'Flagsmith rules', 'Releases']);
    for (const c of g.captions) assert.ok(c.x - c.w / 2 >= 0 && c.x + c.w / 2 <= g.W);
  });

  test('columns fill the inner width exactly from the narrowest horizontal layout up', () => {
    for (const inner of [552, 616, 760, 1000, 1500]) {
      const sum = T.columns(inner).reduce((a: number, b: number) => a + b, 0);
      assert.ok(Math.abs(sum - inner) < 0.01, `${inner}: ${sum}`);
    }
  });

  test('the rules column grows first: its notes fit at a 1440 px dashboard (about 600 px of map)', () => {
    assert.ok(T.columns(604)[4] >= 240, `rules column ${T.columns(604)[4]}`);
    assert.ok(T.layout(644, RULES, RELEASES).H >= 300, 'the desktop sizes from 600 px');
  });

  test('a path per track, and one ride per rule and release', () => {
    const g = T.layout(1000, RULES, RELEASES);
    assert.deepEqual(Object.keys(g.paths.toRule).sort(), ['default', 'experiment', 'preview']);
    assert.deepEqual(Object.keys(g.paths.ride).sort(), ['default|shop:1.4', 'experiment|shop:1.4', 'experiment|shop:1.5', 'preview|shop:1.6']);
    assert.deepEqual(g.paths.toRelease.filter((p: any) => p.many).map((p: any) => p.pct), [50, 50]);
    for (const d of Object.values(g.paths.ride) as string[]) assert.doesNotMatch(d, /NaN|undefined/);
  });

  test('works from the live routing too, and with no routing at all', () => {
    const rules = J.trackRules({
      defaultRelease: 'shop:1.4',
      experiment: { id: 7, status: 'running', enrolledPct: 100, arms: [{ key: 'control', release: 'shop:1.4', pct: 50 }, { key: 'v2', release: 'shop:1.5', pct: 50 }] },
      preview: null,
    });
    const g = T.layout(900, rules, ['shop:1.4', 'shop:1.5']);
    assert.equal(g.box.rules.length, 2);
    const empty = T.layout(800, [], ['shop:1.4']);
    assert.deepEqual(empty.box.rules, []);
    assert.equal(empty.box.releases.length, 1);
  });
});

describe('track.js demoPlan: the synthetic dots of a demo', () => {
  test('exactly n dots, shared out by pct, the experiment split evenly, interleaved', () => {
    const plan = T.demoPlan(RULES, 14);
    assert.equal(plan.length, 14);
    const count = (rule: string, release: string) => plan.filter((p: any) => p.rule === rule && p.release === release).length;
    // weights: preview 1, experiment 2 (1 + 1), default 1 → 3.5 + 3.5 + 3.5 + 3.5
    assert.equal(count('experiment', 'shop:1.4') + count('experiment', 'shop:1.5'), 7);
    assert.ok(Math.abs(count('experiment', 'shop:1.4') - count('experiment', 'shop:1.5')) <= 1);
    assert.ok(count('preview', 'shop:1.6') >= 3 && count('default', 'shop:1.4') >= 3);
    assert.ok(new Set(plan.slice(0, 4).map((p: any) => `${p.rule}|${p.release}`)).size >= 3, 'the tracks take turns from the start');
    assert.ok(plan.some((p: any) => p.kind === 'order') && plan.every((p: any) => ['page', 'order'].includes(p.kind)));
  });

  test('a lopsided split stays lopsided; empty tracks get nothing', () => {
    const plan = T.demoPlan([{ id: 'experiment', targets: [{ release: 'a', pct: 90 }, { release: 'b', pct: 10 }, { release: 'c', pct: 0 }] }], 10);
    assert.equal(plan.filter((p: any) => p.release === 'a').length, 9);
    assert.equal(plan.filter((p: any) => p.release === 'b').length, 1);
    assert.equal(plan.filter((p: any) => p.release === 'c').length, 0);
  });

  test('nothing to show: no rules, or n = 0', () => {
    assert.deepEqual(T.demoPlan([], 14), []);
    assert.deepEqual(T.demoPlan(RULES, 0), []);
    assert.deepEqual(T.demoPlan(null, 5), []);
  });
});

describe('track.js: the contract the page and the tour rely on', () => {
  const src = read('track.js');
  test('createTrack returns update, pulse, tickRates, clear, demo, highlight, rates and markYou', () => {
    assert.match(src, /return \{ update, pulse, tickRates, clear, demo, highlight, rates, markYou \};/);
    assert.equal(typeof T.createTrack, 'function');
  });
  test('demo dots are never counted in the rates', () => {
    const demo = src.slice(src.indexOf('function demo('), src.indexOf('function applyFocus('));
    assert.doesNotMatch(demo, /times\./, 'demo() must not touch the arrival times');
  });
  test('labels go in through textContent; reduced motion is honoured', () => {
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML/);
    assert.match(src, /prefers-reduced-motion: reduce/);
  });
});

describe('track.css: owns every track rule, with reduced motion and the legend', () => {
  const css = read('track.css');
  test('the map, its boxes, rails, tags, dots and legend are styled here', () => {
    for (const sel of ['.track-svg', '.rail-feed', '.rail-rule', '.rail-out', '.rail-empty', '.tnode-title', '.pct-tag', '.tdot-order', '.tdot-error', '.track-legend', '.lg-dot']) {
      assert.ok(css.includes(sel), sel);
    }
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.doesNotMatch(css, /https?:\/\//);
  });
  test('rail rules are scoped to the SVG (.rail is also the step rail)', () => {
    for (const m of css.matchAll(/^([^@{}\n][^{}]*)\{/gm)) {
      const selectors = m[1]!.split(',').map((s) => s.trim());
      for (const s of selectors) if (/\.rail\b/.test(s)) assert.match(s, /\.track-svg/, s);
    }
  });
});

describe('fx.js: motion helpers', () => {
  test('exports the helpers the tour and the dashboard use', () => {
    for (const name of ['countUp', 'sweep', 'flashRows', 'grow', 'pulse', 'reducedMotion']) assert.equal(typeof FX[name], 'function', name);
    assert.equal(FX.EASE, 'cubic-bezier(.22,1,.36,1)');
  });

  test('no DOM at import time, no HTML injection, no remote URLs', () => {
    const src = read('fx.js');
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    assert.doesNotMatch(src, /https?:\/\//);
    assert.match(src, /prefers-reduced-motion: reduce/);
  });

  test('under reduced motion every helper lands on its final state at once', async () => {
    const g = globalThis as any;
    const saved = g.matchMedia;
    g.matchMedia = (q: string) => ({ matches: q.includes('reduce') });
    try {
      assert.equal(FX.reducedMotion(), true);
      const el: any = { textContent: '0' };
      await FX.countUp(el, 1234, { format: (n: number) => n.toLocaleString('en-GB') });
      assert.equal(el.textContent, '1,234');
      await FX.countUp(el, 7);
      assert.equal(el.textContent, '7');
      const classes = new Set<string>(['is-sweep']);
      const row: any = { classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } };
      await FX.sweep([row, row], { className: 'is-sweep' });
      assert.equal(classes.has('is-sweep'), false, 'no class left behind');
      await FX.flashRows([]);
      await FX.pulse(null);
      await FX.grow(null);
    } finally {
      g.matchMedia = saved;
    }
  });
});
