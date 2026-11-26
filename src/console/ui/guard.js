// Judge mode's "Health and guard" card: Flagsmith Feature Health reports and the opt-in guard (GET/POST /api/guard).
const token = document.querySelector('meta[name="turnout-console"]')?.content ?? '';
const card = document.getElementById('guard');
const button = document.getElementById('guard-button');
const healthLine = document.getElementById('health-line');
const guardLine = document.getElementById('guard-line');

const time = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');

async function api(method, body) {
  const res = await fetch('/api/guard', {
    method,
    headers: { 'x-turnout-console': token, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 404) return null; // not configured: the card stays hidden
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function healthText(state) {
  if (!state.health.enabled) return 'Feature Health reporting is off (run init to create the provider).';
  const last = state.health.last;
  if (!last) return 'No report yet; the first check runs within 20 seconds.';
  const word = last.status === 'unhealthy' ? 'Unhealthy' : 'Healthy';
  const what = last.delivered ? `Flagsmith shows the flag as ${word}` : `Couldn't tell Flagsmith (${last.error ?? 'no answer'})`;
  return `${what}: ${last.summary} (experiment ${last.experimentId}, ${time(last.at)}).`;
}

export function guardText(state) {
  const a = state.guard.lastAction;
  if (a) return `${a.ok ? '✓' : '✗'} ${a.text} (${time(a.at)})`;
  return state.guard.enabled ? 'Guard on: watching the running experiment.' : 'Guard off: a person decides.';
}

function render(state) {
  if (!state) return;
  card.hidden = false;
  healthLine.textContent = healthText(state);
  healthLine.dataset.status = state.health.last?.status ?? '';
  guardLine.textContent = guardText(state);
  button.textContent = state.guard.enabled ? 'Turn the guard off' : 'Turn the guard on';
  button.setAttribute('aria-pressed', String(state.guard.enabled));
  button.classList.toggle('btn-guard-on', state.guard.enabled);
}

let configured = true; // a 404 means this console has no health bridge (turnout compare): stop asking
async function refresh() {
  if (document.hidden || !configured) return;
  try {
    const state = await api('GET');
    if (state === null) configured = false;
    render(state);
  } catch {
    // the main page shows session problems; this card just waits for the next poll
  }
}

button?.addEventListener('click', async () => {
  button.disabled = true;
  try {
    const current = button.getAttribute('aria-pressed') === 'true';
    render(await api('POST', { enabled: !current }));
  } catch (error) {
    guardLine.textContent = `Couldn't change the guard: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});

if (card) {
  refresh();
  setInterval(refresh, 5000);
}
