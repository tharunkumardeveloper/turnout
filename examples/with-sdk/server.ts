// The demo shop's experiment written the usual way: Flagsmith's Node SDK inside the app, by hand. It exists to be
// measured against Turnout (examples/with-sdk/README.md): the same flag, the same exposures and the same four events,
// with all three releases in one process because the app now has to choose its release per visitor.
//   FLAGSMITH_SERVER_KEY=ser.… FLAGSMITH_API_URL=http://127.0.0.1:8000/api/v1/ node examples/with-sdk/server.ts
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Flagsmith } from '@flagsmith/nodejs';
import { createShop } from '../../demo/shop/server.ts';

const apiUrl = process.env.FLAGSMITH_API_URL ?? 'http://127.0.0.1:8000/api/v1/';
const flagsmith = new Flagsmith({
  environmentKey: process.env.FLAGSMITH_SERVER_KEY!,
  apiUrl,
  enableLocalEvaluation: true,
  enableEvents: true,
  // Self-hosted: without this the SDK posts events to Flagsmith Cloud (https://events.api.flagsmith.com/v1/events).
  eventProcessorConfig: { eventsApiUrl: apiUrl.replace(/v1\/?$/, '') },
});
// Local evaluation: until the environment document arrives, every visitor gets the flag's default.
await flagsmith.getEnvironmentFlags();
const shops: Record<string, http.Server> = {
  'shop:1.4': createShop({ version: '1.4' }),
  'shop:1.5': createShop({ version: '1.5' }),
  'shop:1.6': createShop({ version: '1.6', delayMs: 60 }),
};

// A stable id per visitor: a new one per request would reassign them on every page.
function visitorId(req: http.IncomingMessage, res: http.ServerResponse): string {
  const known = /(?:^|;\s*)visitor=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1];
  if (known) return known;
  const id = randomUUID();
  res.setHeader('set-cookie', `visitor=${id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
  return id;
}

http
  .createServer(async (req, res) => {
    const started = performance.now();
    const id = visitorId(req, res);
    const path = new URL(req.url ?? '/', 'http://shop').pathname;
    const page = req.method === 'GET' && (req.headers.accept ?? '').includes('text/html');
    // The variation for this visitor; recording the exposure is part of this call.
    const flag = await flagsmith.getExperimentFlag('shop_release', id);
    const shop = shops[String(flag.value)] ?? shops['shop:1.4']!;
    res.on('finish', () => {
      const status = res.statusCode;
      if (req.method === 'POST' && path === '/checkout' && status < 300) flagsmith.trackEvent('order_placed', { identifier: id });
      if (req.method === 'POST' && path === '/cart/add' && (status < 300 || status === 303)) flagsmith.trackEvent('add_to_cart', { identifier: id });
      if (page) {
        flagsmith.trackEvent('doc_latency_ms', { identifier: id, value: Math.round(performance.now() - started) });
        flagsmith.trackEvent('server_error', { identifier: id, value: status >= 500 ? 1 : 0 });
      }
    });
    shop.emit('request', req, res);
  })
  .listen(Number(process.env.PORT ?? 8089), () => console.log(`shop with the SDK on :${process.env.PORT ?? 8089}`));
