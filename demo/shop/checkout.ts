// Checkout fields and their server-side validation. Both releases post the same fields to POST /checkout.
import { randomBytes } from 'node:crypto';

export const DETAILS_COOKIE = 'shop_checkout'; // release 1.4 keeps step-one answers here between steps

export const SHIPPING_FIELDS = ['email', 'name', 'address', 'city', 'postcode', 'country'] as const;
export const PAYMENT_FIELDS = ['card_number', 'card_expiry', 'card_cvc'] as const;

export type ShippingField = (typeof SHIPPING_FIELDS)[number];
export type PaymentField = (typeof PAYMENT_FIELDS)[number];
export type Field = ShippingField | PaymentField;
export type FormValues = Partial<Record<Field, string>>;
export type FormErrors = Partial<Record<Field | 'cart', string>>;

export const COUNTRIES: [code: string, name: string][] = [
  ['US', 'United States'],
  ['CA', 'Canada'],
  ['GB', 'United Kingdom'],
  ['IE', 'Ireland'],
  ['DE', 'Germany'],
  ['FR', 'France'],
  ['NL', 'Netherlands'],
  ['ES', 'Spain'],
  ['IT', 'Italy'],
  ['SE', 'Sweden'],
  ['NO', 'Norway'],
  ['IN', 'India'],
  ['JP', 'Japan'],
  ['AU', 'Australia'],
  ['NZ', 'New Zealand'],
];

export const countryName = (code: string | undefined): string => COUNTRIES.find(([c]) => c === code)?.[1] ?? code ?? '';

export function pickValues(form: URLSearchParams, fields: readonly Field[]): FormValues {
  const values: FormValues = {};
  for (const field of fields) values[field] = (form.get(field) ?? '').trim().slice(0, 254);
  return values;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const POSTCODE = /^[A-Za-z0-9][A-Za-z0-9 -]{1,9}$/;

export function validateShipping(v: FormValues): FormErrors {
  const errors: FormErrors = {};
  if (!v.email) errors.email = 'Enter your email address.';
  else if (!EMAIL.test(v.email)) errors.email = 'Enter an email address like name@example.com.';
  if (!v.name) errors.name = 'Enter your full name.';
  else if (v.name.length > 100) errors.name = 'Your name must be 100 characters or fewer.';
  if (!v.address) errors.address = 'Enter your street address.';
  if (!v.city) errors.city = 'Enter your town or city.';
  if (!v.postcode) errors.postcode = 'Enter your postcode or ZIP code.';
  else if (!POSTCODE.test(v.postcode)) errors.postcode = 'Enter a valid postcode or ZIP code.';
  if (!COUNTRIES.some(([code]) => code === v.country)) errors.country = 'Choose a country we ship to.';
  return errors;
}

export function validatePayment(v: FormValues, now = new Date()): FormErrors {
  const errors: FormErrors = {};
  const digits = (v.card_number ?? '').replace(/[\s-]/g, '');
  if (!digits) errors.card_number = 'Enter your card number.';
  else if (!/^\d{13,19}$/.test(digits) || !luhn(digits)) errors.card_number = 'Enter a valid card number.';

  const expiry = /^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/.exec(v.card_expiry ?? '');
  if (!v.card_expiry) errors.card_expiry = 'Enter the expiry date.';
  else if (!expiry) errors.card_expiry = 'Enter the expiry date as MM/YY.';
  else {
    const month = Number(expiry[1]);
    const year = Number(expiry[2]!.length === 2 ? `20${expiry[2]}` : expiry[2]);
    if (month < 1 || month > 12) errors.card_expiry = 'Enter a month between 01 and 12.';
    else if (year * 12 + month < now.getFullYear() * 12 + now.getMonth() + 1) errors.card_expiry = 'This card has expired.';
  }

  if (!v.card_cvc) errors.card_cvc = 'Enter the 3 or 4 digit security code.';
  else if (!/^\d{3,4}$/.test(v.card_cvc)) errors.card_cvc = 'The security code is 3 or 4 digits.';
  return errors;
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export const lastFour = (cardNumber: string | undefined): string => (cardNumber ?? '').replace(/\D/g, '').slice(-4);

// Order numbers avoid look-alike characters (0/O, 1/I) so they read well over the phone.
const ORDER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function orderNumber(): string {
  const bytes = randomBytes(8);
  let out = '';
  for (const b of bytes) out += ORDER_ALPHABET[b % ORDER_ALPHABET.length];
  return `RL-${out}`;
}

export function detailsCookie(values: FormValues): string {
  const shipping: FormValues = {};
  for (const field of SHIPPING_FIELDS) shipping[field] = values[field] ?? '';
  const encoded = Buffer.from(JSON.stringify(shipping)).toString('base64url');
  return `${DETAILS_COOKIE}=${encoded}; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax`;
}

export const clearDetailsCookie = `${DETAILS_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;

export function parseDetails(raw: string | undefined): FormValues | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    const values: FormValues = {};
    for (const field of SHIPPING_FIELDS) {
      const value = record[field];
      values[field] = typeof value === 'string' ? value.slice(0, 254) : '';
    }
    return values;
  } catch {
    return undefined;
  }
}
