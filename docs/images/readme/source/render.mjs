// Renders the README's images (header, how it works, numbers, tech stack), light and dark, at 2x.
//   node docs/images/readme/source/render.mjs .   (needs Playwright: npx playwright install chromium)
// Logos: Devicon (MIT) and Simple Icons (CC0, Caddy); Flagsmith's is src/console/ui/flagsmith-logo.png.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = process.argv[2];
const here = dirname(fileURLToPath(import.meta.url));
const out = join(repo, 'docs/images/readme');
mkdirSync(out, { recursive: true });
const data = (p, type) => `data:${type};base64,${readFileSync(p).toString('base64')}`;
const logo = (n) => data(join(here, 'logos', `${n}.svg`), 'image/svg+xml');
const flagsmith = data(join(repo, 'src/console/ui/flagsmith-logo.png'), 'image/png');

const THEMES = {
  light: { bg: '#ffffff', bg2: '#f5f3ff', ink: '#0f172a', soft: '#475569', faint: '#94a3b8', line: '#e2e8f0', card: '#ffffff', node: '#0f172a', nodeInk: '#f8fafc', accent: '#6633ff', a: '#2563eb', b: '#16a34a', tile: '#ffffff' },
  dark: { bg: '#0d1117', bg2: '#151b2e', ink: '#f1f5f9', soft: '#a1acbd', faint: '#64748b', line: '#283041', card: '#161b26', node: '#f8fafc', nodeInk: '#0f172a', accent: '#a78bfa', a: '#60a5fa', b: '#4ade80', tile: '#f8fafc' },
};

const mark = (t, size) => `<svg width="${size}" height="${size}" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${t.node === '#0f172a' ? '#0f172a' : '#1e293b'}"/><path d="M4 16h9c5 0 6-8 14-8" fill="none" stroke="#2563eb" stroke-width="3.5" stroke-linecap="round"/><path d="M13 16c5 0 6 8 14 8" fill="none" stroke="#16a34a" stroke-width="3.5" stroke-linecap="round"/><circle cx="13" cy="16" r="3.5" fill="#f8fafc"/></svg>`;

const base = (t) => `
  * { box-sizing: border-box; margin: 0; }
  body { font-family: "Segoe UI", Inter, system-ui, sans-serif; color: ${t.ink}; background: transparent; }
  .frame { background: linear-gradient(135deg, ${t.bg} 0%, ${t.bg2} 100%); border: 1px solid ${t.line}; border-radius: 22px; overflow: hidden; position: relative; }
`;

// ---- header: brand, promise, and the split it makes -------------------------------------------------------------
function header(t) {
  const dots = (n, color, y0) => Array.from({ length: n }, (_, i) => `<circle cx="${560 + i * 46}" cy="${y0}" r="7" fill="${color}" opacity="${0.35 + (i / n) * 0.65}"/>`).join('');
  return `<style>${base(t)}
    .frame { width: 1280px; height: 400px; padding: 52px 60px; display: grid; grid-template-columns: 560px 1fr; gap: 20px; }
    .brand { display: flex; align-items: center; gap: 18px; }
    .word { font-size: 64px; font-weight: 800; letter-spacing: -0.03em; }
    h1 { margin-top: 26px; font-size: 31px; line-height: 1.2; font-weight: 700; letter-spacing: -0.01em; }
    h1 em { font-style: normal; color: ${t.accent}; }
    p.sub { margin-top: 14px; font-size: 19px; line-height: 1.5; color: ${t.soft}; }
    .chips { position: absolute; left: 60px; bottom: 40px; display: flex; gap: 10px; }
    .chip { display: inline-flex; align-items: center; gap: 8px; padding: 7px 14px; border-radius: 999px; font-size: 14.5px; font-weight: 600; color: ${t.soft}; background: ${t.card}; border: 1px solid ${t.line}; }
    .chip img { width: 18px; height: 18px; border-radius: 4px; }
    svg.flow text { font-family: "Segoe UI", Inter, system-ui, sans-serif; }
  </style>
  <div class="frame" id="shot">
    <div>
      <div class="brand">${mark(t, 64)}<span class="word">Turnout</span></div>
      <h1>A/B test whole website releases<br>on <em>self-hosted Flagsmith</em></h1>
      <p class="sub">No app code. Flagsmith picks the winner;<br>one flag change moves everyone to it.</p>
    </div>
    <svg class="flow" viewBox="0 0 620 300" width="620" height="300" style="margin-top:-6px">
      <defs><marker id="ar" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="${t.faint}"/></marker></defs>
      <!-- Flagsmith -->
      <rect x="190" y="8" width="240" height="56" rx="14" fill="${t.card}" stroke="${t.accent}" stroke-width="2"/>
      <image href="${flagsmith}" x="206" y="20" width="32" height="32"/>
      <text x="248" y="34" font-size="17" font-weight="700" fill="${t.ink}">Flagsmith</text>
      <text x="248" y="53" font-size="13" fill="${t.soft}">flag · experiment · results</text>
      <path d="M296 70 V112" stroke="${t.accent}" stroke-width="2" stroke-dasharray="5 5" marker-end="url(#ar)"/>
      <path d="M324 112 V70" stroke="${t.accent}" stroke-width="2" stroke-dasharray="5 5" marker-end="url(#ar)"/>
      <!-- visitors -->
      <text x="0" y="154" font-size="14" font-weight="600" fill="${t.soft}">Visitors</text>
      ${[0, 1, 2, 3].map((i) => `<circle cx="${12 + i * 26}" cy="${178}" r="8" fill="${t.faint}" opacity="${0.4 + i * 0.2}"/>`).join('')}
      <path d="M112 178 H222" stroke="${t.faint}" stroke-width="2.5" marker-end="url(#ar)"/>
      <!-- Turnout -->
      <rect x="230" y="122" width="160" height="112" rx="18" fill="${t.node}"/>
      <path d="M262 178h26c14 0 17-22 38-22" fill="none" stroke="#2563eb" stroke-width="6" stroke-linecap="round"/>
      <path d="M288 178c14 0 17 22 38 22" fill="none" stroke="#16a34a" stroke-width="6" stroke-linecap="round"/>
      <circle cx="288" cy="178" r="7" fill="${t.nodeInk === '#f8fafc' ? '#f8fafc' : '#0f172a'}"/>
      <text x="310" y="222" font-size="14" font-weight="700" fill="${t.nodeInk}" text-anchor="middle">Turnout proxy</text>
      <!-- lanes -->
      <path d="M392 150 C440 150 440 112 488 112" fill="none" stroke="${t.a}" stroke-width="3"/>
      <path d="M392 206 C440 206 440 244 488 244" fill="none" stroke="${t.b}" stroke-width="3"/>
      <rect x="488" y="86" width="130" height="52" rx="12" fill="${t.card}" stroke="${t.a}" stroke-width="2"/>
      <text x="504" y="108" font-size="15" font-weight="800" fill="${t.a}">A</text>
      <text x="524" y="108" font-size="15" font-weight="700" fill="${t.ink}">v1.4</text>
      <text x="504" y="127" font-size="12.5" fill="${t.soft}">what's live</text>
      <rect x="488" y="218" width="130" height="52" rx="12" fill="${t.card}" stroke="${t.b}" stroke-width="2.5"/>
      <text x="504" y="240" font-size="15" font-weight="800" fill="${t.b}">B</text>
      <text x="524" y="240" font-size="15" font-weight="700" fill="${t.ink}">v1.5</text>
      <text x="504" y="259" font-size="12.5" fill="${t.b}" font-weight="700">✓ 99% sure: ship</text>
    </svg>
    <div class="chips">
      <span class="chip"><img src="${flagsmith}" alt="">Toggle Wars · Track 03</span>
      <span class="chip">Flagsmith 2.291 self-hosted</span>
      <span class="chip">Any stack · zero app code</span>
    </div>
  </div>`;
}

// ---- how it works: five steps ------------------------------------------------------------------------------------
function how(t) {
  const steps = [
    ['1', 'A visitor arrives', 'Turnout sits at the front door and gives them a stable id (a cookie).'],
    ['2', 'Flagsmith picks the version', 'One multivariate flag, evaluated locally in the proxy: no network call.'],
    ['3', 'Turnout serves it', 'Same URL, the version Flagsmith chose. The visitor keeps it on every visit.'],
    ['4', 'HTTP becomes events', 'Page loads, speed, errors and the goal (a checkout, a sign-up) go to Flagsmith.'],
    ['5', 'Flagsmith decides', 'Its Bayesian result says ship, keep running or revert. Ship is one flag change.'],
  ];
  return `<style>${base(t)}
    .frame { width: 1280px; padding: 34px 36px; }
    .row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 16px; }
    .step { position: relative; background: ${t.card}; border: 1px solid ${t.line}; border-radius: 16px; padding: 20px 18px 20px; }
    .step:not(:last-child)::after { content: ""; position: absolute; right: -14px; top: 38px; width: 12px; height: 12px; border-top: 2.5px solid ${t.faint}; border-right: 2.5px solid ${t.faint}; transform: rotate(45deg); }
    .n { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; font-weight: 800; font-size: 16px; color: #fff; background: ${t.accent}; }
    .step:nth-child(2) .n, .step:nth-child(5) .n { background: #6633ff; }
    .step:nth-child(3) .n { background: linear-gradient(135deg, #2563eb 50%, #16a34a 50%); }
    h3 { margin-top: 14px; font-size: 18px; line-height: 1.25; }
    p { margin-top: 8px; font-size: 14.5px; line-height: 1.5; color: ${t.soft}; }
    .tag { display: inline-block; margin-top: 12px; font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: ${t.accent}; }
    .foot { margin-top: 18px; font-size: 14.5px; color: ${t.soft}; text-align: center; }
    .foot b { color: ${t.ink}; }
  </style>
  <div class="frame" id="shot">
    <div class="row">${steps.map(([n, h, p], i) => `<div class="step"><div class="n">${n}</div><h3>${h}</h3><p>${p}</p><span class="tag">${i === 0 || i === 2 ? 'Turnout' : i === 3 ? 'Turnout → Flagsmith' : 'Flagsmith'}</span></div>`).join('')}</div>
    <p class="foot"><b>Turnout computes no statistics:</b> every number comes from Flagsmith's API. Your app never changes.</p>
  </div>`;
}

// ---- the numbers ------------------------------------------------------------------------------------------------
function numbers(t) {
  const cards = [
    ['105 / 111', 'blind rounds decided right', 'hidden true rates, graded after'],
    ['14 → 1', 'bad releases shipped', 'a 95% rule alone vs Turnout'],
    ['0 / 68,141', 'events lost under load', 'counted in Flagsmith’s own table'],
    ['39 / 53', 'public GitHub repos', 'built, tested and shipped from a link'],
  ];
  return `<style>${base(t)}
    .frame { width: 1280px; padding: 24px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
    .c { background: ${t.card}; border: 1px solid ${t.line}; border-radius: 16px; padding: 20px 22px; }
    .big { font-size: 38px; font-weight: 800; letter-spacing: -0.02em; color: ${t.accent}; }
    .c:nth-child(2) .big { color: ${t.b}; }
    .what { margin-top: 4px; font-size: 17px; font-weight: 700; }
    .how { margin-top: 4px; font-size: 14px; color: ${t.soft}; }
  </style>
  <div class="frame" id="shot">${cards.map(([b, w, h]) => `<div class="c"><div class="big">${b}</div><div class="what">${w}</div><div class="how">${h}</div></div>`).join('')}</div>`;
}

// ---- tech stack: official logos, no words -----------------------------------------------------------------------
function stack(t) {
  const logos = [['flagsmith', flagsmith], ...['nodejs', 'typescript', 'javascript', 'docker', 'postgresql', 'caddy', 'githubactions', 'azure'].map((n) => [n, logo(n)])];
  return `<style>${base(t)}
    .row { display: inline-flex; gap: 18px; padding: 6px; }
    .tile { width: 96px; height: 96px; border-radius: 22px; display: grid; place-items: center; background: ${t.tile}; border: 1px solid ${t.line}; box-shadow: 0 4px 14px rgb(15 23 42 / ${t.bg === '#ffffff' ? 0.06 : 0.35}); }
    .tile img { width: 56px; height: 56px; object-fit: contain; }
    .tile.fs img { width: 60px; height: 60px; border-radius: 12px; }
  </style>
  <div class="row" id="shot">${logos.map(([n, src]) => `<div class="tile${n === 'flagsmith' ? ' fs' : ''}"><img src="${src}" alt="${n}"></div>`).join('')}</div>`;
}

// ---- small line icons (24×24, stroke) for the cards ---------------------------------------------------------------
const ICON = {
  run: '<path d="M7 4v16l13-8z"/>',
  measure: '<path d="M4 19h16"/><path d="M7 16V10"/><path d="M12 16V6"/><path d="M17 16v-4"/>',
  decide: '<path d="M12 3v18"/><path d="M5 7h14"/><path d="M5 7l-3 7h6z"/><path d="M19 7l-3 7h6z"/>',
  release: '<path d="M5 12h12"/><path d="M13 6l6 6-6 6"/>',
  see: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M7 14l3-4 3 3 4-5"/>',
  automate: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
  install: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 20h16"/>',
  prove: '<path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/>',
};
const icon = (k, color) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg>`;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const code = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

// ---- every feature, eight cards ----------------------------------------------------------------------------------
function features(t) {
  const cards = [
    ['run', 'Run a test', ['`turnout compare` on URLs, images or git branches', 'Try it with your app: paste GitHub links', 'A/A, A/B and A/B/C tests']],
    ['measure', 'Measure', ['The goal from any HTTP request', 'Server speed and errors on every page', 'Page speed in real browsers', 'Bots never counted, one id per visitor']],
    ['decide', 'Decide', ['Flagsmith’s Bayesian result, as returned', 'Ships at 95% only if the interval clears zero', 'Safety checks, and how many more visitors']],
    ['release', 'Release', ['Ship or Revert: one flag change', 'A preview segment for your team', 'Pin my browser; Feature Health']],
    ['see', 'See it', ['A live traffic map', 'A guided demo, and tours', 'A setup check with 28 checks', 'Every Flagsmith feature, read live']],
    ['automate', 'Automate', ['A GitHub Action with a PR comment', 'An agent skill that stops for a person', 'Server mode with HTTPS', '`turnout deploy` for nginx or Caddy']],
    ['install', 'Install', ['One line on Windows, macOS, Linux', 'Codespaces: nothing to install', 'A public image on GHCR', '`turnout uninstall` removes it all']],
    ['prove', 'Prove it', ['Blind rounds with hidden true rates', 'Simulated shoppers, real Chrome visits', 'The Experiment Doctor, with SRM']],
  ];
  const colors = [t.accent, t.a, t.b, t.b, t.a, t.accent, t.a, t.b];
  return `<style>${base(t)}
    .frame { width: 1280px; padding: 24px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
    .c { background: ${t.card}; border: 1px solid ${t.line}; border-radius: 16px; padding: 18px 18px 16px; }
    .h { display: flex; align-items: center; gap: 10px; }
    .ic { width: 38px; height: 38px; border-radius: 11px; display: grid; place-items: center; }
    h3 { font-size: 22px; }
    ul { margin-top: 12px; padding-left: 0; list-style: none; display: grid; gap: 7px; }
    li { font-size: 17.5px; line-height: 1.38; color: ${t.soft}; padding-left: 14px; position: relative; }
    li::before { content: ""; position: absolute; left: 0; top: 8px; width: 5px; height: 5px; border-radius: 50%; background: ${t.faint}; }
    code { font-family: Consolas, "Cascadia Mono", monospace; font-size: 15.5px; color: ${t.ink}; background: ${t.bg2}; padding: 1px 5px; border-radius: 5px; }
  </style>
  <div class="frame" id="shot">${cards.map(([k, h, items], i) => `<div class="c"><div class="h"><span class="ic" style="background:${colors[i]}1f">${icon(k, colors[i])}</span><h3>${h}</h3></div><ul>${items.map((x) => `<li>${code(x)}</li>`).join('')}</ul></div>`).join('')}</div>`;
}

// ---- the Flagsmith loop: four rounds, the Flagsmith features in each ----------------------------------------------
function loop(t) {
  const rounds = [
    ['01', 'Create a flag', ['Multivariate flag', 'Local evaluation', 'Tags'], 'One flag holds every version; the proxy evaluates it in-process for each visitor.'],
    ['02', 'Pick a metric', ['Metrics', 'Events', 'Event store'], 'Plain HTTP becomes Flagsmith events: the goal, speed, errors, browser page speed.'],
    ['03', 'Split the traffic', ['Experiments', 'Segments', 'Identity overrides'], 'Each test is a Flagsmith experiment; your team previews through a segment.'],
    ['04', 'Ship the winner', ['Bayesian results', 'Environment default', 'Feature Health'], 'Flagsmith decides; Ship sets the default and drains the split in one change.'],
  ];
  return `<style>${base(t)}
    .frame { width: 1280px; padding: 26px 26px 22px; }
    .top { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
    .top img { width: 34px; height: 34px; border-radius: 8px; }
    .top b { font-size: 24px; }
    .top span { font-size: 17px; color: ${t.soft}; }
    .row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
    .r { position: relative; background: ${t.card}; border: 1px solid ${t.line}; border-top: 4px solid ${t.accent}; border-radius: 14px; padding: 16px 16px 18px; }
    .r:not(:last-child)::after { content: ""; position: absolute; right: -14px; top: 44px; width: 12px; height: 12px; border-top: 2.5px solid ${t.faint}; border-right: 2.5px solid ${t.faint}; transform: rotate(45deg); }
    .n { font-size: 12.5px; font-weight: 800; letter-spacing: .08em; color: ${t.accent}; }
    h3 { margin-top: 4px; font-size: 23px; }
    .chips { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 6px; }
    .chip { font-size: 15px; font-weight: 700; padding: 5px 9px; border-radius: 999px; color: ${t.accent}; background: ${t.accent}1a; border: 1px solid ${t.accent}40; }
    p { margin-top: 12px; font-size: 17px; line-height: 1.45; color: ${t.soft}; }
  </style>
  <div class="frame" id="shot">
    <div class="top"><img src="${flagsmith}" alt=""><b>The Flagsmith experiment loop, run by Turnout</b><span>· self-hosted Flagsmith 2.291 · every number from its API</span></div>
    <div class="row">${rounds.map(([n, h, chips, p]) => `<div class="r"><div class="n">ROUND ${n}</div><h3>${h}</h3><div class="chips">${chips.map((c) => `<span class="chip">${c}</span>`).join('')}</div><p>${p}</p></div>`).join('')}</div>
  </div>`;
}

// ---- live demo or your machine -------------------------------------------------------------------------------------
function compare(t) {
  const rows = [
    ['Run guided A/A, A/B and A/B/C tests yourself', true, true],
    ['Blind rounds, and the live traffic map', true, true],
    ['Be a visitor: Flagsmith gives you a version', true, true],
    ['Every Flagsmith feature Turnout uses, read live', 'read-only', true],
    ['Flagsmith’s dashboard, with Turnout’s tour inside it', false, true],
    ['Try it with your app: GitHub links, no Dockerfile', false, true],
    ['Your own site: turnout compare, browsers, simulate', false, true],
    ['Preview for your team, Pin my browser, the guard', false, true],
  ];
  const cell = (v) => v === true ? `<span class="yes">✓</span>` : v === false ? `<span class="no">—</span>` : `<span class="part">${v}</span>`;
  return `<style>${base(t)}
    .frame { width: 1280px; padding: 24px 26px; display: grid; grid-template-columns: 1fr 1fr; gap: 26px; align-items: start; }
    table { width: 100%; border-collapse: collapse; font-size: 18px; }
    th { text-align: left; font-size: 13px; letter-spacing: .05em; text-transform: uppercase; color: ${t.soft}; padding: 0 10px 10px; }
    th.c, td.c { text-align: center; width: 120px; }
    td { padding: 10px; border-top: 1px solid ${t.line}; }
    .yes { color: ${t.b}; font-weight: 800; font-size: 18px; }
    .no { color: ${t.faint}; font-weight: 800; }
    .part { font-size: 12.5px; font-weight: 700; color: ${t.accent}; }
    .side { display: grid; gap: 14px; }
    .box { background: ${t.card}; border: 1px solid ${t.line}; border-radius: 14px; padding: 16px 18px; }
    .box h3 { font-size: 20px; }
    .box p { margin-top: 6px; font-size: 17px; line-height: 1.5; color: ${t.soft}; }
    .box code { font-family: Consolas, monospace; font-size: 13px; color: ${t.ink}; }
    .live { border-left: 4px solid ${t.a}; } .local { border-left: 4px solid ${t.b}; } .run { border-left: 4px solid ${t.accent}; }
    .run pre { margin-top: 10px; font-family: Consolas, "Cascadia Mono", monospace; font-size: 16.5px; line-height: 1.6; color: ${t.ink}; }
    .run .c { color: ${t.faint}; }
  </style>
  <div class="frame" id="shot">
    <table><thead><tr><th></th><th class="c">Live demo</th><th class="c">Your machine</th></tr></thead>
      <tbody>${rows.map(([what, a, b]) => `<tr><td>${what}</td><td class="c">${cell(a)}</td><td class="c">${cell(b)}</td></tr>`).join('')}</tbody></table>
    <div class="side">
      <div class="box live"><h3>Live demo: nothing to install</h3><p>One shared server running the whole loop. Open it and run a test yourself in about a minute.</p></div>
      <div class="box local"><h3>Your machine: every feature</h3><p>A public server can’t run strangers’ code or hand out Flagsmith’s admin login, so those run locally. Docker, then one line, then <code>turnout demo</code>.</p></div>
      <div class="box run"><h3>Run it in one line</h3>
        <pre><span class="c"># Windows (PowerShell)</span>
irm …/turnout/main/install.ps1 | iex
<span class="c"># macOS, Linux</span>
curl -fsSL …/turnout/main/install.sh | sh
turnout demo</pre></div>
    </div>
  </div>`;
}

// ---- given back to Flagsmith ------------------------------------------------------------------------------------
function upstream(t) {
  const cards = [
    ['Flagsmith #9120', 'Completing an experiment kept the old split', '150 of 300 visitors stayed on it (2.291.0). Already fixed in 2.295.2; Flagsmith rewrote its docs after the report (#9141).', 'docs updated'],
    ['Node SDK #330 · PR #331', 'Events dropped under load', '28% of events tracked faster than one batch round-trip were lost. The PR reports every drop: onEventsDropped, droppedEvents.', 'fix proposed'],
    ['Node SDK #332', 'Self-hosted events went to Flagsmith Cloud', 'Pointed at your own Flagsmith, the SDK still sent experiment events to the cloud unless eventsApiUrl is set.', 'reported'],
  ];
  return `<style>${base(t)}
    .frame { width: 1280px; padding: 22px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
    .c { background: ${t.card}; border: 1px solid ${t.line}; border-radius: 14px; padding: 18px; }
    .top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .id { display: inline-flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 800; color: ${t.accent}; }
    .id img { width: 20px; height: 20px; border-radius: 5px; }
    .tag { font-size: 11.5px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; color: ${t.b}; background: ${t.b}1f; padding: 4px 8px; border-radius: 999px; }
    h3 { margin-top: 12px; font-size: 21px; line-height: 1.3; }
    p { margin-top: 8px; font-size: 17px; line-height: 1.5; color: ${t.soft}; }
  </style>
  <div class="frame" id="shot">${cards.map(([id, h, p, tag]) => `<div class="c"><div class="top"><span class="id"><img src="${flagsmith}" alt="">${id}</span><span class="tag">${tag}</span></div><h3>${h}</h3><p>${p}</p></div>`).join('')}</div>`;
}

const b = await chromium.launch();
for (const [name, fn] of Object.entries({ header, how, numbers, stack, features, loop, compare, upstream })) {
  for (const theme of ['light', 'dark']) {
    const p = await b.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
    await p.setContent(`<!doctype html><html><body style="padding:10px">${fn(THEMES[theme])}</body></html>`);
    await p.waitForTimeout(300);
    await p.locator('#shot').screenshot({ path: join(out, `${name}-${theme}.png`), omitBackground: true });
    await p.close();
  }
}
await b.close();
console.log('written to', out);
