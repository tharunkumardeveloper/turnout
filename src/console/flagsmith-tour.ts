// Flagsmith's own dashboard with Turnout's tour on top: a pass-through to Flagsmith (local only, port 8001) that adds
// one script to its pages (ui/fs-tour.js). Flagsmith is unchanged: every request goes to it as it came, and its
// dashboard calls its API by relative path (/config/project-overrides: "api": "/api/v1/"), so it works on this port.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type TourConfig = {
  project: number | string;
  environment: string; // the environment's key, as the dashboard's addresses use it
  flag: string;
  experiment: number | null;
  experimentName: string | null;
  goal: string | null;
  metrics: string[];
};

export const TOUR_SCRIPT = '/__turnout/tour.js';
const TAG = `<script src="${TOUR_SCRIPT}" defer></script>`;

/** Adds the tour's script to a Flagsmith page (before </head>, else at the start of <body>, else at the end). */
export function injectTour(html: string): string {
  if (html.includes(TOUR_SCRIPT)) return html;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${TAG}</head>`);
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, (m) => `${m}${TAG}`);
  return html + TAG;
}

export function createFlagsmithTour(o: { upstream: string; uiDir: string; config: () => Promise<TourConfig> }): http.Server {
  const upstream = new URL(o.upstream);
  return http.createServer(async (req, res) => {
    const path = req.url ?? '/';
    if (path === TOUR_SCRIPT) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return void res.end(readFileSync(join(o.uiDir, 'fs-tour.js')));
    }
    if (path.startsWith('/__turnout/tour-config')) {
      const body = await o.config().catch(() => null);
      res.writeHead(body ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return void res.end(JSON.stringify(body ?? { error: "Turnout couldn't read the flag and experiment from Flagsmith yet" }));
    }
    // Uncompressed answers, so a page can be read and the script added.
    const headers = { ...req.headers, host: upstream.host };
    delete headers['accept-encoding'];
    const up = http.request({ hostname: upstream.hostname, port: upstream.port || 80, path, method: req.method, headers }, (answer) => {
      const type = String(answer.headers['content-type'] ?? '');
      if (!type.includes('text/html')) {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        return void answer.pipe(res);
      }
      const chunks: Buffer[] = [];
      answer.on('data', (c: Buffer) => chunks.push(c));
      answer.on('end', () => {
        const html = injectTour(Buffer.concat(chunks).toString('utf8'));
        const out = { ...answer.headers };
        delete out['content-length'];
        res.writeHead(answer.statusCode ?? 200, out);
        res.end(html);
      });
    });
    up.on('error', (e) => (res.headersSent ? res.end() : res.writeHead(502, { 'content-type': 'text/plain' }).end(`Flagsmith didn't answer: ${e.message}`)));
    req.pipe(up);
  });
}
