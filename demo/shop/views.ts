// HTML views. Every value that came from a visitor goes through escapeHtml.
import { PRODUCTS, formatMoney, productArt, type Product } from './catalog.ts';
import { FREE_SHIPPING_CENTS, MAX_QTY, type CartSummary } from './cart.ts';
import {
  COUNTRIES,
  PAYMENT_FIELDS,
  SHIPPING_FIELDS,
  countryName,
  type Field,
  type FormErrors,
  type FormValues,
} from './checkout.ts';
import { escapeHtml as e } from './html.ts';

export type Release = {
  version: string;
  onePage: boolean; // 1.5+: one-page checkout and express add-to-cart; 1.4: classic multi-step checkout
  // Show "Release 1.5" in the footer. Only when the router in front marks the request (a preview browser or a debug
  // request; see server.ts): ordinary visitors never see which release they are on.
  badge?: boolean;
  ribbon?: boolean; // demo only (SHOP_RIBBON=1): a corner ribbon saying which release this is
  slowMs?: number; // a seeded test delay; shown as a label so viewers know why this release is slower
};

const RELEASE_NAME: Record<Theme, string> = { classic: 'Classic', express: 'Express', bold: 'Bold' };

// A strip under the header that shows the checkout this release offers: the thing the experiment measures.
function releaseStrip(r: Release, step = 0): string {
  const slow = r.slowMs
    ? `<p class="slow-label" data-slow-label>Test release: deliberately slow (${Math.round(r.slowMs)} ms)</p>`
    : '';
  const mode = r.onePage
    ? `<p class="onepage-badge" data-onepage-badge>One-page checkout</p><p class="strip-text">Buy now from any product, then pay on one page.</p>`
    : `<div class="step-bar" data-step-bar data-step="${step}"><p class="step-bar-title">${step ? `Checkout: step ${step} of 3` : 'Checkout in 3 steps'}</p><ol class="step-bar-list">${['Shipping', 'Payment', 'Confirmation']
        .map((name, i) => {
          const n = i + 1;
          const state = !step ? 'todo' : n < step ? 'done' : n === step ? 'current' : 'todo';
          return `<li class="sb-${state}"${state === 'current' ? ' aria-current="step"' : ''}>${state === 'done' ? '✓ ' : ''}${name}</li>`;
        })
        .join('')}</ol></div>`;
  return `<div class="release-strip" data-release-strip><div class="wrap strip-inner">${mode}${slow}</div></div>`;
}

// ---- demo autofill: made-up checkout details, different every time ----------------------------------------------
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
const FIRST = ['Ava', 'Noah', 'Mia', 'Arjun', 'Lena', 'Kai', 'Zara', 'Leo', 'Priya', 'Omar', 'Nina', 'Theo', 'Ines', 'Ravi'];
const LAST = ['Patel', 'Nguyen', 'Garcia', 'Okafor', 'Smith', 'Rossi', 'Kim', 'Haddad', 'Silva', 'Novak', 'Iyer', 'Brown'];
const STREETS = ['Maple Ave', 'Harbour Rd', 'Pine St', 'Station Rd', 'Elm Way', 'Lakeview Dr', 'Mill Lane', 'Cedar Ct'];
const PLACES: [string, string, string][] = [['Portland', '97205', 'US'], ['Bristol', 'BS1 4DJ', 'GB'], ['Toronto', 'M5V 2T6', 'CA'], ['Austin', '78701', 'US'], ['Leeds', 'LS1 4AP', 'GB']];
const digit = () => String(Math.floor(Math.random() * 10));
/** A made-up card number that passes the Luhn check (a 4… test-style number, never a real card). */
export function demoCardNumber(): string {
  const body = '4' + Array.from({ length: 14 }, digit).join('');
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    let d = Number(body[body.length - 1 - i]);
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  const full = body + String((10 - (sum % 10)) % 10);
  return full.replace(/(\d{4})(?=\d)/g, '$1 ');
}
/** Made-up shipping and payment details for the demo checkout. */
export function demoValues(): FormValues {
  const first = pick(FIRST);
  const last = pick(LAST);
  const [city, postcode, country] = pick(PLACES);
  const year = (new Date().getFullYear() % 100) + 1 + Math.floor(Math.random() * 4);
  return {
    email: `${first}.${last}${Math.floor(Math.random() * 90 + 10)}@example.com`.toLowerCase(),
    name: `${first} ${last}`,
    address: `${Math.floor(Math.random() * 900 + 10)} ${pick(STREETS)}`,
    city,
    postcode,
    country,
    card_number: demoCardNumber(),
    card_expiry: `${String(Math.floor(Math.random() * 12) + 1).padStart(2, '0')}/${year}`,
    card_cvc: Array.from({ length: 3 }, digit).join(''),
  } as FormValues;
}
/** The visitor's values, with any empty field filled in with made-up ones (demo only). */
function withDemo(values: FormValues, fill: boolean): FormValues {
  if (!fill) return values;
  const demo = demoValues();
  const out = { ...values } as Record<string, string>;
  for (const [k, v] of Object.entries(demo)) if (!out[k]) out[k] = v as string;
  return out as FormValues;
}

export type Order = { number: string; values: FormValues; last4: string; summary: CartSummary };

const STORE = 'Ridgeline Supply Co.';

const logo = `<svg class="logo" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><circle cx="16" cy="16" r="16" fill="currentColor"/><path d="M5 23l7-10 4 5 3-4 8 9z" fill="#fff"/><circle cx="22" cy="10" r="2.5" fill="#fff"/></svg>`;

const favicon = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#334155"/><path d="M5 23l7-10 4 5 3-4 8 9z" fill="#fff"/></svg>',
)}`;

// Each release has its own look so a person can tell at a glance which one they are on: 1.4 "classic" (blue),
// 1.5 "express" (green), 1.6 and later "bold" (charcoal and orange).
export type Theme = 'classic' | 'express' | 'bold';
export function themeFor(version: string): Theme {
  if (version === '1.4') return 'classic';
  if (version === '1.5') return 'express';
  return 'bold';
}

const HERO: Record<Theme, { eyebrow: string; title: string; lead: string; cta: string }> = {
  classic: {
    eyebrow: 'New season, same promise',
    title: 'Gear for the long way round.',
    lead: 'Shoes, packs and shelter tested on wet ridges and cold mornings, and backed by repairs for life.',
    cta: 'Shop the collection',
  },
  express: {
    eyebrow: 'Order by 3pm, out the door today',
    title: 'Pick it, pack it, go.',
    lead: 'Add gear straight from the list and check out on one page. Repairs for life, as always.',
    cta: 'Start shopping',
  },
  bold: {
    eyebrow: 'Field tested. Built to last.',
    title: 'Made for the hard miles.',
    lead: 'Shoes, packs and shelter that take a beating on the ridge and come back for more. Repairs for life.',
    cta: 'Gear up',
  },
};

type PageOptions = { title: string; body: string; cartCount: number; description?: string; step?: 1 | 2 | 3 };

export function layout(r: Release, page: PageOptions): string {
  const theme = themeFor(r.version);
  const asset = (name: string) => `/assets/${name}?v=${encodeURIComponent(r.version)}`;
  return `<!doctype html>
<html lang="en" data-theme="${theme}" data-release="${e(r.version)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(page.title)} · ${STORE}</title>
<meta name="description" content="${e(page.description ?? 'Durable outdoor gear for long days outside.')}">
<meta name="shop-release" content="${e(r.version)}">
<link rel="icon" href="${favicon}">
<link rel="stylesheet" href="${asset('style.css')}">
<script src="${asset('app.js')}" defer></script>
</head>
<body>
<a class="skip-link" href="#main">Skip to main content</a>
<div class="promo">Free shipping on orders over ${formatMoney(FREE_SHIPPING_CENTS)} · 60-day returns · Repairs for life</div>
<header class="site-header">
  <div class="wrap header-inner">
    <a class="brand" href="/">${logo}<span class="brand-name">Ridgeline <span>Supply Co.</span></span></a>
    <nav class="main-nav" aria-label="Main">
      <a href="/#gear">Shop all</a>
      <a class="cart-link" href="/cart">${cartIcon}<span>Cart</span><span class="badge" data-cart-count${page.cartCount ? '' : ' hidden'}>${page.cartCount}</span><span class="visually-hidden" data-cart-label> (${itemCount(page.cartCount)})</span></a>
    </nav>
  </div>
</header>
${releaseStrip(r, page.step ?? 0)}
${r.ribbon ? `<p class="release-ribbon" data-release-ribbon>You’re seeing ${e(r.version)} ${RELEASE_NAME[theme]}</p>` : ''}
<main id="main" tabindex="-1">
${page.body}
</main>
<footer class="site-footer">
  <div class="wrap footer-grid">
    <div>
      <p class="brand brand-footer">${logo}<span class="brand-name">Ridgeline <span>Supply Co.</span></span></p>
      <p class="muted">Durable gear for long days outside. Built to be used hard, and repaired rather than replaced.</p>
    </div>
    <div>
      <h2 class="footer-heading">Shop</h2>
      <ul class="footer-list">${PRODUCTS.slice(0, 4).map((p) => `<li><a href="/product/${p.slug}">${e(p.name)}</a></li>`).join('')}</ul>
    </div>
    <div>
      <h2 class="footer-heading">Our promise</h2>
      <ul class="footer-list"><li>Free shipping over ${formatMoney(FREE_SHIPPING_CENTS)}</li><li>60-day no-quibble returns</li><li>Lifetime repairs on every product</li></ul>
    </div>
  </div>
  <div class="wrap footer-bottom">
    <p>© 2026 ${STORE} · Demo store: no real payments are taken.</p>
    ${r.badge ? `<p class="release" data-release-badge>Release ${e(r.version)}</p>` : ''}
    <p class="release-receipt" data-release-receipt hidden></p>
  </div>
</footer>
<div class="toast" role="status" aria-live="polite" data-toast hidden></div>
</body>
</html>`;
}

const cartIcon = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 4h2l2.4 10.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 1.9-1.4L21 8H6.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="10" cy="20" r="1.5" fill="currentColor"/><circle cx="17" cy="20" r="1.5" fill="currentColor"/></svg>`;

const checkIcon = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const itemCount = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;

const heroArt = `<svg class="hero-art" viewBox="0 0 480 300" aria-hidden="true" focusable="false">
  <circle cx="360" cy="86" r="40" fill="#fde68a"/>
  <path d="M0 230l90-110 60 64 90-124 110 140 50-46 80 76v70H0z" fill="var(--brand-300)"/>
  <path d="M240 60l-30 42 18-6 12 16 14-14 16 6z" fill="#fff" opacity=".9"/>
  <path d="M0 260l120-80 80 40 100-70 180 110v40H0z" fill="var(--brand-500)"/>
  <path d="M0 300v-24c80-30 160-30 240-10s160 20 240-6v40z" fill="var(--brand-700)"/>
  <path d="M60 250l14-30 14 30zM88 254l12-26 12 26zM392 262l14-32 14 32z" fill="var(--brand-900)"/>
</svg>`;

// ---------- pages ----------

export function catalogPage(r: Release, cartCount: number, added?: Product): string {
  const cards = PRODUCTS.map((p) => productCard(r, p)).join('\n');
  const hero = HERO[themeFor(r.version)];
  const body = `
<section class="hero">
  <div class="wrap hero-inner">
    <div class="hero-copy">
      <p class="eyebrow">${hero.eyebrow}</p>
      <h1>${hero.title}</h1>
      <p class="lead">${hero.lead}</p>
      <a class="btn btn-large" href="#gear">${hero.cta}</a>
    </div>
    ${heroArt}
  </div>
</section>
<div class="wrap">
  ${added ? addedNotice(added) : ''}
  <section id="gear" class="section" aria-labelledby="gear-heading">
    <div class="section-head">
      <h2 id="gear-heading">The collection</h2>
      <p class="muted">${PRODUCTS.length} products${r.onePage ? ' · add straight from here' : ''}</p>
    </div>
    <ul class="product-grid" role="list">
${cards}
    </ul>
  </section>
  <section class="perks" aria-label="Why shop with us">
    <div class="perk"><h3>Free shipping</h3><p>On every order over ${formatMoney(FREE_SHIPPING_CENTS)}, dispatched within one working day.</p></div>
    <div class="perk"><h3>60-day returns</h3><p>Used it and it isn’t right? Send it back within 60 days.</p></div>
    <div class="perk"><h3>Repairs for life</h3><p>Broken zip, torn seam, snapped pole: we fix it, for as long as you own it.</p></div>
  </section>
</div>`;
  return layout(r, { title: 'Outdoor gear', body, cartCount });
}

function productCard(r: Release, p: Product): string {
  const actions = r.onePage
    ? `<form class="express" method="post" action="/cart/add" data-express>
          <input type="hidden" name="slug" value="${p.slug}"><input type="hidden" name="qty" value="1"><input type="hidden" name="return" value="/">
          <button class="btn btn-small btn-outline" type="submit">Add to cart<span class="visually-hidden">: ${e(p.name)}</span></button>
        </form>`
    : `<a class="view-link" href="/product/${p.slug}" aria-hidden="true" tabindex="-1">View</a>`;
  const buy = r.onePage
    ? `<form class="buy-now" method="post" action="/cart/add" data-buy-now>
            <input type="hidden" name="slug" value="${p.slug}"><input type="hidden" name="qty" value="1">
            <button class="btn btn-large btn-block btn-buy" type="submit">Buy now<span class="visually-hidden">: ${e(p.name)}</span></button>
          </form>`
    : '';
  return `      <li class="product-card" id="product-${p.slug}">
        <a class="card-media" href="/product/${p.slug}" tabindex="-1" aria-hidden="true">${productArt(p)}</a>
        <div class="card-body">
          <p class="category">${e(p.category)}</p>
          <h3 class="card-title"><a href="/product/${p.slug}">${e(p.name)}</a></h3>
          <p class="card-text">${e(p.tagline)}</p>
          <div class="card-foot"><span class="price">${formatMoney(p.priceCents)}</span>${actions}</div>
          ${buy}
        </div>
      </li>`;
}

function addedNotice(p: Product): string {
  return `<div class="notice" role="status">${checkIcon}<p>Added <strong>${e(p.name)}</strong> to your cart.</p><a class="btn btn-small" href="/cart">View cart</a></div>`;
}

export function productPage(r: Release, p: Product, cartCount: number): string {
  const options = Array.from({ length: 5 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
  const others = PRODUCTS.filter((o) => o.slug !== p.slug).slice(0, 3);
  const body = `
<div class="wrap">
  <nav class="breadcrumb" aria-label="Breadcrumb"><ol><li><a href="/">Shop</a></li><li><a href="/#gear">${e(p.category)}</a></li><li aria-current="page">${e(p.name)}</li></ol></nav>
  <article class="product-detail">
    <div class="detail-media">${productArt(p, `Illustration of the ${p.name}`)}</div>
    <div class="detail-info">
      <p class="category">${e(p.category)}</p>
      <h1>${e(p.name)}</h1>
      <p class="detail-price">${formatMoney(p.priceCents)}</p>
      <p class="lead">${e(p.tagline)}</p>
      <form class="add-form" method="post" action="/cart/add">
        <input type="hidden" name="slug" value="${p.slug}">
        <div class="qty-field"><label for="qty">Quantity</label><select id="qty" name="qty">${options}</select></div>
        ${r.onePage ? '<button class="btn btn-large btn-buy" type="submit" data-buy-now>Buy now</button>' : '<button class="btn btn-large" type="submit">Add to cart</button>'}
      </form>
      <ul class="assurances" role="list">
        <li>${checkIcon}Free shipping over ${formatMoney(FREE_SHIPPING_CENTS)}</li>
        <li>${checkIcon}Ships within one working day</li>
        <li>${checkIcon}60-day returns, repairs for life</li>
      </ul>
      <h2 class="sub-heading">About this product</h2>
      <p>${e(p.description)}</p>
      <h2 class="sub-heading">Features</h2>
      <ul class="features">${p.features.map((f) => `<li>${e(f)}</li>`).join('')}</ul>
      <h2 class="sub-heading">Specifications</h2>
      <dl class="specs">${p.specs.map(([k, v]) => `<div><dt>${e(k)}</dt><dd>${e(v)}</dd></div>`).join('')}</dl>
    </div>
  </article>
  <section class="section" aria-labelledby="more-heading">
    <h2 id="more-heading">You might also like</h2>
    <ul class="mini-grid" role="list">${others.map(miniCard).join('')}</ul>
  </section>
</div>`;
  return layout(r, { title: p.name, body, cartCount, description: p.tagline });
}

const miniCard = (p: Product) =>
  `<li class="mini-card"><a href="/product/${p.slug}">${productArt(p)}<span class="mini-name">${e(p.name)}</span><span class="price">${formatMoney(p.priceCents)}</span></a></li>`;

type CheckoutState = { values?: FormValues; errors?: FormErrors; added?: Product };

export function cartPage(r: Release, s: CartSummary, state: CheckoutState = {}): string {
  const errors = state.errors ?? {};
  const empty = s.lines.length === 0;
  const items = empty
    ? `<div class="empty card"><h2>Your cart is empty</h2><p class="muted">Find something for your next trip.</p><a class="btn" href="/">Browse the collection</a></div>`
    : `<ul class="cart-lines" role="list">${s.lines.map(cartLine).join('')}</ul>`;

  const aside = empty
    ? ''
    : r.onePage
      ? `<aside class="summary-col" aria-label="Order summary">${summaryBox(s)}</aside>`
      : `<aside class="summary-col" aria-label="Order summary">${summaryBox(s, `<a class="btn btn-block btn-large" href="/checkout/details">Proceed to checkout</a>`)}</aside>`;

  const checkout =
    r.onePage && !empty
      ? `<section id="checkout" class="card checkout-card" aria-labelledby="checkout-heading">
      <h2 id="checkout-heading">Checkout</h2>
      <p class="muted">Everything on one page. Your order is placed when you press the button below.</p>
      <form id="checkout-form" class="checkout-form" method="post" action="/checkout">
        ${shippingFieldsets(withDemo(state.values ?? {}, !!r.ribbon), errors)}
        ${paymentFieldset(state.values ?? {}, errors, !!r.ribbon)}
        <button class="btn btn-large btn-block" type="submit">Place order · ${formatMoney(s.totalCents)}</button>
        <p class="fine-print">By placing your order you agree to our terms of sale. You won’t be charged: this is a demo store.</p>
      </form>
    </section>`
      : '';

  const body = `
<div class="wrap">
  ${empty ? '' : r.onePage ? onePageBanner : multiStepBanner}
  ${state.added ? addedNotice(state.added) : ''}
  ${errorSummary(errors)}
  <h1 class="page-title">Your cart${empty ? '' : ` <span class="muted count">(${itemCount(s.count)})</span>`}</h1>
  <div class="${empty ? '' : 'two-col'}">
    <div class="main-col">
      ${items}
      ${checkout}
    </div>
    ${aside}
  </div>
</div>`;
  return layout(r, { title: 'Your cart', body, cartCount: s.count });
}

function cartLine(line: CartSummary['lines'][number]): string {
  const p = line.product;
  const options = Array.from({ length: MAX_QTY }, (_, i) => i + 1)
    .map((n) => `<option value="${n}"${n === line.qty ? ' selected' : ''}>${n}</option>`)
    .join('');
  return `<li class="cart-line">
    <a class="line-media" href="/product/${p.slug}" tabindex="-1" aria-hidden="true">${productArt(p)}</a>
    <div class="line-info">
      <h3 class="line-name"><a href="/product/${p.slug}">${e(p.name)}</a></h3>
      <p class="muted">${formatMoney(p.priceCents)} each</p>
      <div class="line-actions">
        <form class="qty-form" method="post" action="/cart/update">
          <input type="hidden" name="slug" value="${p.slug}">
          <label for="qty-${p.slug}">Qty</label>
          <select id="qty-${p.slug}" name="qty" data-autosubmit>${options}</select>
          <button class="btn btn-small btn-outline" type="submit" data-js-hide>Update</button>
        </form>
        <form method="post" action="/cart/update">
          <input type="hidden" name="slug" value="${p.slug}"><input type="hidden" name="qty" value="0">
          <button class="link-button" type="submit">Remove<span class="visually-hidden"> ${e(p.name)}</span></button>
        </form>
      </div>
    </div>
    <p class="line-total">${formatMoney(line.totalCents)}</p>
  </li>`;
}

function summaryBox(s: CartSummary, footer = ''): string {
  const toFree = FREE_SHIPPING_CENTS - s.subtotalCents;
  return `<div class="card summary">
    <h2 class="summary-title">Order summary</h2>
    <ul class="summary-lines" role="list">${s.lines
      .map((l) => `<li><span>${e(l.product.name)} <span class="muted">× ${l.qty}</span></span><span>${formatMoney(l.totalCents)}</span></li>`)
      .join('')}</ul>
    <dl class="totals">
      <div><dt>Subtotal</dt><dd>${formatMoney(s.subtotalCents)}</dd></div>
      <div><dt>Shipping</dt><dd>${s.shippingCents ? formatMoney(s.shippingCents) : 'Free'}</dd></div>
      <div class="grand"><dt>Total</dt><dd>${formatMoney(s.totalCents)}</dd></div>
    </dl>
    ${toFree > 0 && s.subtotalCents > 0 ? `<p class="hint-box">Add ${formatMoney(toFree)} more for free shipping.</p>` : ''}
    ${footer}
  </div>`;
}

// The two checkouts must look different at a glance: 1.4 says "Step N of 3" on every page, 1.5 says everything is
// on this one page.
const STEP_NAMES = ['Shipping', 'Payment', 'Confirmation'];

const multiStepBanner = `<div class="checkout-mode mode-steps"><p class="mode-title">Checkout in 3 steps</p><ol class="mode-list">${STEP_NAMES.map((n) => `<li>${n}</li>`).join('')}</ol></div>`;

const onePageBanner = `<div class="checkout-mode mode-onepage"><p class="mode-title">One-page checkout</p><p class="mode-text">Cart, shipping and payment are all on this page. No further steps.</p></div>`;

function steps(current: 1 | 2 | 3): string {
  const names = STEP_NAMES;
  return `<nav class="steps-nav" aria-label="Checkout progress"><p class="step-of">Step ${current} of ${names.length}</p><ol class="steps">${names
    .map((name, i) => {
      const n = i + 1;
      const state = n < current ? 'done' : n === current ? 'current' : 'todo';
      return `<li class="step step-${state}"${n === current ? ' aria-current="step"' : ''}><span class="step-num" aria-hidden="true">${n < current ? '✓' : n}</span>${name}${n < current ? '<span class="visually-hidden"> (completed)</span>' : ''}</li>`;
    })
    .join('')}</ol></nav>`;
}

export function detailsPage(r: Release, s: CartSummary, values: FormValues, errors: FormErrors = {}): string {
  const body = `
<div class="wrap">
  ${steps(1)}
  ${errorSummary(errors)}
  <h1 class="page-title">Shipping details</h1>
  <div class="two-col">
    <div class="main-col">
      <form class="card checkout-form" method="post" action="/checkout/details">
        ${shippingFieldsets(withDemo(values, !!r.ribbon), errors)}
        <div class="form-actions"><a class="link-back" href="/cart">← Back to cart</a><button class="btn btn-large" type="submit">Continue to payment</button></div>
      </form>
    </div>
    <aside class="summary-col" aria-label="Order summary">${summaryBox(s)}</aside>
  </div>
</div>`;
  return layout(r, { title: 'Shipping details', body, cartCount: s.count, step: 1 });
}

export function paymentPage(r: Release, s: CartSummary, values: FormValues, errors: FormErrors = {}): string {
  const hidden = SHIPPING_FIELDS.map((f) => `<input type="hidden" name="${f}" value="${e(values[f])}">`).join('');
  const body = `
<div class="wrap">
  ${steps(2)}
  ${errorSummary(errors)}
  <h1 class="page-title">Payment</h1>
  <div class="two-col">
    <div class="main-col">
      <section class="card review" aria-labelledby="review-heading">
        <div class="review-head"><h2 id="review-heading">Shipping to</h2><a href="/checkout/details">Edit<span class="visually-hidden"> shipping details</span></a></div>
        <p>${address(values)}</p>
        <p class="muted">${e(values.email)}</p>
      </section>
      <form class="card checkout-form" method="post" action="/checkout">
        ${hidden}
        ${paymentFieldset(values, errors, !!r.ribbon)}
        <div class="form-actions"><a class="link-back" href="/checkout/details">← Back</a><button class="btn btn-large" type="submit">Place order · ${formatMoney(s.totalCents)}</button></div>
      </form>
    </div>
    <aside class="summary-col" aria-label="Order summary">${summaryBox(s)}</aside>
  </div>
</div>`;
  return layout(r, { title: 'Payment', body, cartCount: s.count, step: 2 });
}

export function confirmationPage(r: Release, order: Order): string {
  const v = order.values;
  const first = (v.name ?? '').split(/\s+/)[0] ?? '';
  const body = `
<div class="wrap narrow">
  ${r.onePage ? "" : steps(3)}
  <section class="card confirmation" aria-labelledby="thanks-heading">
    <div class="confirm-icon">${checkIcon}</div>
    <h1 id="thanks-heading">Thank you${first ? `, ${e(first)}` : ''}!</h1>
    <p class="lead">Your order is confirmed. A receipt is on its way to <strong>${e(v.email)}</strong>.</p>
    <p class="order-number-box">Order number <strong class="order-number" data-order-number>${e(order.number)}</strong></p>
    <dl class="order-meta">
      <div><dt>Ship to</dt><dd>${address(v)}</dd></div>
      <div><dt>Payment</dt><dd>Card ending ${e(order.last4)}</dd></div>
      <div><dt>Estimated delivery</dt><dd>3–5 working days</dd></div>
    </dl>
    ${summaryBox(order.summary)}
    <a class="btn btn-large" href="/">Continue shopping</a>
  </section>
</div>`;
  return layout(r, { title: `Order ${order.number} confirmed`, body, cartCount: 0, step: 3 });
}

export function notFoundPage(r: Release, cartCount: number): string {
  const body = `
<div class="wrap narrow">
  <section class="card status-page">
    <p class="status-code">404</p>
    <h1>We couldn’t find that trail</h1>
    <p class="muted">The page you were looking for has moved or never existed.</p>
    <a class="btn" href="/">Back to the shop</a>
  </section>
</div>`;
  return layout(r, { title: 'Page not found', body, cartCount });
}

export function errorPage(r: Release): string {
  const body = `
<div class="wrap narrow">
  <section class="card status-page">
    <p class="status-code">500</p>
    <h1>Something went wrong on our side</h1>
    <p class="muted">Sorry about that. Your cart is safe; please try again in a moment.</p>
    <a class="btn" href="/">Back to the shop</a>
  </section>
</div>`;
  return layout(r, { title: 'Something went wrong', body, cartCount: 0 });
}

export function methodNotAllowedPage(r: Release, cartCount: number): string {
  const body = `<div class="wrap narrow"><section class="card status-page"><p class="status-code">405</p><h1>That action isn’t available here</h1><a class="btn" href="/">Back to the shop</a></section></div>`;
  return layout(r, { title: 'Not allowed', body, cartCount });
}

// ---------- form pieces ----------

type FieldSpec = {
  name: Field;
  label: string;
  type?: string;
  autocomplete: string;
  inputmode?: string;
  placeholder?: string;
  hint?: string;
  maxlength?: number;
  half?: boolean;
};

const LABELS: Record<Field | 'cart', string> = {
  email: 'Email',
  name: 'Full name',
  address: 'Street address',
  city: 'Town or city',
  postcode: 'Postcode / ZIP',
  country: 'Country',
  card_number: 'Card number',
  card_expiry: 'Expiry date',
  card_cvc: 'Security code',
  cart: 'Cart',
};

function input(spec: FieldSpec, values: FormValues, errors: FormErrors): string {
  const id = `f-${spec.name}`;
  const error = errors[spec.name];
  const describedBy = [spec.hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ');
  const attrs = [
    `id="${id}"`,
    `name="${spec.name}"`,
    `type="${spec.type ?? 'text'}"`,
    `autocomplete="${spec.autocomplete}"`,
    'required',
    spec.inputmode ? `inputmode="${spec.inputmode}"` : '',
    spec.placeholder ? `placeholder="${spec.placeholder}"` : '',
    spec.maxlength ? `maxlength="${spec.maxlength}"` : '',
    describedBy ? `aria-describedby="${describedBy}"` : '',
    error ? 'aria-invalid="true"' : '',
    `value="${e(values[spec.name])}"`,
  ].filter(Boolean);
  if (spec.name === 'card_number') attrs.push('data-card-number');
  if (spec.name === 'card_expiry') attrs.push('data-card-expiry');
  return `<div class="field${spec.half ? ' half' : ''}${error ? ' has-error' : ''}">
    <label for="${id}">${spec.label}</label>
    ${spec.hint ? `<p class="field-hint" id="${id}-hint">${spec.hint}</p>` : ''}
    ${error ? `<p class="field-error" id="${id}-error">${e(error)}</p>` : ''}
    <input ${attrs.join(' ')}>
  </div>`;
}

function countrySelect(values: FormValues, errors: FormErrors): string {
  const error = errors.country;
  const selected = values.country || 'US';
  const options = COUNTRIES.map(
    ([code, name]) => `<option value="${code}"${code === selected ? ' selected' : ''}>${e(name)}</option>`,
  ).join('');
  return `<div class="field half${error ? ' has-error' : ''}">
    <label for="f-country">Country</label>
    ${error ? `<p class="field-error" id="f-country-error">${e(error)}</p>` : ''}
    <select id="f-country" name="country" autocomplete="country" required${error ? ' aria-invalid="true" aria-describedby="f-country-error"' : ''}>${options}</select>
  </div>`;
}

function shippingFieldsets(values: FormValues, errors: FormErrors): string {
  return `<fieldset>
      <legend>Contact</legend>
      ${input({ name: 'email', label: 'Email', type: 'email', autocomplete: 'email', hint: 'For your receipt and delivery updates.' }, values, errors)}
    </fieldset>
    <fieldset>
      <legend>Shipping address</legend>
      ${input({ name: 'name', label: 'Full name', autocomplete: 'name', maxlength: 100 }, values, errors)}
      ${input({ name: 'address', label: 'Street address', autocomplete: 'street-address' }, values, errors)}
      <div class="field-row">
        ${input({ name: 'city', label: 'Town or city', autocomplete: 'address-level2', half: true }, values, errors)}
        ${input({ name: 'postcode', label: 'Postcode / ZIP', autocomplete: 'postal-code', maxlength: 10, half: true }, values, errors)}
      </div>
      ${countrySelect(values, errors)}
    </fieldset>`;
}

function paymentFieldset(values: FormValues, errors: FormErrors, fill = false): string {
  // The security code a visitor typed is never echoed back into the page; a made-up one may be filled in.
  const safe: FormValues = withDemo({ ...values, card_cvc: '' }, fill);
  return `<fieldset>
      <legend>Payment</legend>
      <p class="demo-card">${fill ? 'Demo store: filled in with made-up details so you can check out in one click. Change anything you like; any valid test card number works.' : 'Demo store: any valid test card number (for example 4242 4242 4242 4242), any future expiry date and any 3-digit code.'}</p>
      ${input({ name: 'card_number', label: 'Card number', autocomplete: 'cc-number', inputmode: 'numeric', placeholder: '1234 5678 9012 3456', maxlength: 23 }, safe, errors)}
      <div class="field-row">
        ${input({ name: 'card_expiry', label: 'Expiry date', autocomplete: 'cc-exp', inputmode: 'numeric', placeholder: 'MM/YY', maxlength: 7, half: true }, safe, errors)}
        ${input({ name: 'card_cvc', label: 'Security code', autocomplete: 'cc-csc', inputmode: 'numeric', placeholder: '123', maxlength: 4, half: true }, safe, errors)}
      </div>
    </fieldset>`;
}

function errorSummary(errors: FormErrors): string {
  const order: (Field | 'cart')[] = ['cart', ...SHIPPING_FIELDS, ...PAYMENT_FIELDS];
  const present = order.filter((f) => errors[f]);
  if (present.length === 0) return '';
  const items = present
    .map((f) => (f === 'cart' ? `<li><a href="/">${e(errors[f])}</a></li>` : `<li><a href="#f-${f}">${LABELS[f]}: ${e(errors[f])}</a></li>`))
    .join('');
  return `<div class="error-summary" role="alert" tabindex="-1" data-error-summary>
    <h2>There ${present.length === 1 ? 'is a problem' : `are ${present.length} problems`} with your order</h2>
    <ul>${items}</ul>
  </div>`;
}

function address(v: FormValues): string {
  return [v.name, v.address, [v.city, v.postcode].filter(Boolean).join(' '), countryName(v.country)]
    .filter(Boolean)
    .map((line) => e(line))
    .join('<br>');
}
