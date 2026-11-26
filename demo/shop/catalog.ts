// Product catalog for Ridgeline Supply Co., with a hand-drawn inline SVG for each product.
import { escapeHtml } from './html.ts';

export type Product = {
  slug: string;
  name: string;
  category: string;
  priceCents: number;
  tagline: string;
  description: string;
  features: string[];
  specs: [label: string, value: string][];
  tint: string; // card background behind the illustration
  color: string; // main product colour
  accent: string; // secondary colour
};

export const PRODUCTS: Product[] = [
  {
    slug: 'ridgeback-trail-runners',
    name: 'Ridgeback Trail Runners',
    category: 'Footwear',
    priceCents: 12900,
    tagline: 'Lightweight, grippy and ready for mud.',
    description:
      'A trail shoe for fast days on rough ground. The 5 mm lugs bite into wet rock and loose dirt, the rock plate takes the sting out of sharp scree, and the breathable mesh upper dries before the next river crossing.',
    features: ['5 mm multi-directional lugs', 'Flexible rock plate', 'Quick-dry recycled mesh upper', 'Gusseted tongue keeps grit out'],
    specs: [['Weight', '290 g (per shoe, size 9)'], ['Drop', '6 mm'], ['Stack height', '28 / 22 mm'], ['Upper', 'Recycled polyester mesh']],
    tint: '#fde7d9',
    color: '#ea580c',
    accent: '#1f2937',
  },
  {
    slug: 'summit-28-daypack',
    name: 'Summit 28L Daypack',
    category: 'Packs',
    priceCents: 8900,
    tagline: 'Carries a full day out, and nothing you don’t need.',
    description:
      'Twenty-eight litres with a ventilated back panel, a stretch front pocket for a wet shell and a hydration sleeve that fits a 3 L bladder. The hip belt is padded but removable for town days.',
    features: ['Ventilated mesh back panel', 'Stretch front pocket for wet layers', 'Hydration sleeve and hose port', 'Removable padded hip belt'],
    specs: [['Volume', '28 L'], ['Weight', '840 g'], ['Torso fit', '41–51 cm'], ['Fabric', '210D recycled ripstop nylon']],
    tint: '#dcefe9',
    color: '#0f766e',
    accent: '#134e4a',
  },
  {
    slug: 'alpine-storm-shell',
    name: 'Alpine Storm Shell',
    category: 'Clothing',
    priceCents: 18900,
    tagline: 'Three-layer waterproof that still breathes on the climb.',
    description:
      'A fully taped three-layer shell for weather that turns. Pit zips dump heat on the way up, the helmet-compatible hood adjusts with one hand, and it packs into its own chest pocket.',
    features: ['Three-layer waterproof membrane, fully taped seams', 'Helmet-compatible adjustable hood', 'Two-way pit zips', 'Packs into its own chest pocket'],
    specs: [['Weight', '395 g (size M)'], ['Waterproofing', '20,000 mm'], ['Breathability', '20,000 g/m²/24h'], ['Fit', 'Regular, room for a midlayer']],
    tint: '#fde2e4',
    color: '#be123c',
    accent: '#881337',
  },
  {
    slug: 'ember-camp-stove',
    name: 'Ember Camp Stove',
    category: 'Camp kitchen',
    priceCents: 6400,
    tagline: 'Boils a litre in three and a half minutes.',
    description:
      'A compact canister stove with a wide, wind-resistant burner and a precise simmer valve. Folds down to fit inside most 750 ml pots, and the piezo igniter means no hunting for a lighter at dawn.',
    features: ['Wind-resistant recessed burner', 'Precise simmer control valve', 'Built-in piezo igniter', 'Folds to fit inside a 750 ml pot'],
    specs: [['Weight', '88 g'], ['Boil time', '3 min 30 s (1 L)'], ['Output', '2,800 W'], ['Fuel', 'Screw-thread gas canister']],
    tint: '#fef3c7',
    color: '#64748b',
    accent: '#f59e0b',
  },
  {
    slug: 'canyon-insulated-bottle',
    name: 'Canyon Insulated Bottle',
    category: 'Hydration',
    priceCents: 3200,
    tagline: 'Cold for a day, hot for a morning.',
    description:
      'A 750 ml double-wall steel bottle with a leak-proof cap and a powder coat that grips with wet hands. Keeps water cold for 24 hours and coffee hot for 12.',
    features: ['Double-wall vacuum insulation', 'Leak-proof cap with carry loop', 'Grippy powder-coat finish', 'Fits standard cup holders'],
    specs: [['Capacity', '750 ml'], ['Weight', '360 g'], ['Cold', '24 hours'], ['Hot', '12 hours']],
    tint: '#e0f2fe',
    color: '#0369a1',
    accent: '#0c4a6e',
  },
  {
    slug: 'northstar-2p-tent',
    name: 'Northstar 2P Tent',
    category: 'Shelter',
    priceCents: 34900,
    tagline: 'A two-person tent that pitches in five minutes, in the rain.',
    description:
      'A freestanding two-person tent with two doors, two vestibules and a fly that pitches first, so the inner stays dry on wet evenings. Colour-coded clips make it a five-minute job, even by headtorch.',
    features: ['Freestanding, fly-first pitch', 'Two doors and two vestibules', 'Colour-coded poles and clips', 'Stuff sack with compression straps'],
    specs: [['Packed weight', '1.9 kg'], ['Floor area', '2.9 m²'], ['Peak height', '102 cm'], ['Seasons', '3']],
    tint: '#e0e7ff',
    color: '#4338ca',
    accent: '#f59e0b',
  },
];

export function findProduct(slug: string): Product | undefined {
  return PRODUCTS.find((p) => p.slug === slug);
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const formatMoney = (cents: number): string => money.format(cents / 100);

// Each drawing uses a 320 x 240 view box; colours come from the product so the set looks consistent.
const drawings: Record<string, (p: Product) => string> = {
  'ridgeback-trail-runners': (p) => `
    <ellipse cx="164" cy="188" rx="118" ry="10" fill="#000" opacity=".08"/>
    <path d="M54 150c0-26 18-42 44-46l40-8c12-3 20-14 26-26l30-4c8 16 26 28 52 34 26 6 40 22 38 44v6H54z" fill="${p.color}"/>
    <path d="M164 70l30-4c4 9 11 17 20 22l-34 10c-8-6-13-16-16-28z" fill="#fff" opacity=".25"/>
    <path d="M86 140c40-6 80-22 112-46" stroke="#fff" stroke-width="8" stroke-linecap="round" fill="none" opacity=".85"/>
    <path d="M132 100l14 12M144 92l14 12M156 84l14 12" stroke="${p.accent}" stroke-width="5" stroke-linecap="round"/>
    <path d="M46 156h240c4 0 6 6 2 12-6 10-18 14-30 14H70c-14 0-26-10-24-26z" fill="${p.accent}"/>
    <path d="M70 182v8M98 182v8M126 182v8M154 182v8M182 182v8M210 182v8M238 182v8" stroke="${p.accent}" stroke-width="7" stroke-linecap="round"/>
    <circle cx="256" cy="132" r="5" fill="#fff" opacity=".7"/>`,
  'summit-28-daypack': (p) => `
    <ellipse cx="160" cy="210" rx="78" ry="9" fill="#000" opacity=".08"/>
    <path d="M110 64c0-22 22-36 50-36s50 14 50 36" stroke="${p.accent}" stroke-width="10" fill="none" stroke-linecap="round"/>
    <rect x="98" y="56" width="124" height="150" rx="30" fill="${p.color}"/>
    <path d="M98 96c0-22 16-40 62-40s62 18 62 40v6H98z" fill="${p.accent}"/>
    <rect x="118" y="124" width="84" height="64" rx="16" fill="${p.accent}" opacity=".55"/>
    <path d="M124 140h72" stroke="#fff" stroke-width="4" stroke-linecap="round" opacity=".7"/>
    <rect x="152" y="100" width="16" height="16" rx="4" fill="#fbbf24"/>
    <path d="M98 120h-10M222 120h10M98 160h-10M222 160h10" stroke="${p.accent}" stroke-width="6" stroke-linecap="round"/>`,
  'alpine-storm-shell': (p) => `
    <ellipse cx="160" cy="214" rx="96" ry="8" fill="#000" opacity=".08"/>
    <path d="M124 46c8-14 64-14 72 0l50 26 34 92-30 10-24-60v100H94V104l-24 60-30-10 34-92z" fill="${p.color}"/>
    <path d="M124 46c4 22 18 34 36 34s32-12 36-34c-10-8-62-8-72 0z" fill="${p.accent}"/>
    <path d="M160 80v124" stroke="#fff" stroke-width="4" stroke-dasharray="6 5" opacity=".85"/>
    <rect x="176" y="104" width="34" height="8" rx="4" fill="${p.accent}"/>
    <path d="M94 186h132" stroke="${p.accent}" stroke-width="8"/>
    <path d="M70 164l-30-10M250 164l30 10" stroke="${p.accent}" stroke-width="8" stroke-linecap="round"/>`,
  'ember-camp-stove': (p) => `
    <ellipse cx="160" cy="206" rx="90" ry="9" fill="#000" opacity=".08"/>
    <path d="M110 168h100l-14 34h-72z" fill="${p.color}"/>
    <rect x="104" y="160" width="112" height="12" rx="6" fill="#334155"/>
    <path d="M118 160l-20-18M202 160l20-18M160 160v-22" stroke="#334155" stroke-width="6" stroke-linecap="round"/>
    <path d="M160 152c-18-10-20-30-6-46 2 14 10 16 14 10 4-10-2-20 4-30 14 16 22 46-12 66z" fill="${p.accent}"/>
    <path d="M160 150c-8-6-8-16 0-24 2 8 8 10 10 4 4 10 0 16-10 20z" fill="#fde68a"/>
    <path d="M86 80h148v24c0 10-8 18-18 18H104c-10 0-18-8-18-18z" fill="#475569"/>
    <rect x="80" y="72" width="160" height="12" rx="6" fill="#64748b"/>
    <path d="M240 78h32" stroke="#334155" stroke-width="8" stroke-linecap="round"/>
    <path d="M136 60c0-10 8-10 8-20M160 60c0-10 8-10 8-20M184 60c0-10 8-10 8-20" stroke="#94a3b8" stroke-width="4" stroke-linecap="round" fill="none"/>`,
  'canyon-insulated-bottle': (p) => `
    <ellipse cx="160" cy="214" rx="60" ry="8" fill="#000" opacity=".08"/>
    <rect x="134" y="26" width="52" height="30" rx="8" fill="${p.accent}"/>
    <path d="M186 34c18 0 18 22 0 22" stroke="${p.accent}" stroke-width="7" fill="none"/>
    <path d="M128 56h64v14c10 6 16 16 16 30v96c0 10-8 16-18 16h-60c-10 0-18-6-18-16v-96c0-14 6-24 16-30z" fill="${p.color}"/>
    <rect x="112" y="118" width="96" height="40" fill="#fff" opacity=".9"/>
    <path d="M128 148l16-18 10 10 14-16 24 24z" fill="${p.color}"/>
    <path d="M124 86v96" stroke="#fff" stroke-width="6" stroke-linecap="round" opacity=".35"/>`,
  'northstar-2p-tent': (p) => `
    <circle cx="72" cy="52" r="3" fill="${p.accent}"/><circle cx="252" cy="38" r="4" fill="${p.accent}"/><circle cx="214" cy="70" r="2.5" fill="${p.accent}"/>
    <path d="M0 196l62-58 46 36 52-62 70 66 40-30 50 48z" fill="#c7d2fe"/>
    <path d="M30 200l130-128 130 128z" fill="${p.color}"/>
    <path d="M160 72l-38 128h76z" fill="#312e81"/>
    <path d="M160 72l-22 128h44z" fill="${p.accent}" opacity=".9"/>
    <path d="M160 72L30 200M160 72l130 128" stroke="#1e1b4b" stroke-width="4" stroke-linecap="round"/>
    <path d="M20 202h280" stroke="#1e1b4b" stroke-width="4" stroke-linecap="round" opacity=".5"/>
    <path d="M160 72V58" stroke="#1e1b4b" stroke-width="4" stroke-linecap="round"/>`,
};

// The product's illustration. With a label it is announced as an image; without one it is decorative.
export function productArt(p: Product, label?: string): string {
  const a11y = label ? `role="img" aria-label="${escapeHtml(label)}"` : 'aria-hidden="true" focusable="false"';
  const draw = drawings[p.slug] ?? (() => '');
  return `<svg class="art" viewBox="0 0 320 240" xmlns="http://www.w3.org/2000/svg" ${a11y}><rect width="320" height="240" fill="${p.tint}"/>${draw(p)}</svg>`;
}
