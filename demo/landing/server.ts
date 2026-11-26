// A tiny landing page with a "Sign up" button: the second Turnover example. It knows nothing about Flagsmith or
// Turnover. LANDING_VERSION picks the release: 1 (the live page) or 2 (a new headline and button).
import http from 'node:http';

const VERSION = process.env.LANDING_VERSION ?? '1';
const COPY: Record<string, { headline: string; sub: string; button: string; accent: string }> = {
  '1': { headline: 'Plan your week in one place', sub: 'Tasks, notes and a calendar that talk to each other.', button: 'Sign up', accent: '#3b5bdb' },
  '2': { headline: 'Get your Mondays back', sub: 'One list for everything, sorted for you each morning. Free for teams of five.', button: 'Start free, no card', accent: '#2b8a3e' },
};
const copy = COPY[VERSION] ?? COPY['1']!;

const page = (body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Weekly · landing ${VERSION}</title>
<style>
  body { margin: 0; font: 17px/1.5 system-ui, sans-serif; background: #f8f9fa; color: #212529; }
  main { max-width: 34rem; margin: 12vh auto; padding: 0 16px; }
  h1 { font-size: 2.2rem; line-height: 1.15; margin: 0 0 .5rem; }
  form { display: flex; gap: .5rem; margin-top: 1.5rem; flex-wrap: wrap; }
  input { flex: 1 1 14rem; padding: .7rem; font: inherit; border: 1px solid #ced4da; border-radius: 6px; }
  button { padding: .7rem 1.2rem; font: inherit; color: #fff; background: ${copy.accent}; border: 0; border-radius: 6px; cursor: pointer; }
  small { color: #868e96; }
</style></head>
<body><main>${body}<p><small>Release landing:${VERSION}</small></p></main></body></html>`;

const landing = page(`<h1>${copy.headline}</h1><p>${copy.sub}</p>
<form method="post" action="/signup"><input type="email" name="email" placeholder="you@example.com" required aria-label="Email"><button>${copy.button}</button></form>`);
const thanks = page('<h1>Thanks for signing up</h1><p>Check your inbox for a link.</p><p><a href="/">Back</a></p>');

export function createLanding(): http.Server {
  return http.createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(landing);
    }
    if (req.method === 'POST' && path === '/signup') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 10_000) return res.writeHead(413).end();
      }
      const email = new URLSearchParams(body).get('email') ?? '';
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        return res.end('an email address, please');
      }
      // Optional, no SDK: names the conversion for Turnover, which removes this header before the visitor sees it.
      // Used only with goal.header: true in the config; the example's default goal is the POST /signup rule.
      res.writeHead(201, { 'content-type': 'text/html; charset=utf-8', 'x-turnover-event': 'signup' });
      return res.end(thanks);
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('demo/landing/server.ts')) {
  const port = Number(process.env.PORT ?? 8080);
  createLanding().listen(port, () => console.log(`landing:${VERSION} on :${port}`));
}
