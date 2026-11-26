// Labelled, simulated visitors for the demo. Each one gets its own cookie jar, lands on the shop through the
// Switchyard proxy, browses, and with a known probability per variant buys something through the checkout flow
// of the release it was actually served. Nothing here is evidence: the true rates are inputs, printed next to every
// result. Variant keys don't name releases (after a release, v2 can be shop:1.6 and control shop:1.5), so the
// checkout flow follows the x-switchyard-release debug header, while rates and byVariant stay keyed by variant.
import { PRODUCTS } from '../shop/catalog.ts';

export type SimOptions = {
  target: string; // the proxy, e.g. http://switchyard:8080
  visitors: number;
  rates: Record<string, number>; // true conversion rate per variant key
  concurrency: number;
  seed: number;
  debugToken?: string; // the proxy's debug token (SWITCHYARD_PREVIEW_TOKEN): it reveals each visitor's variant and release
  log?: (line: string) => void;
};

type Tally = { visitors: number; orders: number; pageErrors: number };

export type SimReport = {
  byVariant: Record<string, Tally>;
  byRelease: Record<string, Tally>;
  failedOrders: number;
  durationMs: number;
};

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 SwitchyardSimulatedVisitor/1.0';

// One independent, repeatable stream per visitor: the seed and the visitor's index, mixed (splitmix32 finaliser).
export function visitorRandom(seed: number, index: number): () => number {
  let h = (Math.imul(seed >>> 0, 0x9e3779b1) ^ Math.imul(index + 1, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return mulberry32((h ^ (h >>> 15)) >>> 0);
}

// Deterministic PRNG so a seeded run is repeatable.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Visitor {
  private cookies = new Map<string, string>();
  private target: string;
  private debugToken: string;

  constructor(target: string, debugToken = '1') {
    this.debugToken = debugToken;
    this.target = target;
  }

  async request(method: 'GET' | 'POST', path: string, form?: Record<string, string>): Promise<Response> {
    const headers: Record<string, string> = {
      'user-agent': USER_AGENT,
      'x-switchyard-debug': this.debugToken,
      accept: 'text/html',
      'sec-fetch-dest': 'document',
    };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
    const res = await fetch(new URL(path, this.target), {
      method,
      headers,
      redirect: 'manual',
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const [name, ...value] = (pair ?? '').split('=');
      if (name) this.cookies.set(name.trim(), value.join('='));
    }
    await res.arrayBuffer(); // drain
    return res;
  }
}

const SHIPPING = {
  email: 'simulated.visitor@example.com',
  name: 'Simulated Visitor',
  address: '1 Demo Street',
  city: 'Bristol',
  postcode: 'BS1 4DJ',
  country: 'GB',
};
const PAYMENT = { card_number: '4242 4242 4242 4242', card_expiry: '12/30', card_cvc: '123' };

// shop 1.4 is the classic multi-step checkout; 1.5 and every later release check out on one page (/cart).
// A release label is "name:version" (e.g. shop:1.4); one without a version is treated as a later release.
export function checkoutFlow(release: string): 'multi-step' | 'one-page' {
  const version = release.includes(':') ? release.slice(release.lastIndexOf(':') + 1) : '';
  return version === '1.4' ? 'multi-step' : 'one-page';
}

async function visit(
  target: string,
  rates: Record<string, number>,
  random: () => number,
  debugToken?: string,
): Promise<{ variant: string; release: string; ordered: boolean; ok: boolean; pageErrors: number }> {
  const v = new Visitor(target, debugToken);
  let pageErrors = 0;
  const page = async (path: string) => {
    const res = await v.request('GET', path);
    if (res.status >= 500) pageErrors++;
    return res;
  };

  const landing = await page('/');
  const variant = landing.headers.get('x-switchyard-variant') ?? 'control';
  const release = landing.headers.get('x-switchyard-release') ?? 'unknown';
  const product = PRODUCTS[Math.floor(random() * PRODUCTS.length)]!;
  await page(`/product/${product.slug}`);
  if (random() < 0.4) await page(`/product/${PRODUCTS[Math.floor(random() * PRODUCTS.length)]!.slug}`);

  if (random() >= (rates[variant] ?? 0)) return { variant, release, ordered: false, ok: true, pageErrors };

  await v.request('POST', '/cart/add', { slug: product.slug, qty: '1' });
  await page('/cart');
  let order: Response;
  if (checkoutFlow(release) === 'multi-step') {
    // shop 1.4: cart → shipping details → payment → place order
    await page('/checkout/details');
    await v.request('POST', '/checkout/details', SHIPPING);
    await page('/checkout/payment');
    order = await v.request('POST', '/checkout', { ...SHIPPING, ...PAYMENT });
  } else {
    // shop 1.5 and later: one-page checkout on the cart page
    order = await v.request('POST', '/checkout', { ...SHIPPING, ...PAYMENT });
  }
  return { variant, release, ordered: order.status === 200, ok: order.status === 200, pageErrors };
}

const newTally = (): Tally => ({ visitors: 0, orders: 0, pageErrors: 0 });

export async function simulate(opts: SimOptions): Promise<SimReport> {
  const log = opts.log ?? console.log;
  const report: SimReport = { byVariant: {}, byRelease: {}, failedOrders: 0, durationMs: 0 };
  const started = Date.now();
  let next = 0;
  let done = 0;

  const worker = async () => {
    while (next < opts.visitors) {
      const index = next++;
      // Each visitor has its own stream. One generator shared by concurrent visitors hands out draws in
      // response-time order, which correlated the order decision with the release and washed out the true rates.
      const r = await visit(opts.target, opts.rates, visitorRandom(opts.seed, index), opts.debugToken);
      for (const t of [(report.byVariant[r.variant] ??= newTally()), (report.byRelease[r.release] ??= newTally())]) {
        t.visitors++;
        t.pageErrors += r.pageErrors;
        if (r.ordered) t.orders++;
      }
      if (!r.ok) report.failedOrders++;
      if (++done % 100 === 0) log(`  ${done}/${opts.visitors} visitors`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
  report.durationMs = Date.now() - started;
  return report;
}
