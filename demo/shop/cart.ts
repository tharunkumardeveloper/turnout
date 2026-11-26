// The cart lives in the visitor's own `shop_cart` cookie: "slug:qty|slug:qty". No server-side session.
import { findProduct, type Product } from './catalog.ts';

export const CART_COOKIE = 'shop_cart';
export const MAX_QTY = 10;
export const FREE_SHIPPING_CENTS = 10000;
export const SHIPPING_CENTS = 800;

export type Cart = Map<string, number>; // slug -> quantity
export type CartLine = { product: Product; qty: number; totalCents: number };
export type CartSummary = { lines: CartLine[]; count: number; subtotalCents: number; shippingCents: number; totalCents: number };

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

// Unknown products and silly quantities are dropped rather than trusted.
export function parseCart(raw: string | undefined): Cart {
  const cart: Cart = new Map();
  let decoded = '';
  try {
    decoded = decodeURIComponent(raw ?? '');
  } catch {
    return cart;
  }
  for (const entry of decoded.split('|')) {
    const [slug = '', qtyText = ''] = entry.split(':');
    const qty = Number.parseInt(qtyText, 10);
    if (findProduct(slug) && Number.isInteger(qty) && qty > 0) cart.set(slug, Math.min(qty, MAX_QTY));
  }
  return cart;
}

export function cartCookie(cart: Cart): string {
  const value = [...cart].map(([slug, qty]) => `${slug}:${qty}`).join('|');
  if (!value) return `${CART_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
  return `${CART_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${60 * 60 * 24 * 30}; HttpOnly; SameSite=Lax`;
}

export function addToCart(cart: Cart, slug: string, qty: number): Cart {
  const next = new Map(cart);
  next.set(slug, Math.min((next.get(slug) ?? 0) + qty, MAX_QTY));
  return next;
}

export function setQuantity(cart: Cart, slug: string, qty: number): Cart {
  const next = new Map(cart);
  if (qty <= 0) next.delete(slug);
  else next.set(slug, Math.min(qty, MAX_QTY));
  return next;
}

export function summarize(cart: Cart): CartSummary {
  const lines: CartLine[] = [];
  for (const [slug, qty] of cart) {
    const product = findProduct(slug);
    if (product) lines.push({ product, qty, totalCents: product.priceCents * qty });
  }
  const subtotalCents = lines.reduce((sum, l) => sum + l.totalCents, 0);
  const count = lines.reduce((sum, l) => sum + l.qty, 0);
  const shippingCents = subtotalCents === 0 || subtotalCents >= FREE_SHIPPING_CENTS ? 0 : SHIPPING_CENTS;
  return { lines, count, subtotalCents, shippingCents, totalCents: subtotalCents + shippingCents };
}
