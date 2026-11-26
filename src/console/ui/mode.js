// One page: the console, with Judge mode as a switch in its bar (beside Tour). On, the console's cards make way for
// the judge view: the same test, step by step, one button at a time, with Play it for me. The choice is in the address
// (?mode=judge, so a link can open it) and remembered in this browser.
// Judge mode is the demo shop's guided view; your own app's test (Try it) is on its own console, /app.
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const meta = (name) => (typeof document === "undefined" ? null : document.querySelector(`meta[name="${name}"]`));
const BASE = meta('turnout-base')?.getAttribute('content') ?? '';
const KEY = 'turnout-mode';

/** Where the judge view comes from: judge mode for the demo shop, or Try it's page for your own app. */
export function frameSrc(base, params) {
  const q = new URLSearchParams({ embed: '1', ...(params.get('play') === '1' ? { play: '1' } : {}) });
  return `${base || ''}${base ? '' : '/judge'}?${q}`;
}

/** Judge mode on or off: from the address first, then this browser's last choice; the public page starts on. */
export function initialMode(params, stored, isPublic) {
  if (params.get('mode') === 'judge') return true;
  if (params.get('mode') === 'console') return false;
  if (stored === 'judge' || stored === 'console') return stored === 'judge';
  return isPublic;
}

export function setupMode() {
  const sw = $('mode-judge');
  const view = $('judge-view');
  const frame = /** @type {HTMLIFrameElement} */ ($('judge-frame'));
  if (!sw || !view || meta('turnout-no-judge')) return { isOn: () => false, tour: () => false };
  sw.hidden = false;
  const params = new URLSearchParams(location.search);
  let stored = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {
    /* private window: no memory, the default */
  }
  let on = false;
  function set(next, remember = true) {
    on = next;
    sw.setAttribute('aria-checked', String(on));
    // Says its state in words, not only by the knob's colour.
    const label = sw.querySelector('.mode-label');
    if (label) label.textContent = on ? 'Judge mode: on' : 'Judge mode: off';
    document.body.classList.toggle('judge-on', on);
    view.hidden = !on;
    if (on && !frame.getAttribute('src')) frame.setAttribute('src', frameSrc(BASE, params));
    if (remember) {
      try {
        localStorage.setItem(KEY, on ? 'judge' : 'console');
      } catch {
        /* not remembered */
      }
      const url = new URL(location.href);
      url.searchParams.set('mode', on ? 'judge' : 'console');
      if (!on) for (const k of ['app', 'play']) url.searchParams.delete(k);
      history.replaceState(null, '', url);
    }
  }
  set(initialMode(params, stored, BASE === '/judge'), false);
  sw.addEventListener('click', () => set(!on));
  return {
    isOn: () => on,
    /** The Tour button while Judge mode is on: the judge view's own tour. */
    tour: () => {
      if (!on) return false;
      frame.contentWindow?.postMessage({ turnout: 'tour' }, location.origin);
      return true;
    },
  };
}
