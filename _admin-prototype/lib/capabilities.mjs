// What the website can change WITHOUT an app release, and what needs an iOS release (and Android
// work once Android supports the remote catalog; today no Android client reads it).
// The admin edits data inside the v1 contract. It cannot create app functionality: layouts,
// styling, copy fixed in the apps, and new kinds are native code on each platform.

import { BUNDLED_WHEEL_IDS, BUNDLED_BRAND_IDS, KNOWN_KINDS, RVP_SPONSOR_ID } from './validator.mjs';
import { RING_WHEEL_COUNT } from './resolve.mjs';

export const EDITABLE_WITHOUT_RELEASE = [
  'Add, remove, hide and reorder Featured Brand cards (up to 30)',
  'Name, tagline, description, VoiceOver/TalkBack text, button title and https destination link',
  'Remote logo (light + optional dark) and product image, via new immutable image URLs',
  'Short free-text price ("From $49")',
  'A single whole-USD amount-off offer with code, terms, disclosure and start/expiry times',
  'Placement on the More screen and its subtitle (More follows catalog order)',
  'Sponsor card: copy, homepage/collection/configurator links, footnote, wheels (add with imageURL, edit, hide, reorder, remove)',
];

export const REQUIRES_APP_RELEASE = [
  { area: 'New card layout or kind', detail: 'A new `kind` (e.g. video, carousel of products, comparison) is skipped by v1 apps. It needs native SwiftUI work in iOS (and Compose in a future Android client), then a v1 optional addition or a catalog-v2.json.' },
  { area: 'A second sponsor / different sponsor layout', detail: 'Only one `rvp_wheels` entry is allowed and its id is reserved. Another sponsor needs a new kind and app code.' },
  { area: 'Badges and fixed copy', detail: '"Featured Brand", "Sponsor", "Sponsored by {name}", the empty state and "About Featured Brands" are app copy.' },
  { area: 'Colors, fonts, themes, per-brand styling', detail: 'Neutral theme styling is native. eFlexFuel orange and the RVP logo plate apply by stable ID only.' },
  { area: 'Bundled artwork for a new ID', detail: 'New bundled wheel/brand artwork needs an iOS release (and Android resources once Android supports the catalog). Until then, use remote imageURL / logo / heroImageURL.' },
  { area: 'Offer types', detail: 'Percent-off, non-USD, multiple offers per brand, or offers on the sponsor card are not in v1.' },
  { area: 'Independent More order or More-only cards', detail: 'More uses catalog order (sponsor banner first, then Featured Brands). A separate order or More-only entries need a contract and app change.' },
  { area: 'Sections, categories, filtering, search, personalization or per-region targeting', detail: 'Not in v1. Every device receives the same document.' },
  { area: 'Rich text, HTML, Markdown, emoji styling, video, animated images', detail: 'All copy is plain text. Images are PNG/JPEG/HEIF only.' },
  { area: 'Wheel ring with other than nine wheels', detail: 'The ring is designed for exactly nine. Other counts use the labeled grid automatically.' },
  { area: 'Links into the app or non-https links', detail: 'Destinations must be https; e85blends://, http, mailto and javascript are rejected.' },
  { area: 'Analytics/click tracking parameters', detail: 'Allowed inside an https URL, but any new in-app tracking is app work and a privacy review.' },
];

const KNOWN_BRAND_KEYS = new Set(['id', 'kind', 'name', 'tagline', 'description', 'accessibilityDescription', 'ctaTitle',
  'destinationURL', 'hidden', 'more', 'logo', 'heroImageURL', 'priceText', 'offer']);
const KNOWN_SPONSOR_KEYS = new Set(['id', 'kind', 'name', 'tagline', 'description', 'accessibilityDescription', 'ctaTitle',
  'destinationURL', 'hidden', 'more', 'homepageURL', 'configuratorURL', 'footnote', 'wheels']);

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

/** Notes about a candidate that the validator accepts but that an editor may not expect. */
export function appBehaviourNotes(catalog) {
  const notes = [];
  for (const [index, brand] of (catalog?.brands ?? []).entries()) {
    const at = `brands[${index}]`;
    const name = brand.name || brand.id;
    if (!KNOWN_KINDS.has(brand.kind)) {
      notes.push({ path: at, level: 'app-change', message: `${name}: kind "${brand.kind}" needs an app release; current apps skip it.` });
      continue;
    }
    const known = brand.kind === 'brand' ? KNOWN_BRAND_KEYS : KNOWN_SPONSOR_KEYS;
    for (const key of Object.keys(brand)) {
      if (!known.has(key)) notes.push({ path: `${at}.${key}`, level: 'app-change', message: `${name}: "${key}" is not part of v1. Apps ignore it.` });
    }
    if (brand.kind === 'brand') {
      if (BUNDLED_BRAND_IDS.has(brand.id)) notes.push({ path: `${at}.id`, level: 'info', message: `${name}: id "${brand.id}" gets bundled artwork and styling in the apps; the preview cannot show them.` });
      if (!brand.heroImageURL) notes.push({ path: `${at}.heroImageURL`, level: 'info', message: `${name}: no product image, so the card has no artwork panel.` });
      if (brand.logo && !brand.logo.darkURL) notes.push({ path: `${at}.logo.darkURL`, level: 'info', message: `${name}: no dark logo; the light logo is used in dark and OLED themes. Check legibility on near-black.` });
      if (brand.offer && brand.offer.expiresAt == null) notes.push({ path: `${at}.offer.expiresAt`, level: 'warning', message: `${name}: offer has no expiry. Offline devices keep showing it until they refresh; set expiresAt.` });
    }
    if (brand.kind === 'rvp_wheels') {
      const visible = (brand.wheels ?? []).filter((w) => w.hidden !== true);
      if (visible.length !== RING_WHEEL_COUNT) {
        notes.push({ path: `${at}.wheels`, level: 'info', message: `${visible.length} visible wheels: the ring is replaced by the labeled grid (configurator first).` });
      }
      const lower = String(brand.description ?? '').toLowerCase();
      const stated = NUMBER_WORDS.findIndex((w) => new RegExp(`\\b${w}\\b`).test(lower));
      if (stated >= 0 && stated !== visible.length) {
        notes.push({ path: `${at}.description`, level: 'warning', message: `Description says "${NUMBER_WORDS[stated]}" but ${visible.length} wheels are visible. Update the copy.` });
      }
      for (const [w, wheel] of (brand.wheels ?? []).entries()) {
        if (!BUNDLED_WHEEL_IDS.has(wheel.id) && wheel.imageURL) notes.push({ path: `${at}.wheels[${w}].imageURL`, level: 'info', message: `Wheel ${wheel.id}: remote image only (no bundled artwork for this id).` });
      }
      if (brand.id !== RVP_SPONSOR_ID) notes.push({ path: `${at}.id`, level: 'app-change', message: 'The sponsor layout is bound to the reserved RVP Supply id.' });
    }
  }
  return notes;
}
