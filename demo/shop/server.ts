// Ridgeline Supply Co., the demo shop, shipped as two releases from one codebase:
//   1.4  classic 3-step checkout ("Step 1 of 3"): cart -> /checkout/details -> /checkout/payment -> POST /checkout (blue theme)
//   1.5  one-page checkout on /cart, express add-to-cart on the catalog (green theme)
// Both releases place the order with POST /checkout, answering 200 with an order number, or 422 with the form.
//
// Run: SHOP_VERSION=1.5 PORT=8080 node demo/shop/server.ts
// Seeded faults for demos, both labelled and off by default:
//   SEEDED_DELAY_MS    extra delay on every GET page
//   SEEDED_ERROR_RATE  0..1 chance that a GET page answers 500
// Framing (judge mode shows the shop in a tab of the console): SHOP_FRAME_HOSTS, SHOP_FRAME_ANCESTORS; see frameAncestors.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { findProduct } from './catalog.ts';
import { CART_COOKIE, MAX_QTY, addToCart, cartCookie, parseCart, readCookie, setQuantity, summarize } from './cart.ts';
import {
  DETAILS_COOKIE,
  PAYMENT_FIELDS,
  SHIPPING_FIELDS,
  clearDetailsCookie,
  detailsCookie,
  lastFour,
  orderNumber,
  parseDetails,
  pickValues,
  validatePayment,
  validateShipping,
  type FormErrors,
} from './checkout.ts';
import {
  cartPage,
  catalogPage,
  confirmationPage,
  detailsPage,
  errorPage,
  methodNotAllowedPage,
  notFoundPage,
  paymentPage,
  productPage,
  type Release,
} from './views.ts';

export type ShopOptions = {
  version?: string; // '1.4' (default) is the classic checkout; any later release uses the one-page checkout
  delayMs?: number; // seeded delay on GET pages
  errorRate?: number; // seeded chance (0..1) that a GET page answers 500
  random?: () => number; // injectable for tests
  ribbon?: boolean; // demo only: a corner ribbon naming the release (SHOP_RIBBON=1)
  frameAncestors?: string; // the CSP frame-ancestors sources; default DEFAULT_FRAME_ANCESTORS
};

export const RELEASE_HEADER = 'x-turnout-release';
const MAX_BODY_BYTES = 32 * 1024;
// Who may show the shop in a frame: the Turnout console's judge tour on this machine (port 8090).
export const DEFAULT_FRAME_ANCESTORS = "'self' http://localhost:8090 http://127.0.0.1:8090";
const DEVICE_PORT = 8091; // the console's port for other devices (judge link only)
// A hostname, an IPv4 address or a bracketed IPv6 address: nothing that could end the CSP source list.
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])$/i;

/**
 * The frame-ancestors sources: SHOP_FRAME_ANCESTORS replaces the whole list; otherwise the default plus the console
 * on each host in SHOP_FRAME_HOSTS (a comma list, e.g. "192.168.1.20,demo.local"), which is how other devices reach
 * the console. Entries that aren't plain hosts, and a list with ";" or a line break, are ignored.
 */
export function frameAncestors(env: NodeJS.ProcessEnv): string {
  const explicit = env.SHOP_FRAME_ANCESTORS?.trim();
  if (explicit && !/[;,\r\n]/.test(explicit)) return explicit;
  const sources = DEFAULT_FRAME_ANCESTORS.split(' ');
  for (const raw of (env.SHOP_FRAME_HOSTS ?? '').split(',')) {
    const host = raw.trim().toLowerCase();
    const source = `http://${host}:${DEVICE_PORT}`;
    if (HOST.test(host) && !sources.includes(source)) sources.push(source);
  }
  return sources.join(' ');
}

type Asset = { type: string; body: Buffer };

function loadAssets(): Map<string, Asset> {
  const read = (name: string) => readFileSync(new URL(`./assets/${name}`, import.meta.url));
  return new Map([
    ['/assets/style.css', { type: 'text/css; charset=utf-8', body: read('style.css') }],
    ['/assets/app.js', { type: 'text/javascript; charset=utf-8', body: read('app.js') }],
  ]);
}

export function createShop(options: ShopOptions = {}): http.Server {
  const version = options.version ?? '1.4';
  const delayMs = Math.max(0, options.delayMs ?? 0);
  const base: Release = { version, onePage: version !== '1.4', ribbon: options.ribbon === true, slowMs: delayMs };
  const errorRate = Math.min(1, Math.max(0, options.errorRate ?? 0));
  const random = options.random ?? Math.random;
  const ancestors = options.frameAncestors ?? DEFAULT_FRAME_ANCESTORS;
  const assets = loadAssets();
  const html = (res: http.ServerResponse, status: number, body: string, extra: http.OutgoingHttpHeaders = {}) =>
    writeHtml(res, status, body, ancestors, extra);

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://shop.invalid');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const isRead = method === 'GET' || method === 'HEAD';
    // A release router in front (Turnout) sets this request header only for preview browsers and debug requests,
    // and drops any copy a visitor sends; then the footer shows "Release 1.5"..
    const release: Release = req.headers[RELEASE_HEADER] ? { ...base, badge: true } : base;

    if (path === '/health') {
      if (!isRead) return notAllowed(res, 'GET, HEAD');
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end('ok');
      return;
    }

    const asset = assets.get(path);
    if (asset) {
      if (!isRead) return notAllowed(res, 'GET, HEAD');
      res.writeHead(200, {
        'content-type': asset.type,
        'content-length': asset.body.length,
        'cache-control': 'public, max-age=3600',
        'x-content-type-options': 'nosniff',
      });
      res.end(asset.body);
      return;
    }

    // Seeded faults apply to pages only, never to /health or assets.
    if (isRead) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (errorRate > 0 && random() < errorRate) return html(res, 500, errorPage(release));
    }

    const cookies = req.headers.cookie;
    const cart = parseCart(readCookie(cookies, CART_COOKIE));
    const summary = summarize(cart);

    if (isRead) {
      if (path === '/') {
        const added = findProduct(url.searchParams.get('added') ?? '');
        return html(res, 200, catalogPage(release, summary.count, added));
      }
      const productMatch = /^\/product\/([a-z0-9-]+)\/?$/.exec(path);
      if (productMatch) {
        const product = findProduct(productMatch[1] ?? '');
        return product
          ? html(res, 200, productPage(release, product, summary.count))
          : html(res, 404, notFoundPage(release, summary.count));
      }
      if (path === '/cart') {
        const added = findProduct(url.searchParams.get('added') ?? '');
        return html(res, 200, cartPage(release, summary, { added }));
      }
      if (path === '/checkout') return redirect(res, release.onePage ? '/cart#checkout' : '/checkout/details');
      if (path === '/checkout/details') {
        if (release.onePage) return redirect(res, '/cart#checkout');
        if (summary.count === 0) return redirect(res, '/cart');
        return html(res, 200, detailsPage(release, summary, parseDetails(readCookie(cookies, DETAILS_COOKIE)) ?? {}));
      }
      if (path === '/checkout/payment') {
        if (release.onePage) return redirect(res, '/cart#checkout');
        if (summary.count === 0) return redirect(res, '/cart');
        const details = parseDetails(readCookie(cookies, DETAILS_COOKIE));
        if (!details || Object.keys(validateShipping(details)).length > 0) return redirect(res, '/checkout/details');
        return html(res, 200, paymentPage(release, summary, details));
      }
      return html(res, 404, notFoundPage(release, summary.count));
    }

    if (method !== 'POST') {
      return html(res, 405, methodNotAllowedPage(release, summary.count), { allow: 'GET, HEAD, POST' });
    }

    let form: URLSearchParams;
    try {
      form = new URLSearchParams(await readBody(req));
    } catch {
      res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }).end('Request too large');
      return;
    }

    if (path === '/cart/add') {
      const product = findProduct(form.get('slug') ?? '');
      if (!product) return html(res, 404, notFoundPage(release, summary.count));
      const next = addToCart(cart, product.slug, Math.max(1, quantity(form.get('qty'), 1)));
      const setCookie = cartCookie(next);
      if ((req.headers.accept ?? '').includes('application/json')) {
        const count = summarize(next).count;
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'set-cookie': setCookie });
        res.end(JSON.stringify({ ok: true, count, added: product.name }));
        return;
      }
      const back = form.get('return') === '/' ? `/?added=${product.slug}#product-${product.slug}` : `/cart?added=${product.slug}`;
      return redirect(res, back, [setCookie]);
    }

    if (path === '/cart/update') {
      const slug = form.get('slug') ?? '';
      if (!findProduct(slug)) return redirect(res, '/cart');
      return redirect(res, '/cart', [cartCookie(setQuantity(cart, slug, quantity(form.get('qty'), 0)))]);
    }

    if (path === '/checkout/details') {
      if (release.onePage) return redirect(res, '/cart#checkout');
      if (summary.count === 0) return redirect(res, '/cart');
      const values = pickValues(form, SHIPPING_FIELDS);
      const errors = validateShipping(values);
      if (Object.keys(errors).length > 0) return html(res, 422, detailsPage(release, summary, values, errors));
      return redirect(res, '/checkout/payment', [detailsCookie(values)]);
    }

    if (path === '/checkout') {
      const values = pickValues(form, [...SHIPPING_FIELDS, ...PAYMENT_FIELDS]);
      if (summary.count === 0) {
        const errors: FormErrors = { cart: 'Your cart is empty. Add something before checking out.' };
        return html(res, 422, cartPage(release, summary, { errors }));
      }
      const shippingErrors = validateShipping(values);
      const paymentErrors = validatePayment(values);
      const errors: FormErrors = { ...shippingErrors, ...paymentErrors };
      if (Object.keys(errors).length > 0) {
        if (release.onePage) return html(res, 422, cartPage(release, summary, { values, errors }));
        // Classic checkout: send the visitor back to whichever step has the problem.
        return Object.keys(shippingErrors).length > 0
          ? html(res, 422, detailsPage(release, summary, values, shippingErrors))
          : html(res, 422, paymentPage(release, summary, values, paymentErrors));
      }
      const order = { number: orderNumber(), values, last4: lastFour(values.card_number), summary };
      return html(res, 200, confirmationPage(release, order), {
        'set-cookie': [cartCookie(new Map()), clearDetailsCookie],
      });
    }

    return html(res, 404, notFoundPage(release, summary.count));
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      console.error('shop: request failed', err);
      if (!res.headersSent) html(res, 500, errorPage(base));
      else res.destroy();
    });
  });
}

function writeHtml(res: http.ServerResponse, status: number, body: string, ancestors: string, extra: http.OutgoingHttpHeaders): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    // Judge mode shows the shop in a tab of the console; nothing else may frame it.
    'content-security-policy': `frame-ancestors ${ancestors}`,
    ...extra,
  });
  res.end(body);
}

function redirect(res: http.ServerResponse, location: string, cookies: string[] = []): void {
  const headers: http.OutgoingHttpHeaders = { location, 'cache-control': 'no-store' };
  if (cookies.length > 0) headers['set-cookie'] = cookies;
  res.writeHead(303, headers).end();
}

function notAllowed(res: http.ServerResponse, allow: string): void {
  res.writeHead(405, { allow, 'content-type': 'text/plain; charset=utf-8' }).end('Method not allowed');
}

function quantity(raw: string | null, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(n) ? Math.min(Math.max(n, 0), MAX_QTY) : fallback;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.removeAllListeners('data');
        req.resume();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function optionsFromEnv(env: NodeJS.ProcessEnv): ShopOptions {
  const num = (value: string | undefined) => {
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    version: env.SHOP_VERSION || '1.4',
    delayMs: num(env.SEEDED_DELAY_MS),
    errorRate: num(env.SEEDED_ERROR_RATE),
    ribbon: /^(1|true|yes|on)$/i.test(env.SHOP_RIBBON?.trim() ?? ''),
    frameAncestors: frameAncestors(env),
  };
}

if (import.meta.main) {
  const options = optionsFromEnv(process.env);
  const port = Number(process.env.PORT ?? 8080);
  const server = createShop(options);
  server.listen(port, () => {
    const seeded = [
      options.delayMs ? `seeded delay ${options.delayMs} ms` : '',
      options.errorRate ? `seeded error rate ${options.errorRate}` : '',
    ].filter(Boolean);
    console.log(`shop ${options.version} on :${port}${seeded.length ? ` (${seeded.join(', ')})` : ''}`);
    if (options.frameAncestors !== DEFAULT_FRAME_ANCESTORS) console.log(`frames allowed from: ${options.frameAncestors}`);
    if (process.env.SHOP_FRAME_ANCESTORS?.trim() && options.frameAncestors !== process.env.SHOP_FRAME_ANCESTORS.trim()) {
      console.warn('SHOP_FRAME_ANCESTORS ignored: it may not contain ";", "," or a line break');
    }
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
}
