// Web approximation of the two native screens a catalog drives. It renders only what the v1
// contract can change; everything else is labeled as fixed app UI. It is NOT the app's rendering:
// final checks happen on a TestFlight build pointed at the staging catalog.

import { resolveContent, wheelLayout } from '/lib/resolve.mjs';
import { previewSource } from '/lib/images.mjs';
import { escapeHTML as e } from './util.js';

function image(url, alt, className, fallbackLabel) {
  const src = previewSource(url);
  if (src) return `<img class="${className}" src="${src}" alt="${e(alt)}">`;
  return `<div class="${className} img-fallback" role="img" aria-label="${e(alt)}"><span>${e(fallbackLabel)}</span></div>`;
}

function logoMarkup(page, theme) {
  if (page.bundledStyling) return `<div class="pv-wordmark bundled">${e(page.name)}<small>bundled wordmark (in app)</small></div>`;
  if (page.logo?.url) {
    const url = theme === 'light' ? page.logo.url : page.logo.darkURL ?? page.logo.url;
    return image(url, `${page.name} logo`, 'pv-logo', 'remote logo (not loaded)');
  }
  return `<div class="pv-wordmark">${e(page.name)}</div>`;
}

function offerMarkup(offer) {
  return `<div class="pv-offer" aria-label="${e(`Save $${offer.amountOff} on ${offer.eligibleProducts}. Use code ${offer.code}.`)}">
    <div class="pv-offer-headline">$${e(offer.amountOff)} OFF</div>
    <div class="pv-offer-detail">Save $${e(offer.amountOff)} on ${e(offer.eligibleProducts)}.</div>
    <div class="pv-offer-row"><span class="pv-code">${e(offer.code)}</span><span class="pv-copy">Copy Code</span></div>
    <p class="pv-fine">${e(offer.terms)} ${e(offer.disclosure)}</p>
  </div>`;
}

function brandCard(page, opts) {
  return `<article class="pv-card" aria-label="${e(page.name)}">
    <div class="pv-card-head"><span class="pv-badge">${page.badge}</span>${logoMarkup(page, opts.theme)}</div>
    ${page.bundledStyling ? '<div class="pv-hero img-fallback"><span>bundled hero artwork (in app)</span></div>'
      : page.heroImageURL ? image(page.heroImageURL, `${page.name} product image`, 'pv-hero', 'remote product image (not loaded)') : ''}
    <h4 class="pv-name">${e(page.name)}</h4>
    <p class="pv-tagline">${e(page.tagline)}</p>
    <p class="pv-desc">${e(page.description)}</p>
    ${page.priceText ? `<p class="pv-price">${e(page.priceText)}</p>` : ''}
    ${page.offer ? offerMarkup(page.offer) : page.offerScheduled ? '<p class="pv-note">Offer not active at the preview time.</p>' : ''}
    <span class="pv-cta">${e(page.ctaTitle)} ↗</span>
  </article>`;
}

function wheelTile(wheel) {
  const art = wheel.imageURL ? image(wheel.imageURL, wheel.accessibilityName, 'pv-wheel-img', 'remote')
    : `<div class="pv-wheel-img img-fallback bundled" role="img" aria-label="${e(wheel.accessibilityName)}"><span>bundled</span></div>`;
  return `<span class="pv-wheel" title="${e(wheel.displayName)}">${art}<span class="pv-wheel-name">${e(wheel.displayName)}</span></span>`;
}

function sponsorCard(page, opts) {
  const layout = wheelLayout(page.wheels.length, opts);
  const wheels = layout.kind === 'ring'
    ? `<div class="pv-ring" aria-label="Wheel ring">${page.wheels.map((w, i) => `<span class="pv-ring-slot slot-${i}">${wheelTile(w)}</span>`).join('')}
         <span class="pv-ring-center">Custom Wheels</span></div>`
    : `<div class="pv-grid"><span class="pv-wheel config">Custom Wheels</span>${page.wheels.map(wheelTile).join('')}</div>`;
  return `<article class="pv-card sponsor" aria-label="${e(page.name)}">
    <div class="pv-card-head"><span class="pv-badge sponsor">${page.badge}</span><div class="pv-logo-plate">sponsor logo plate (bundled in app)</div></div>
    <h4 class="pv-name">${e(page.name)}</h4>
    <p class="pv-tagline">${e(page.tagline)}</p>
    <p class="pv-desc">${e(page.description)}</p>
    ${wheels}
    <p class="pv-note">Layout: ${e(layout.kind)} — ${e(layout.reason)}</p>
    ${page.footnote ? `<p class="pv-pill">${e(page.footnote)}</p>` : ''}
    <span class="pv-cta">${e(page.ctaTitle)} ↗</span>
  </article>`;
}

function stagingBanner(isStaging) {
  return isStaging ? '<div class="pv-staging">STAGING CATALOG · Test preview</div>' : '';
}

export function renderPreview(catalog, opts) {
  const content = resolveContent(catalog, opts.nowSeconds);
  const frame = `pv-phone theme-${opts.theme}${opts.narrow ? ' narrow' : ''}${opts.largeText ? ' large' : ''}`;
  const pages = content.pages.map((p) => (p.type === 'sponsor' ? sponsorCard(p, opts) : brandCard(p, opts))).join('');
  const gear = `<div class="${frame}" role="region" aria-label="Recommended Gear preview">
    <div class="pv-screen">
      ${stagingBanner(opts.isStaging)}
      <p class="pv-eyebrow">GEAR</p><h3 class="pv-title">Recommended Gear</h3>
      <p class="pv-sub fixed">Tools and products for getting more from your E85 experience.</p>
      <h4 class="pv-section">Featured Brands</h4>
      ${content.pages.length ? `<div class="pv-carousel">${pages}</div>
        <div class="pv-dots" aria-hidden="true">${content.pages.map((_, i) => `<i class="${i === 0 ? 'on' : ''}"></i>`).join('')}</div>`
        : '<p class="pv-empty fixed">No featured brands are available right now. Check back soon.</p>'}
      <p class="pv-fixed-block fixed"><strong>About Featured Brands</strong><br>Featured brands open their own websites. Check product compatibility with the manufacturer before installation.</p>
    </div></div>`;
  const moreCards = content.moreFeaturedBrands.map((b) => `<div class="pv-more-card">
      <div class="pv-more-head">${logoMarkup(b, opts.theme)}<span class="pv-badge">Featured Brand</span></div>
      <p class="pv-more-sub">${e(b.subtitle)}</p></div>`).join('');
  const more = `<div class="${frame}" role="region" aria-label="More screen preview">
    <div class="pv-screen">
      ${stagingBanner(opts.isStaging)}
      <p class="pv-eyebrow fixed">SETTINGS &amp; SUPPORT</p><h3 class="pv-title">More</h3>
      ${content.moreSponsor ? `<div class="pv-more-sponsor"><div class="pv-logo-plate small">logo (bundled)</div>
        <div><strong class="fixed-copy">${e(content.moreSponsor.title)}</strong><p>${e(content.moreSponsor.subtitle)}</p></div></div>` : ''}
      ${moreCards}
      ${!content.moreSponsor && !moreCards ? '<p class="pv-note">No catalog placements on More.</p>' : ''}
      <div class="pv-fixed-rows fixed" aria-hidden="true"><span>Preferences</span><span>Support</span><span>About</span></div>
    </div></div>`;
  const notes = [];
  if (content.hidden.length) notes.push(`Hidden (in document, shown nowhere): ${content.hidden.map((b) => b.name || b.id).join(', ')}`);
  if (content.skipped.length) notes.push(`Skipped by v1 apps (unknown kind): ${content.skipped.map((b) => b.id).join(', ')}`);
  return { html: `<div class="pv-pair">${gear}${more}</div>`, notes, content };
}
