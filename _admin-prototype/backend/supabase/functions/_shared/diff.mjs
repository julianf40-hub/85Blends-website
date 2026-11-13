// Before/after change summary between two catalogs (live publication → candidate draft).
// Pure and deterministic so the browser and the server produce the same summary, and the server
// can record it in publication history.

const FIELD_LABELS = {
  name: 'Name', tagline: 'Tagline', description: 'Description', accessibilityDescription: 'VoiceOver/TalkBack text',
  ctaTitle: 'Button title', destinationURL: 'Destination link', hidden: 'Hidden', 'more': 'More placement',
  'more.subtitle': 'More subtitle', 'logo.url': 'Logo', 'logo.darkURL': 'Logo (dark)', heroImageURL: 'Product image',
  priceText: 'Price text', offer: 'Offer', 'offer.amountOff': 'Offer amount (USD)', 'offer.eligibleProducts': 'Offer eligible products',
  'offer.code': 'Offer code', 'offer.terms': 'Offer terms', 'offer.disclosure': 'Offer disclosure',
  'offer.startsAt': 'Offer starts', 'offer.expiresAt': 'Offer expires', homepageURL: 'Homepage (More banner)',
  configuratorURL: 'Configurator link', footnote: 'Footnote', kind: 'Kind',
};
const WHEEL_LABELS = { displayName: 'Name', accessibilityName: 'Accessibility name', productURL: 'Product link', imageURL: 'Image', hidden: 'Hidden' };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function flatten(value, prefix = '', out = {}) {
  for (const [key, v] of Object.entries(value ?? {})) {
    if (key === 'id' || key === 'wheels') continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (isObj(v) && Object.keys(v).length) flatten(v, path, out);
    else out[path] = v;
  }
  return out;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function fieldChanges(before, after, labels) {
  const a = flatten(before);
  const b = flatten(after);
  const changes = [];
  for (const path of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!same(a[path], b[path])) changes.push({ path, label: labels[path] ?? path, before: a[path], after: b[path] });
  }
  // presence of `more`/`offer` objects themselves (e.g. `more: {}` added) is meaningful.
  for (const key of ['more', 'offer', 'logo']) {
    if ((before?.[key] == null) !== (after?.[key] == null) && !changes.some((c) => c.path.startsWith(key))) {
      changes.push({ path: key, label: labels[key] ?? key, before: before?.[key] == null ? undefined : 'present', after: after?.[key] == null ? undefined : 'present' });
    }
  }
  return changes.sort((x, y) => x.path.localeCompare(y.path));
}

function listDiff(beforeList, afterList, labels) {
  const beforeById = new Map(beforeList.map((x, i) => [x.id, { item: x, index: i }]));
  const afterById = new Map(afterList.map((x, i) => [x.id, { item: x, index: i }]));
  const entries = [];
  for (const [id, { item, index }] of afterById) {
    const prior = beforeById.get(id);
    if (!prior) { entries.push({ id, change: 'added', name: item.name ?? item.displayName, to: index, item }); continue; }
    const fields = fieldChanges(prior.item, item, labels);
    const visibility = (prior.item.hidden === true) !== (item.hidden === true) ? (item.hidden === true ? 'hidden' : 'shown') : null;
    entries.push({ id, change: fields.length ? 'edited' : 'unchanged', name: item.name ?? item.displayName, from: prior.index, to: index, fields, visibility, priorItem: prior.item, item });
  }
  for (const [id, { item, index }] of beforeById) {
    if (!afterById.has(id)) entries.push({ id, change: 'removed', name: item.name ?? item.displayName, from: index, item });
  }
  // Reorder = relative order of the items present in both lists changed.
  const commonBefore = beforeList.filter((x) => afterById.has(x.id)).map((x) => x.id);
  const commonAfter = afterList.filter((x) => beforeById.has(x.id)).map((x) => x.id);
  const reordered = !same(commonBefore, commonAfter);
  for (const e of entries) {
    if (e.from != null && e.to != null && reordered) e.moved = commonBefore.indexOf(e.id) !== commonAfter.indexOf(e.id);
  }
  return { entries, reordered, beforeOrder: beforeList.map((x) => x.id), afterOrder: afterList.map((x) => x.id) };
}

/**
 * @param {object|null} before live catalog (null = nothing published yet)
 * @param {object} after candidate catalog
 */
export function diffCatalogs(before, after) {
  const beforeBrands = before?.brands ?? [];
  const afterBrands = after?.brands ?? [];
  const brands = listDiff(beforeBrands, afterBrands, FIELD_LABELS);
  for (const entry of brands.entries) {
    const priorWheels = entry.priorItem?.wheels ?? (entry.change === 'removed' ? entry.item.wheels : []) ?? [];
    const nextWheels = entry.change === 'removed' ? [] : entry.item?.wheels ?? [];
    if (priorWheels.length || nextWheels.length) {
      const wheels = listDiff(priorWheels, nextWheels, WHEEL_LABELS);
      if (wheels.reordered || wheels.entries.some((w) => w.change !== 'unchanged')) {
        entry.wheels = wheels;
        if (entry.change === 'unchanged') entry.change = 'edited';
      }
    }
    if (entry.change === 'unchanged' && entry.moved) entry.change = 'moved';
    const placedBefore = entry.priorItem?.more != null && entry.priorItem?.hidden !== true;
    const placedAfter = entry.item?.more != null && entry.item?.hidden !== true && entry.change !== 'removed';
    entry.affectsMore = placedBefore || placedAfter;
  }
  const count = (c) => brands.entries.filter((e) => e.change === c).length;
  const visibleBefore = beforeBrands.filter((b) => b.hidden !== true).length;
  const visibleAfter = afterBrands.filter((b) => b.hidden !== true).length;
  const changed = brands.entries.some((e) => e.change !== 'unchanged') || brands.reordered;
  return {
    changed,
    firstPublication: before == null,
    counts: { added: count('added'), removed: count('removed'), edited: count('edited'), moved: count('moved') },
    visibility: { before: visibleBefore, after: visibleAfter },
    reordered: brands.reordered,
    beforeOrder: brands.beforeOrder,
    afterOrder: brands.afterOrder,
    entries: brands.entries.map(({ priorItem, item, ...rest }) => ({ ...rest, kind: (item ?? priorItem)?.kind })),
  };
}

/** One-line text summary for history and confirmations. */
export function summarize(diff) {
  if (!diff.changed) return 'No content changes';
  const parts = [];
  const { added, removed, edited } = diff.counts;
  if (added) parts.push(`${added} added`);
  if (removed) parts.push(`${removed} removed`);
  if (edited) parts.push(`${edited} edited`);
  const hidden = diff.entries.filter((e) => e.visibility === 'hidden').length;
  const shown = diff.entries.filter((e) => e.visibility === 'shown').length;
  if (hidden) parts.push(`${hidden} hidden`);
  if (shown) parts.push(`${shown} shown`);
  if (diff.reordered) parts.push('reordered');
  return `${parts.join(', ')} · ${diff.visibility.before} → ${diff.visibility.after} visible`;
}
