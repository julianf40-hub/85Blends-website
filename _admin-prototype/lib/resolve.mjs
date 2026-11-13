// What each app screen shows for a catalog at a moment in time. Mirrors GearCatalog.content(at:)
// in the iOS app (EightyFiveBlends/GearCatalog.swift) and the Android requirements in
// docs/remote-gear/README.md. Used by the preview and by the change summary. It never invents
// layout: anything not listed here is fixed native app UI.

import { BUNDLED_WHEEL_IDS } from './validator.mjs';

export const RING_WHEEL_COUNT = 9;

export function activeOffer(offer, nowSeconds) {
  if (!offer) return null;
  if (offer.startsAt != null && nowSeconds < offer.startsAt) return null;
  if (offer.expiresAt != null && nowSeconds >= offer.expiresAt) return null;
  return offer;
}

/**
 * @param {object|null} catalog a v1 document (or null: never published)
 * @param {number} nowSeconds device clock, UTC seconds
 */
export function resolveContent(catalog, nowSeconds) {
  const result = { pages: [], skipped: [], hidden: [], moreSponsor: null, moreFeaturedBrands: [], wheels: [] };
  if (!catalog || !Array.isArray(catalog.brands)) return result;
  for (const item of catalog.brands) {
    if (item.kind !== 'brand' && item.kind !== 'rvp_wheels') {
      result.skipped.push(item);
      continue;
    }
    if (item.hidden === true) {
      result.hidden.push(item);
      continue;
    }
    if (item.kind === 'brand') {
      const page = {
        type: 'brand', badge: 'Featured Brand', id: item.id, name: item.name, tagline: item.tagline,
        description: item.description, ctaTitle: item.ctaTitle, destinationURL: item.destinationURL,
        accessibilityDescription: item.accessibilityDescription ?? item.description,
        logo: item.logo ?? null, heroImageURL: item.heroImageURL ?? null, priceText: item.priceText ?? null,
        offer: activeOffer(item.offer, nowSeconds), offerScheduled: !!item.offer && !activeOffer(item.offer, nowSeconds),
        bundledStyling: item.id === 'eflexfuel',
      };
      result.pages.push(page);
      if (item.more != null) result.moreFeaturedBrands.push({ ...page, subtitle: item.more.subtitle ?? item.tagline });
    } else {
      const wheels = (item.wheels ?? []).filter((w) => w.hidden !== true).map((w) => ({
        ...w, bundledArtwork: BUNDLED_WHEEL_IDS.has(w.id) ? w.id : null,
      }));
      result.wheels = wheels;
      result.pages.push({
        type: 'sponsor', badge: 'Sponsor', id: item.id, name: item.name, tagline: item.tagline,
        description: item.description, ctaTitle: item.ctaTitle, destinationURL: item.destinationURL,
        accessibilityDescription: item.accessibilityDescription ?? item.description,
        configuratorURL: item.configuratorURL, homepageURL: item.homepageURL,
        footnote: item.footnote ?? null, wheels,
      });
      if (item.more != null) {
        result.moreSponsor = {
          id: item.id, title: `Sponsored by ${item.name}`, subtitle: item.more.subtitle ?? item.tagline,
          homepageURL: item.homepageURL,
        };
      }
    }
  }
  return result;
}

/** Ring only for exactly nine visible wheels, standard text sizes and a wide enough card. */
export function wheelLayout(visibleWheelCount, { largeText, narrow }) {
  if (visibleWheelCount !== RING_WHEEL_COUNT) return { kind: 'grid', reason: `${visibleWheelCount} visible wheels (the ring is designed for exactly ${RING_WHEEL_COUNT})` };
  if (largeText) return { kind: 'grid', reason: 'accessibility text sizes use the labeled grid' };
  if (narrow) return { kind: 'grid', reason: 'narrow card uses the labeled grid' };
  return { kind: 'ring', reason: 'nine wheels on the ring around the configurator' };
}

/** Next offer start/expiry after now (the app wakes exactly then). */
export function nextOfferTransition(catalog, nowSeconds) {
  const moments = (catalog?.brands ?? [])
    .filter((b) => b.hidden !== true && b.offer)
    .flatMap((b) => [b.offer.startsAt, b.offer.expiresAt])
    .filter((t) => typeof t === 'number' && t > nowSeconds);
  return moments.length ? Math.min(...moments) : null;
}
