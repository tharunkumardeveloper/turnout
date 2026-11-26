// Live traffic feed for the console: the proxy publishes every routed request, the console subscribes over SSE.
// Served on an internal port that compose doesn't publish.
import http from 'node:http';
import type { TrafficEvent } from './server.ts';

const WINDOW_MS = 60_000;
const MAX_RECENT = 50_000; // bounds memory under a traffic spike
const MAX_BUFFERED = 1 << 20; // a subscriber that stops reading is dropped, not buffered forever
const MAX_CLIENTS = 20;

export class TrafficFeed {
  private clients = new Set<http.ServerResponse>();
  private recent: TrafficEvent[] = [];

  publish(event: TrafficEvent): void {
    this.recent.push(event);
    this.trim(event.at);
    if (this.recent.length > MAX_RECENT) this.recent.splice(0, this.recent.length - MAX_RECENT);
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.clients) {
      if (res.writableLength > MAX_BUFFERED) {
        this.clients.delete(res);
        res.destroy();
      } else {
        res.write(line);
      }
    }
  }

  // Requests per variant over the last minute, for the lever and the counters.
  summary(now = Date.now()): { windowSeconds: number; byVariant: Record<string, { requests: number; pages: number; conversions: number }> } {
    this.trim(now);
    const byVariant: Record<string, { requests: number; pages: number; conversions: number }> = {};
    for (const e of this.recent) {
      const v = (byVariant[e.variant] ??= { requests: 0, pages: 0, conversions: 0 });
      v.requests++;
      if (e.document) v.pages++;
      if (e.converted) v.conversions++;
    }
    return { windowSeconds: WINDOW_MS / 1000, byVariant };
  }

  subscribe(res: http.ServerResponse): void {
    if (this.clients.size >= MAX_CLIENTS) {
      res.writeHead(503).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': connected\n\n');
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }

  private trim(now: number): void {
    const cutoff = now - WINDOW_MS;
    let drop = 0;
    while (drop < this.recent.length && this.recent[drop]!.at < cutoff) drop++;
    if (drop) this.recent.splice(0, drop);
  }
}

export function createFeedServer(feed: TrafficFeed): http.Server {
  return http.createServer((req, res) => {
    if (req.url === '/traffic') return feed.subscribe(res);
    if (req.url === '/summary') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(feed.summary()));
    }
    if (req.url === '/health') return res.writeHead(200).end('ok');
    res.writeHead(404).end();
  });
}
