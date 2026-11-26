import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { PRODUCTS } from '../demo/shop/catalog.ts';
import { createShop, DEFAULT_FRAME_ANCESTORS, frameAncestors, optionsFromEnv, type ShopOptions } from '../demo/shop/server.ts';

const servers: http.Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

async function start(options: ShopOptions): Promise<string> {
  const server = createShop(options);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const SHOP_1_4 = start({ version: '1.4' });
const SHOP_1_5 = start({ version: '1.5' });

const get = (url: string, cookie?: string) =>
  fetch(url, { redirect: 'manual', headers: { accept: 'text/html', ...(cookie ? { cookie } : {}) } });

const post = (url: string, fields: Record<string, string>, cookie?: string, accept = 'text/html') =>
  fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept, ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields).toString(),
  });

// The name=value part of a Set-Cookie header, ready to send back.
function cookieFrom(res: Response, name: string): string | undefined {
  const header = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  return header?.split(';')[0];
}

const TRAIL = PRODUCTS[0]!;
const TENT = PRODUCTS[5]!;

const SHIPPING = {
  email: 'ada@example.com',
  name: 'Ada Lovelace',
  address: '12 Analytical Way',
  city: 'London',
  postcode: 'N1 9GU',
  country: 'GB',
};
const PAYMENT = { card_number: '4242 4242 4242 4242', card_expiry: '12/39', card_cvc: '123' };

async function cartWith(base: string, slug = TRAIL.slug, qty = '1'): Promise<string> {
  const res = await post(`${base}/cart/add`, { slug, qty });
  const cookie = cookieFrom(res, 'shop_cart');
  assert.ok(cookie, 'add to cart sets the shop_cart cookie');
  return cookie;
}

for (const version of ['1.4', '1.5']) {
  describe(`shop ${version}: shared pages`, () => {
    const base = version === '1.4' ? SHOP_1_4 : SHOP_1_5;

    test('the catalog lists every product with its price and illustration', async () => {
      const res = await get(`${await base}/`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
      const html = await res.text();
      assert.ok(PRODUCTS.length >= 6);
      for (const p of PRODUCTS) {
        assert.ok(html.includes(`href="/product/${p.slug}"`), `links ${p.slug}`);
        assert.ok(html.includes(p.name.replace(/'/g, '&#39;')), `names ${p.name}`);
      }
      assert.ok(html.includes('$129.00'));
      assert.equal((html.match(/<svg class="art"/g) ?? []).length, PRODUCTS.length);
      assert.doesNotMatch(html, /Release \d/, 'no release badge for an ordinary visitor');
      assert.doesNotMatch(html, /<img|https?:\/\/(?!www\.w3\.org)/, 'no external images or CDNs');
    });

    test('a product page shows details and an add-to-cart form', async () => {
      const res = await get(`${await base}/product/${TENT.slug}`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes(`<h1>${TENT.name}</h1>`));
      assert.ok(html.includes('$349.00'));
      assert.match(html, /<form class="add-form" method="post" action="\/cart\/add">/);
      assert.match(html, /role="img" aria-label="Illustration of the Northstar 2P Tent"/);
    });

    test('add to cart stores the cart in the shop_cart cookie, never tn_id', async () => {
      const res = await post(`${await base}/cart/add`, { slug: TENT.slug, qty: '2' });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), `/cart?added=${TENT.slug}`);
      const setCookies = res.headers.getSetCookie();
      assert.ok(setCookies.every((c) => !c.startsWith('tn_id=')));
      const cookie = cookieFrom(res, 'shop_cart');
      assert.ok(cookie);
      assert.match(setCookies.join(), /HttpOnly; SameSite=Lax/);

      const cart = await (await get(`${await base}${res.headers.get('location')}`, cookie)).text();
      assert.ok(cart.includes(TENT.name));
      assert.ok(cart.includes('$698.00'), 'line total for two tents');
      assert.match(cart, /data-cart-count>2</);
      assert.ok(cart.includes('Added <strong>Northstar 2P Tent</strong> to your cart'));

      const removed = await post(`${await base}/cart/update`, { slug: TENT.slug, qty: '0' }, cookie);
      assert.equal(removed.status, 303);
      assert.match(removed.headers.getSetCookie().join(), /shop_cart=; Path=\/; Max-Age=0/);
    });

    test('a tampered cart cookie is ignored rather than trusted', async () => {
      const html = await (await get(`${await base}/cart`, 'shop_cart=nope%3A5|ridgeback-trail-runners:999|%E0%A4%A')).text();
      assert.ok(html.includes('Your cart is empty'));
      const capped = await (await get(`${await base}/cart`, 'shop_cart=ridgeback-trail-runners%3A999')).text();
      assert.match(capped, /data-cart-count>10</);
    });

    test('POST /checkout with valid details places the order: 200 with an order number', async () => {
      const cookie = await cartWith(await base);
      const res = await post(`${await base}/checkout`, { ...SHIPPING, ...PAYMENT }, cookie);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
      const html = await res.text();
      assert.match(html, /data-order-number>RL-[A-HJ-NP-Z2-9]{8}</);
      assert.ok(html.includes('Thank you, Ada!'));
      assert.ok(html.includes('Card ending 4242'));
      assert.ok(!html.includes('4242 4242 4242 4242'), 'the full card number is not echoed');
      assert.match(res.headers.getSetCookie().join(), /shop_cart=; Path=\/; Max-Age=0/);
    });

    test('POST /checkout with bad email and card answers 422 with the form and errors', async () => {
      const cookie = await cartWith(await base);
      const res = await post(
        `${await base}/checkout`,
        { ...SHIPPING, ...PAYMENT, email: 'not-an-email', name: '<script>alert(1)</script>', card_number: '1234 5678 9012 3456' },
        cookie,
      );
      assert.equal(res.status, 422);
      const html = await res.text();
      assert.match(html, /role="alert"/);
      assert.ok(html.includes('Enter an email address like name@example.com.'));
      assert.ok(html.includes('aria-invalid="true"'));
      assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'user input is escaped');
      assert.ok(!html.includes('<script>alert(1)'));
      assert.ok(!html.includes('data-order-number'));
    });

    test('POST /checkout with a bad card on otherwise valid details answers 422', async () => {
      const cookie = await cartWith(await base);
      const res = await post(`${await base}/checkout`, { ...SHIPPING, ...PAYMENT, card_number: '4242 4242 4242 4241', card_expiry: '01/20' }, cookie);
      assert.equal(res.status, 422);
      const html = await res.text();
      assert.ok(html.includes('Enter a valid card number.'));
      assert.ok(html.includes('This card has expired.'));
      assert.match(html, /<form[^>]+action="\/checkout"/);
    });

    test('POST /checkout with an empty cart answers 422', async () => {
      const res = await post(`${await base}/checkout`, { ...SHIPPING, ...PAYMENT });
      assert.equal(res.status, 422);
      assert.ok((await res.text()).includes('Your cart is empty. Add something before checking out.'));
    });

    test('unknown pages and products answer a 404 page', async () => {
      for (const path of ['/nope', '/product/not-a-product']) {
        const res = await get(`${await base}${path}`);
        assert.equal(res.status, 404);
        assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
        assert.ok((await res.text()).includes('We couldn’t find that trail'));
      }
    });

    test('/health answers ok', async () => {
      const res = await get(`${await base}/health`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'ok');
    });

    test('assets are served with their content types', async () => {
      const css = await get(`${await base}/assets/style.css`);
      assert.equal(css.status, 200);
      assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
      const text = await css.text();
      assert.match(text, /data-theme="express"/);
      assert.match(text, /data-theme="bold"/);
      const js = await get(`${await base}/assets/app.js?v=${version}`);
      assert.equal(js.status, 200);
      assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
      assert.match(await js.text(), /data-express/);
    });
  });
}

describe('release differences', () => {
  test('each release has its own theme and hero', async () => {
    const SHOP_1_6 = start({ version: '1.6' });
    const pages = await Promise.all([SHOP_1_4, SHOP_1_5, SHOP_1_6].map(async (b) => (await get(`${await b}/`)).text()));
    assert.match(pages[2] ?? '', /<html lang="en" data-theme="bold" data-release="1\.6">/);
    const titles = pages.map((h) => h.match(/<h1>([^<]*)<\/h1>/)?.[1]);
    assert.equal(new Set(titles).size, 3);
  });

  test('1.4: classic theme, product links on the catalog, no express add', async () => {
    const html = await (await get(`${await SHOP_1_4}/`)).text();
    assert.match(html, /<html lang="en" data-theme="classic" data-release="1\.4">/);
    assert.ok(!html.includes('data-express'));
  });

  test('1.5: express theme and express add-to-cart on catalog cards', async () => {
    const html = await (await get(`${await SHOP_1_5}/`)).text();
    assert.match(html, /<html lang="en" data-theme="express" data-release="1\.5">/);
    assert.equal((html.match(/data-express/g) ?? []).length, PRODUCTS.length);

    const res = await post(`${await SHOP_1_5}/cart/add`, { slug: TRAIL.slug, qty: '1', return: '/' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `/?added=${TRAIL.slug}#product-${TRAIL.slug}`);
    const back = await (await get(`${await SHOP_1_5}/?added=${TRAIL.slug}`, cookieFrom(res, 'shop_cart'))).text();
    assert.ok(back.includes('Added <strong>Ridgeback Trail Runners</strong> to your cart.'));

    const json = await post(`${await SHOP_1_5}/cart/add`, { slug: TRAIL.slug, qty: '1' }, cookieFrom(res, 'shop_cart'), 'application/json');
    assert.equal(json.status, 200);
    assert.deepEqual(await json.json(), { ok: true, count: 2, added: 'Ridgeback Trail Runners' });
  });

  test('1.4: classic multi-step checkout, cart -> details -> payment -> POST /checkout', async () => {
    const base = await SHOP_1_4;
    const cart = await cartWith(base);

    const cartHtml = await (await get(`${base}/cart`, cart)).text();
    assert.ok(cartHtml.includes('href="/checkout/details"'));
    assert.ok(!cartHtml.includes('action="/checkout"'), 'no checkout form on the cart page');
    assert.match(cartHtml, /Checkout in 3 steps/);

    const details = await get(`${base}/checkout/details`, cart);
    assert.equal(details.status, 200);
    const detailsHtml = await details.text();
    assert.ok(detailsHtml.includes('action="/checkout/details"'));
    assert.ok(!detailsHtml.includes('name="card_number"'));

    const bad = await post(`${base}/checkout/details`, { ...SHIPPING, postcode: '' }, cart);
    assert.equal(bad.status, 422);
    assert.ok((await bad.text()).includes('Enter your postcode or ZIP code.'));

    // Payment needs the details step first.
    const early = await get(`${base}/checkout/payment`, cart);
    assert.equal(early.status, 303);
    assert.equal(early.headers.get('location'), '/checkout/details');

    const saved = await post(`${base}/checkout/details`, SHIPPING, cart);
    assert.equal(saved.status, 303);
    assert.equal(saved.headers.get('location'), '/checkout/payment');
    const details2 = cookieFrom(saved, 'shop_checkout');
    assert.ok(details2);
    const both = `${cart}; ${details2}`;

    const payment = await get(`${base}/checkout/payment`, both);
    assert.equal(payment.status, 200);
    const paymentHtml = await payment.text();
    assert.match(paymentHtml, /<form class="card checkout-form" method="post" action="\/checkout">/);
    assert.ok(paymentHtml.includes('<input type="hidden" name="email" value="ada@example.com">'));
    assert.ok(paymentHtml.includes('name="card_number"'));

    // The browser submits the payment form: hidden shipping fields plus the card.
    const order = await post(`${base}/checkout`, { ...SHIPPING, ...PAYMENT }, both);
    assert.equal(order.status, 200);
    assert.match(await order.text(), /RL-[A-Z0-9]{8}/);
    assert.match(order.headers.getSetCookie().join(), /shop_checkout=; Path=\/; Max-Age=0/);
  });

  test('1.5: one-page checkout, the cart page holds the whole form', async () => {
    const base = await SHOP_1_5;
    const cart = await cartWith(base);

    const cartHtml = await (await get(`${base}/cart`, cart)).text();
    assert.match(cartHtml, /<form id="checkout-form" class="checkout-form" method="post" action="\/checkout">/);
    for (const field of ['email', 'name', 'address', 'city', 'postcode', 'country', 'card_number', 'card_expiry', 'card_cvc']) {
      assert.ok(cartHtml.includes(`name="${field}"`), field);
    }
    assert.ok(!cartHtml.includes('/checkout/details'), 'no multi-step links');

    for (const path of ['/checkout', '/checkout/details', '/checkout/payment']) {
      const res = await get(`${base}${path}`, cart);
      assert.equal(res.status, 303, path);
      assert.equal(res.headers.get('location'), '/cart#checkout');
    }

    const order = await post(`${base}/checkout`, { ...SHIPPING, ...PAYMENT }, cart);
    assert.equal(order.status, 200);
    assert.match(await order.text(), /RL-[A-Z0-9]{8}/);
  });
});

describe('seeded faults', () => {
  test('SEEDED_DELAY_MS slows GET pages, not health checks or assets', async () => {
    const base = await start({ version: '1.5', delayMs: 250 });
    let t = performance.now();
    assert.equal((await get(`${base}/`)).status, 200);
    assert.ok(performance.now() - t >= 240, 'page is delayed');

    t = performance.now();
    assert.equal((await get(`${base}/health`)).status, 200);
    assert.ok(performance.now() - t < 240, 'health is not delayed');

    t = performance.now();
    assert.equal((await get(`${base}/assets/style.css`)).status, 200);
    assert.ok(performance.now() - t < 240, 'assets are not delayed');
  });

  test('SEEDED_ERROR_RATE=1 turns every GET page into a 500 error page', async () => {
    const base = await start({ version: '1.4', errorRate: 1 });
    for (const path of ['/', '/cart', `/product/${TRAIL.slug}`]) {
      const res = await get(`${base}${path}`);
      assert.equal(res.status, 500, path);
      assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.ok((await res.text()).includes('Something went wrong on our side'));
    }
    assert.equal((await get(`${base}/health`)).status, 200);
  });

  test('a fractional error rate fails only the unlucky requests', async () => {
    const rolls = [0.1, 0.9];
    const base = await start({ version: '1.4', errorRate: 0.5, random: () => rolls.shift() ?? 1 });
    assert.equal((await get(`${base}/`)).status, 500);
    assert.equal((await get(`${base}/`)).status, 200);
  });
});

test('the shop contains no reference to the flag platform', () => {
  const root = fileURLToPath(new URL('../demo/shop/', import.meta.url));
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath, d.name));
  assert.ok(files.length >= 5, 'reads every shop file');
  for (const file of files) {
    assert.ok(!/flagsmith/i.test(readFileSync(file, 'utf8')), `${file} mentions it`);
  }
});

// ---------- release receipt footer (assets/app.js, run in a stub DOM) ----------

const APP_JS = readFileSync(new URL('../demo/shop/assets/app.js', import.meta.url), 'utf8');

type FakeResponse = { status: number; type: string; body: unknown };

async function footerFor(answer: FakeResponse | Error): Promise<{ hidden: boolean; text: string; calls: [string, RequestInit][] }> {
  const el = { hidden: true, textContent: '' };
  const calls: [string, RequestInit][] = [];
  const context: Record<string, unknown> = {
    document: {
      documentElement: { classList: { add() {} } },
      addEventListener() {},
      querySelector: (sel: string) => (sel === '[data-release-receipt]' ? el : null),
    },
    fetch: (url: string, init: RequestInit) => {
      calls.push([url, init]);
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve({
        status: answer.status,
        headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? answer.type : null) },
        json: () => Promise.resolve(answer.body),
      });
    },
  };
  context.window = context;
  vm.runInNewContext(APP_JS, context);
  await new Promise((r) => setTimeout(r, 10));
  return { hidden: el.hidden, text: el.textContent, calls };
}

const json = (body: unknown): FakeResponse => ({ status: 200, type: 'application/json', body });
const AT = new Date(2026, 10, 17, 14, 3, 12); // local time, as the footer shows it

describe('release receipt footer', () => {
  test('every page carries the hidden footer slot', async () => {
    const html = await (await get(`${await SHOP_1_5}/`)).text();
    assert.match(html, /<p class="release-receipt" data-release-receipt hidden><\/p>/);
  });

  test('without a router in front, the shop answers the receipt path with a plain 404', async () => {
    const res = await get(`${await SHOP_1_4}/__turnout/receipt`);
    assert.equal(res.status, 404);
    assert.doesNotMatch(res.headers.get('content-type') ?? '', /json/);
  });

  test('fetches once, same-origin, and shows an accepted event', async () => {
    const f = await footerFor(json({ variant: 'v2', release: 'shop:1.5', enrolled: true, receipt: { status: 'accepted', at: AT.toISOString(), event: 'order_placed', httpStatus: 202 } }));
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]![0], '/__turnout/receipt');
    assert.equal(f.calls[0]![1].credentials, 'same-origin');
    assert.equal(f.hidden, false);
    assert.equal(f.text, "Turnout: You're in v2 (shop:1.5) of a release experiment. Your latest event (order_placed): accepted at 14:03:12.");
  });

  test('a non-accepted status is shown plainly, with its HTTP status; ms timestamps work', async () => {
    const f = await footerFor(json({ variant: 'control', release: 'shop:1.4', enrolled: true, receipt: { status: 'store_not_connected', at: AT.getTime(), event: 'doc_latency_ms', httpStatus: 404 } }));
    assert.equal(f.text, "Turnout: You're in control (shop:1.4) of a release experiment. Your latest event (doc_latency_ms): not stored (no event store connected), HTTP 404 at 14:03:12.");
    const g = await footerFor(json({ variant: 'v2', release: 'shop:1.6', enrolled: true, receipt: { status: 'not_delivered', at: AT.getTime(), event: 'order_placed', httpStatus: 0 } }));
    assert.match(g.text, /Your latest event \(order_placed\): not delivered at 14:03:12\.$/);
  });

  test('no receipt yet, and visitors outside the experiment', async () => {
    const f = await footerFor(json({ variant: 'control', release: null, enrolled: false, receipt: null }));
    assert.equal(f.text, "Turnout: You're on the default release (not in a release experiment). No events recorded for you yet.");
  });

  test('text is set with textContent, never parsed as HTML', async () => {
    const f = await footerFor(json({ variant: '<img src=x onerror=alert(1)>', release: 'shop:1.5', enrolled: true, receipt: null }));
    assert.match(f.text, /You're in <img src=x onerror=alert\(1\)> \(shop:1\.5\)/);
  });

  test('stays hidden on a 404 page, non-JSON, unexpected JSON or a network error', async () => {
    for (const answer of [
      { status: 404, type: 'text/html; charset=utf-8', body: null },
      { status: 200, type: 'text/html', body: null },
      json({ hello: 'world' }),
      new Error('offline'),
    ]) {
      const f = await footerFor(answer);
      assert.equal(f.hidden, true);
      assert.equal(f.text, '');
    }
  });
});

// ---------- who may frame the shop (judge mode's Shop tab) ----------

describe('frame-ancestors', () => {
  test('by default only the console on this machine may frame the shop', async () => {
    assert.equal(frameAncestors({}), DEFAULT_FRAME_ANCESTORS);
    assert.equal(optionsFromEnv({}).frameAncestors, DEFAULT_FRAME_ANCESTORS);
    const base = await start({ version: '1.4' });
    assert.equal((await get(`${base}/`)).headers.get('content-security-policy'), `frame-ancestors ${DEFAULT_FRAME_ANCESTORS}`);
  });

  test('SHOP_FRAME_HOSTS (compose passes TURNOUT_CONSOLE_HOSTS) adds the console on each host, port 8091 (its port for other devices)', async () => {
    const env = { SHOP_FRAME_HOSTS: ' 192.168.1.20, Demo.Local ,,[fd00::1],localhost' };
    const want = `${DEFAULT_FRAME_ANCESTORS} http://192.168.1.20:8091 http://demo.local:8091 http://[fd00::1]:8091 http://localhost:8091`;
    assert.equal(frameAncestors(env), want);
    const base = await start({ version: '1.5', ...optionsFromEnv(env) });
    for (const path of ['/', '/cart', '/nope']) {
      assert.equal((await get(`${base}${path}`)).headers.get('content-security-policy'), `frame-ancestors ${want}`, path);
    }
  });

  test('host entries that could change the policy are dropped', () => {
    for (const bad of ["evil.example 'unsafe-inline'", 'a.example; script-src *', 'http://a.example', 'a.example:9000', '*', 'a..b']) {
      assert.equal(frameAncestors({ SHOP_FRAME_HOSTS: bad }), DEFAULT_FRAME_ANCESTORS, bad);
    }
  });

  test('SHOP_FRAME_ANCESTORS replaces the list; one with ";", "," or a line break is ignored', () => {
    assert.equal(frameAncestors({ SHOP_FRAME_ANCESTORS: " 'self' https://console.example ", SHOP_FRAME_HOSTS: '10.0.0.2' }), "'self' https://console.example");
    for (const bad of ["'self'; script-src *", "'self', 'none'", "'self'\nx: y"]) {
      assert.equal(frameAncestors({ SHOP_FRAME_ANCESTORS: bad }), DEFAULT_FRAME_ANCESTORS, JSON.stringify(bad));
    }
    assert.equal(frameAncestors({ SHOP_FRAME_ANCESTORS: '   ' }), DEFAULT_FRAME_ANCESTORS);
  });
});

describe('release difference and badge', () => {
  test('1.4 says "Step 1 of 3"; 1.5 says everything is on one page', async () => {
    const old = await SHOP_1_4;
    const cookie = await cartWith(old);
    const cart14 = await (await get(`${old}/cart`, cookie)).text();
    assert.match(cart14, /Checkout in 3 steps/);
    assert.match(await (await get(`${old}/checkout/details`, cookie)).text(), /Step 1 of 3/);
    const fresh = await SHOP_1_5;
    const cart15 = await (await get(`${fresh}/cart`, await cartWith(fresh))).text();
    assert.match(cart15, /One-page checkout/);
    assert.doesNotMatch(cart15, /Step \d of 3/);
  });

  test('the footer badge shows only when the router sets the release header', async () => {
    const fresh = await SHOP_1_5;
    assert.doesNotMatch(await (await get(`${fresh}/`)).text(), /Release 1\.5/);
    const marked = await fetch(`${fresh}/`, { headers: { accept: 'text/html', 'x-turnout-release': 'shop:1.5' } });
    assert.match(await marked.text(), /data-release-badge>Release 1\.5</);
  });
});
