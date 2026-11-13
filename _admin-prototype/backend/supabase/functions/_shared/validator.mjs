// Recommended Gear catalog v1 validator: a JavaScript port of the reference validator
// tools/remote-gear/validate_catalog.py in julianf40-hub/E85-Blends-App (ported from main e6c42ed).
//
// One module runs in the browser (instant feedback), in the local prototype server (authoritative)
// and, unchanged, in a Deno/Supabase Edge Function later. It must accept and reject exactly what
// the Python reference and the iOS client accept and reject; tools/parity.mjs checks that.
//
// Differences from the Python module are only in shape, not in rules:
//   - issues are COLLECTED with a JSON path (so the editor can highlight every field) instead of
//     raising on the first one; `assertPublishable` throws the first error like `validate`.
//   - the editor never writes `100.0` style numbers (JSON.stringify emits integers), so Python's
//     int-vs-float distinction for `amountOff`/`schemaVersion` cannot diverge on bytes we produce.

export const SUPPORTED_SCHEMA_VERSION = 1;
export const MAXIMUM_BYTES = 512_000;
export const RVP_SPONSOR_ID = 'rvp-supply-oem-beadlocks';

// Wheel IDs with bundled artwork on BOTH clients. Adding one needs an app release on iOS AND Android.
export const BUNDLED_WHEEL_IDS = new Set([
  'oem-hellcat', 'oem-hellcat-v2', 'oem-hellcat-redeye', '5-spoke-hellcat', '5-spoke-hellcat-v2',
  'oem-demon', 'hollow-5-spoke', 'chrome-oem-hellcat', 'oem-widebody',
]);

// Brand IDs whose artwork and styling are bundled in the apps (chosen by ID, never by JSON).
export const BUNDLED_BRAND_IDS = new Set(['eflexfuel', RVP_SPONSOR_ID]);

export const KNOWN_KINDS = new Set(['brand', 'rvp_wheels']);

export const LIMITS = Object.freeze({
  brands: 30, wheels: 24, id: 64, revision: 200, name: 60, tagline: 120,
  description: 500, ctaTitle: 60, accessibilityText: 500, priceText: 60,
  subtitle: 120, footnote: 160, offerCode: 40, offerText: 300, maximumAmountOff: 10_000,
});

export const NEUTRAL_BANNED = ['sponsor', 'partner', 'affiliate', 'endorse'];
export const DASHBOARD_WARN = [
  'official', 'exclusive', 'guarantee', 'universal', 'fits all', 'all vehicles', 'horsepower',
  'racing', 'fastest', 'strongest', '85blends', 'authorized', 'trusted', 'preferred', 'powered by',
];

export const ID_PATTERN = /^[a-z0-9-]{1,64}$/;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isString = (v) => typeof v === 'string';
const present = (v) => v !== undefined && v !== null;
// Python truthiness, for `x or default` expressions in the reference.
const pyTruthy = (v) => !(v === undefined || v === null || v === false || v === 0 || v === ''
  || (Array.isArray(v) && v.length === 0) || (isPlainObject(v) && Object.keys(v).length === 0));
const hasWhitespace = (s) => /\s/u.test(s);
// Python len() counts code points; so does spreading a string.
export const charCount = (s) => [...s].length;

export function secureURL(value) {
  if (!isString(value) || hasWhitespace(value)) return false;
  // Mirrors urllib.parse.urlsplit: scheme "https" (any case), then "//" netloc.
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/.exec(value);
  if (!match || match[1].toLowerCase() !== 'https') return false;
  const netloc = match[2];
  if (netloc.includes('@')) return false; // any userinfo, even empty, is a credential
  let host = netloc;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end < 0) return false; // urlsplit raises "Invalid IPv6 URL"
    host = host.slice(1, end);
  } else if (host.includes(']')) {
    return false;
  } else {
    const colon = host.indexOf(':');
    if (colon >= 0) host = host.slice(0, colon);
  }
  return host.length > 0;
}

export function text(value, limit) {
  return isString(value) && value.trim() !== '' && charCount(value) <= limit;
}

export function timestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

const optional = (obj, key, check) => !present(obj[key]) || check(obj[key]);

/**
 * Collects every issue in a document.
 * @returns {{errors: Issue[], warnings: Issue[], unsupported: boolean}}
 * @typedef {{path: string, message: string}} Issue
 */
export function collectIssues(document) {
  const errors = [];
  const warnings = [];
  const err = (path, message) => errors.push({ path, message });
  const warn = (path, message) => warnings.push({ path, message });

  if (!isPlainObject(document)) {
    err('', 'not a catalog document');
    return { errors, warnings, unsupported: false };
  }
  const version = document.schemaVersion;
  if (!Number.isInteger(version)) {
    err('schemaVersion', 'schemaVersion must be an integer');
    return { errors, warnings, unsupported: false };
  }
  if (version !== SUPPORTED_SCHEMA_VERSION) {
    err('schemaVersion', `schemaVersion ${version} is not readable by v1 clients`);
    return { errors, warnings, unsupported: true };
  }
  if (!text(document.revision, LIMITS.revision)) err('revision', 'revision missing or too long');
  if (!timestamp(document.publishedAt)) err('publishedAt', 'publishedAt must be positive UTC Unix seconds');
  const brands = document.brands;
  if (!Array.isArray(brands)) {
    err('brands', 'brands must be an array');
    return { errors, warnings, unsupported: false };
  }
  if (brands.length > LIMITS.brands) err('brands', `at most ${LIMITS.brands} brands`);

  const seen = new Map();
  let sponsors = 0;
  brands.forEach((entry, index) => {
    const at = `brands[${index}]`;
    if (!isPlainObject(entry) || !isString(entry.kind)) {
      err(at, 'every brand needs a kind');
      return;
    }
    const bid = entry.id;
    if (!(isString(bid) && ID_PATTERN.test(bid))) {
      err(`${at}.id`, `brand id ${JSON.stringify(bid)} must be 1-64 lowercase letters, digits or hyphens`);
    } else if (seen.has(bid)) {
      err(`${at}.id`, `duplicate brand id "${bid}" (also brands[${seen.get(bid)}])`);
    } else {
      seen.set(bid, index);
    }
    const label = isString(bid) ? bid : at;
    if (entry.kind === 'brand') {
      validateNeutral(entry, at, label, err);
      const blob = ['name', 'tagline', 'description', 'ctaTitle'].map((k) => String(entry[k] ?? '')).join(' ').toLowerCase();
      for (const w of DASHBOARD_WARN) if (blob.includes(w)) warn(at, `${label}: review wording '${w}'`);
    } else if (entry.kind === 'rvp_wheels') {
      sponsors += 1;
      validateSponsor(entry, at, err);
    } else {
      warn(at, `${label}: kind '${entry.kind}' is unknown to v1 clients and will be skipped`);
    }
  });
  if (sponsors > 1) err('brands', 'more than one rvp_wheels entry');
  return { errors, warnings, unsupported: false };
}

function validateShared(brand, at, bid, err) {
  const fields = [['name', LIMITS.name], ['tagline', LIMITS.tagline], ['description', LIMITS.description], ['ctaTitle', LIMITS.ctaTitle]];
  for (const [key, limit] of fields) {
    if (!text(brand[key], limit)) err(`${at}.${key}`, `${bid}: ${key} is required, 1-${limit} characters`);
  }
  if (!optional(brand, 'accessibilityDescription', (v) => text(v, LIMITS.accessibilityText))) {
    err(`${at}.accessibilityDescription`, `${bid}: accessibilityDescription must be 1-${LIMITS.accessibilityText} characters`);
  }
  const more = brand.more;
  if (present(more)) {
    if (!isPlainObject(more)) err(`${at}.more`, `${bid}: more must be an object`);
    else if (!optional(more, 'subtitle', (v) => text(v, LIMITS.subtitle))) {
      err(`${at}.more.subtitle`, `${bid}: More subtitle must be 1-${LIMITS.subtitle} characters`);
    }
  }
  if (!secureURL(brand.destinationURL)) err(`${at}.destinationURL`, `${bid}: destinationURL must be https`);
  if (!optional(brand, 'hidden', (v) => typeof v === 'boolean')) err(`${at}.hidden`, `${bid}: hidden must be a boolean`);
}

function validateNeutral(brand, at, bid, err) {
  validateShared(brand, at, bid, err);
  if (brand.id === RVP_SPONSOR_ID) err(`${at}.id`, 'the RVP Supply id is reserved for rvp_wheels');
  for (const key of ['homepageURL', 'configuratorURL', 'footnote', 'wheels']) {
    if (present(brand[key])) err(`${at}.${key}`, `${bid}: ${key} is only allowed on rvp_wheels`);
  }
  const copyKeys = ['name', 'tagline', 'description', 'ctaTitle', 'accessibilityDescription'];
  let copy = copyKeys.map((k) => String(pyTruthy(brand[k]) ? brand[k] : '')).join(' ');
  const more = pyTruthy(brand.more) ? brand.more : {};
  copy += ' ' + String(isPlainObject(more) && pyTruthy(more.subtitle) ? more.subtitle : '');
  for (const word of NEUTRAL_BANNED) {
    if (copy.toLowerCase().includes(word)) err(at, `${bid}: neutral brand copy may not say '${word}'`);
  }
  if (!optional(brand, 'heroImageURL', secureURL)) err(`${at}.heroImageURL`, `${bid}: heroImageURL must be https`);
  const logo = brand.logo;
  if (present(logo) && !(isPlainObject(logo) && secureURL(logo.url) && optional(logo, 'darkURL', secureURL))) {
    err(`${at}.logo`, `${bid}: logo needs an https url (and an https darkURL if set)`);
  }
  if (!optional(brand, 'priceText', (v) => text(v, LIMITS.priceText))) err(`${at}.priceText`, `${bid}: priceText must be 1-${LIMITS.priceText} characters`);
  const offer = brand.offer;
  if (present(offer)) {
    const o = isPlainObject(offer) ? offer : {};
    const amount = o.amountOff;
    if (!(Number.isInteger(amount) && amount >= 1 && amount <= LIMITS.maximumAmountOff)) {
      err(`${at}.offer.amountOff`, `${bid}: offer.amountOff must be a whole number 1-${LIMITS.maximumAmountOff}`);
    }
    if (!(text(o.code, LIMITS.offerCode) && !hasWhitespace(o.code))) err(`${at}.offer.code`, `${bid}: offer.code must be 1-${LIMITS.offerCode} characters with no spaces`);
    for (const key of ['eligibleProducts', 'terms', 'disclosure']) {
      if (!text(o[key], LIMITS.offerText)) err(`${at}.offer.${key}`, `${bid}: offer.${key} is required, 1-${LIMITS.offerText} characters`);
    }
    const okStart = optional(o, 'startsAt', timestamp);
    const okEnd = optional(o, 'expiresAt', timestamp);
    if (!okStart) err(`${at}.offer.startsAt`, `${bid}: offer timestamps must be positive UTC Unix seconds`);
    if (!okEnd) err(`${at}.offer.expiresAt`, `${bid}: offer timestamps must be positive UTC Unix seconds`);
    if (okStart && okEnd && present(o.startsAt) && present(o.expiresAt) && o.startsAt >= o.expiresAt) {
      err(`${at}.offer.expiresAt`, `${bid}: offer.startsAt must be before expiresAt`);
    }
  }
}

function validateSponsor(brand, at, err) {
  const bid = isString(brand.id) ? brand.id : at;
  validateShared(brand, at, bid, err);
  if (brand.id !== RVP_SPONSOR_ID) err(`${at}.id`, 'rvp_wheels is reserved for RVP Supply');
  for (const key of ['offer', 'priceText', 'heroImageURL', 'logo']) {
    if (present(brand[key])) err(`${at}.${key}`, `rvp_wheels may not carry ${key}`);
  }
  if (!secureURL(brand.homepageURL)) err(`${at}.homepageURL`, 'rvp_wheels needs an https homepageURL');
  if (!secureURL(brand.configuratorURL)) err(`${at}.configuratorURL`, 'rvp_wheels needs an https configuratorURL');
  if (!optional(brand, 'footnote', (v) => text(v, LIMITS.footnote))) err(`${at}.footnote`, `footnote must be 1-${LIMITS.footnote} characters`);
  const wheels = pyTruthy(brand.wheels) ? brand.wheels : [];
  if (!Array.isArray(wheels)) {
    err(`${at}.wheels`, 'wheels must be an array');
    return;
  }
  if (wheels.length > LIMITS.wheels) err(`${at}.wheels`, `at most ${LIMITS.wheels} wheels`);
  const ids = new Map();
  wheels.forEach((wheel, index) => {
    const wat = `${at}.wheels[${index}]`;
    const wid = isPlainObject(wheel) ? wheel.id : undefined;
    if (!(isString(wid) && ID_PATTERN.test(wid))) {
      err(`${wat}.id`, 'wheel ids must be unique lowercase [a-z0-9-]');
      return;
    }
    if (ids.has(wid)) err(`${wat}.id`, `duplicate wheel id "${wid}"`);
    ids.set(wid, index);
    if (!text(wheel.displayName, LIMITS.name)) err(`${wat}.displayName`, `wheel ${wid}: displayName is required, 1-${LIMITS.name} characters`);
    if (!text(wheel.accessibilityName, LIMITS.accessibilityText)) err(`${wat}.accessibilityName`, `wheel ${wid}: accessibilityName is required`);
    if (!secureURL(wheel.productURL)) err(`${wat}.productURL`, `wheel ${wid}: productURL must be https`);
    if (!optional(wheel, 'imageURL', secureURL)) err(`${wat}.imageURL`, `wheel ${wid}: imageURL must be https`);
    if (!optional(wheel, 'hidden', (v) => typeof v === 'boolean')) err(`${wat}.hidden`, `wheel ${wid}: hidden must be a boolean`);
    if (!present(wheel.imageURL) && !BUNDLED_WHEEL_IDS.has(wid)) {
      err(`${wat}.imageURL`, `wheel ${wid}: needs imageURL (no bundled artwork for this id)`);
    }
  });
}

export class CatalogRejected extends Error {
  constructor(message, { unsupported = false } = {}) {
    super(message);
    this.name = 'CatalogRejected';
    this.unsupported = unsupported;
  }
}

/** Throws CatalogRejected on the first error; returns warning messages. Same contract as validate(). */
export function assertPublishable(document) {
  const result = collectIssues(document);
  if (result.errors.length) throw new CatalogRejected(result.errors[0].message, { unsupported: result.unsupported });
  return result.warnings.map((w) => w.message);
}

/** Mirrors validate_bytes: size limit on the raw bytes, strict UTF-8, JSON. */
export function parseBytes(raw) {
  if (raw.length > MAXIMUM_BYTES) throw new CatalogRejected(`document is ${raw.length} bytes; limit ${MAXIMUM_BYTES}`);
  let document;
  try {
    const textValue = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
    document = JSON.parse(textValue);
  } catch (error) {
    throw new CatalogRejected(`not JSON: ${error.message}`);
  }
  return { document, warnings: assertPublishable(document) };
}

const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * Ordering rules identical to GearCatalogStore.accept on the devices (check_successor).
 * @returns {'unchanged'|'newer'}
 */
export function checkSuccessor(live, liveBytes, candidate, candidateBytes, usedRevisions = []) {
  if (sameBytes(candidateBytes, liveBytes)) return 'unchanged';
  if (candidate.publishedAt < live.publishedAt) {
    throw new CatalogRejected('publishedAt is older than the live publication; devices would ignore it');
  }
  if (candidate.publishedAt === live.publishedAt) {
    throw new CatalogRejected('publishedAt equals the live publication but the content differs; publishedAt must strictly increase');
  }
  const used = new Set([...usedRevisions, live.revision]);
  if (used.has(candidate.revision)) {
    throw new CatalogRejected('revision was already used; every publication, including a rollback, needs a new one');
  }
  return 'newer';
}

/** Exactly the bytes the publisher writes (same layout as publish_catalog.encode). */
export function encodeCatalog(document) {
  return new TextEncoder().encode(JSON.stringify(document, null, 2) + '\n');
}
