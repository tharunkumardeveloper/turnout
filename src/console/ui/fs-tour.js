// Turnout's tour inside Flagsmith's own dashboard. Turnout serves the dashboard through a small pass-through (port
// 8001) that adds this one script; Flagsmith itself is unchanged. Each stop opens a real Flagsmith page, highlights the
// part that matters and says what Turnout does with it. The tour remembers its place across Flagsmith's page changes.
// Every string goes in through textContent.
(() => {
  if (window.top !== window.self || window.__turnoutTour) return;
  window.__turnoutTour = true;
  const KEY = 'turnout-fs-tour';
  const read = () => {
    try {
      return JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
    } catch {
      return null;
    }
  };
  const save = (v) => {
    try {
      if (v === null) sessionStorage.removeItem(KEY);
      else sessionStorage.setItem(KEY, JSON.stringify(v));
    } catch {
      /* not remembered */
    }
  };

  /** The stops: where (a dashboard path), what to highlight (text on the page), and what to say. */
  function stops(c) {
    const env = `/project/${c.project}/environment/${c.environment}`;
    return [
      { path: `${env}/features`, find: [c.flag], title: 'The release flag',
        text: `Turnout keeps one flag, ${c.flag}. Its value is the release everyone gets; its variations are the versions under test. The proxy reads it on every request, so changing it here moves real traffic.` },
      // Pointed at the flag's row: the Unhealthy badge only exists while a version is losing a safety check.
      { path: `${env}/features`, find: ['Unhealthy', c.flag], title: 'Feature Health',
        text: 'When a version loses a safety check (slower pages, more errors), Turnout reports it through Flagsmith\'s Feature Health and an Unhealthy badge appears on this row. With the guard on it also reverts, by itself. No badge means every check passed.' },
      { path: `${env}/experiments`, find: ['Experiments', c.experimentName], title: 'Experiments',
        text: 'Every A/A, A/B or A/B/C test Turnout runs is a Flagsmith experiment on that flag: one running at a time, the older ones kept here.' },
      ...(c.experiment ? [{ path: `${env}/experiments/${c.experiment}`, find: ['Chance to win', 'chance to win', 'Results'], title: "Flagsmith's results",
        text: 'Flagsmith works out who wins: chance to win, the interval, each safety check. Turnout reads exactly these numbers and never computes its own. They refresh at most every 5 minutes.' }] : []),
      { path: `${env}/metrics`, find: c.metrics.length ? c.metrics : ['Metrics'], title: 'Metrics',
        text: `The events Turnout's proxy sends for every visitor: the goal (${c.goal ?? 'page speed'}) and the safety checks (page speed, server errors). No code in your app.` },
      { path: `${env}/identities`, find: ['Identities', 'Identity'], title: 'Identities',
        text: 'Each visitor is an identity. The proxy gives every browser a lasting ID, so Flagsmith puts the same person in the same version every time.' },
      // Not the Audit Log: on self-hosted Flagsmith it is an Enterprise feature, an empty page with "Contact Us".
      { path: `${env}/features`, find: [c.flag], title: 'Ship and Revert',
        text: `Ship is one change to ${c.flag}: Turnout drains the experiment's split and sets the flag's value to the winner, so every visitor gets it from their next page. Revert is the same change back. Nothing is redeployed.` },
    ];
  }

  const css = `
.tt-shade{position:fixed;inset:0;z-index:2147483000;pointer-events:none}
.tt-ring{position:fixed;z-index:2147483001;border-radius:10px;box-shadow:0 0 0 4px #7b51fb,0 0 0 9999px rgba(15,10,40,.45);transition:all .35s cubic-bezier(.2,.8,.2,1);pointer-events:none}
.tt-ring::after{content:'';position:absolute;inset:-8px;border-radius:14px;border:2px solid #7b51fb;opacity:0;animation:tt-pulse 1.8s ease-out infinite}
@keyframes tt-pulse{0%{opacity:.7;transform:scale(.97)}100%{opacity:0;transform:scale(1.06)}}
.tt-card{position:fixed;z-index:2147483002;width:340px;max-width:calc(100vw - 24px);right:24px;bottom:24px;background:#fff;color:#1a2634;border-radius:14px;box-shadow:0 24px 60px -18px rgba(15,10,40,.55);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;overflow:hidden;animation:tt-in .35s cubic-bezier(.2,.9,.3,1.15)}
@keyframes tt-in{from{opacity:0;transform:translateY(14px) scale(.97)}}
.tt-top{display:flex;align-items:center;gap:8px;padding:10px 14px;background:linear-gradient(120deg,#7b51fb,#5f3dc4);color:#fff;font-weight:700;font-size:12.5px;letter-spacing:.02em}
.tt-top span{flex:1}.tt-x{border:0;background:transparent;color:#fff;font-size:16px;cursor:pointer;opacity:.85}
.tt-body{padding:14px 16px 6px}.tt-body h3{margin:0 0 6px;font-size:16px;color:#1a2634!important}.tt-body p{margin:0;color:#4b5565!important}
.tt-miss{margin-top:8px;font-size:12.5px;color:#9a6700}
.tt-dots{display:flex;gap:5px;padding:10px 16px 0}.tt-dots i{width:7px;height:7px;border-radius:50%;background:#e2e8f0}.tt-dots i.on{background:#7b51fb;width:18px;border-radius:4px}
.tt-foot{display:flex;gap:8px;justify-content:flex-end;padding:12px 16px 14px}
.tt-btn{border:1px solid #d0d7de;background:#fff;color:#1a2634;border-radius:8px;padding:6px 12px;font:600 13px system-ui,sans-serif;cursor:pointer}
.tt-btn.pri{background:#7b51fb;border-color:#7b51fb;color:#fff}.tt-btn:disabled{opacity:.45;cursor:default}
.tt-launch{position:fixed;z-index:2147483002;right:20px;bottom:20px;border:0;border-radius:999px;padding:10px 16px;background:#7b51fb;color:#fff;font:700 13px system-ui,sans-serif;box-shadow:0 12px 30px -10px rgba(123,81,251,.8);cursor:pointer}
@media (prefers-reduced-motion:reduce){.tt-ring,.tt-card{transition:none;animation:none}.tt-ring::after{display:none}}`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  let config = null;
  let ring = null;
  let card = null;
  let launch = null;
  let observer = null;

  /** The visible element whose own text best matches one of the words (the smallest such element). */
  function findTarget(words) {
    const wanted = words.filter(Boolean).map((w) => String(w).toLowerCase());
    let best = null;
    for (const node of document.querySelectorAll('body *:not(script):not(style)')) {
      if (node.closest('.tt-card,.tt-launch')) continue;
      const own = [...node.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join(' ').trim().toLowerCase();
      if (!own || !wanted.some((w) => own.includes(w))) continue;
      const r = node.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight) continue;
      if (!best || r.width * r.height < best.r.width * best.r.height) best = { node, r };
    }
    return best?.node ?? null;
  }

  function place(target) {
    if (!ring) {
      ring = el('div', 'tt-ring');
      document.body.append(ring);
    }
    if (!target) {
      ring.style.cssText = 'left:50%;top:50%;width:0;height:0;box-shadow:0 0 0 9999px rgba(15,10,40,.35)';
      return;
    }
    const pad = 6;
    const box = (target.closest('a,button,tr,li,[role="row"],[class*="card"],[class*="panel"]') ?? target).getBoundingClientRect();
    ring.style.cssText = `left:${box.left - pad}px;top:${box.top - pad}px;width:${box.width + pad * 2}px;height:${box.height + pad * 2}px`;
  }

  function show(i) {
    const list = stops(config);
    if (i < 0 || i >= list.length) return end();
    const stop = list[i];
    save({ i });
    if (location.pathname.replace(/\/$/, '') !== stop.path) {
      location.assign(stop.path); // Flagsmith's page; the tour picks up again when it loads
      return;
    }
    launch?.remove();
    launch = null;
    card?.remove();
    card = el('div', 'tt-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Turnout tour of Flagsmith');
    const top = el('div', 'tt-top');
    top.append(el('span', '', `Turnout in Flagsmith · ${i + 1} of ${list.length}`));
    const x = el('button', 'tt-x', '✕');
    x.title = 'End the tour';
    x.addEventListener('click', end);
    top.append(x);
    const body = el('div', 'tt-body');
    body.append(el('h3', '', stop.title), el('p', '', stop.text));
    const miss = el('p', 'tt-miss', '');
    body.append(miss);
    const dots = el('div', 'tt-dots');
    list.forEach((_, k) => dots.append(el('i', k === i ? 'on' : '')));
    const foot = el('div', 'tt-foot');
    const back = el('button', 'tt-btn', 'Back');
    back.disabled = i === 0;
    back.addEventListener('click', () => show(i - 1));
    const next = el('button', 'tt-btn pri', i === list.length - 1 ? 'Done' : 'Next');
    next.addEventListener('click', () => show(i + 1));
    foot.append(back, next);
    card.append(top, body, dots, foot);
    document.body.append(card);
    next.focus();
    // Flagsmith draws its pages after loading: look for the part until it appears (or say where to look).
    let tries = 0;
    const seek = () => {
      const target = findTarget(stop.find);
      place(target);
      miss.textContent = target || tries < 12 ? '' : 'Still loading, or not on this page yet: run a test from the console and it appears here.';
      if (!target && tries++ < 24) setTimeout(seek, 400);
    };
    seek();
    observer?.disconnect();
    observer = new MutationObserver(() => place(findTarget(stop.find)));
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function end() {
    save(null);
    observer?.disconnect();
    ring?.remove();
    card?.remove();
    ring = card = null;
    offer();
  }

  function offer() {
    if (launch) return;
    launch = el('button', 'tt-launch', '✦ Turnout tour');
    launch.title = 'What Turnout does in Flagsmith, page by page';
    launch.addEventListener('click', () => show(0));
    document.body.append(launch);
  }

  async function start() {
    try {
      config = await (await fetch('/__turnout/tour-config', { cache: 'no-store' })).json();
    } catch {
      return;
    }
    if (!config?.project) return;
    // Flagsmith's login page has nothing to show yet; the tour waits for the dashboard.
    const loggedOut = () => /\/login|\/signup|^\/$/.test(location.pathname) && !/\/project\//.test(location.pathname);
    const params = new URLSearchParams(location.search);
    const saved = read();
    if (params.has('turnout_tour') && !saved) save({ i: 0 });
    const resume = () => {
      if (loggedOut()) return void setTimeout(resume, 1500);
      const at = read();
      if (at) show(at.i);
      else offer();
    };
    resume();
    addEventListener('resize', () => card && read() && place(findTarget(stops(config)[read().i]?.find ?? [])));
    addEventListener('scroll', () => card && read() && place(findTarget(stops(config)[read().i]?.find ?? [])), true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else void start();
})();
