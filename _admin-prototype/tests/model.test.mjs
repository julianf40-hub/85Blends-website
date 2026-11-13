import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { diffCatalogs, summarize } from '../lib/diff.mjs';
import { resolveContent, wheelLayout, nextOfferTransition } from '../lib/resolve.mjs';
import { appBehaviourNotes } from '../lib/capabilities.mjs';
import { imageReferences, storageImageKey, previewSource } from '../lib/images.mjs';

const live = JSON.parse(readFileSync(new URL('../data/fictional-live-production.json', import.meta.url)));
const draft = JSON.parse(readFileSync(new URL('../data/fictional-draft.json', import.meta.url))).catalog;

test('diff: additions, edits and wheels', () => {
  const d = diffCatalogs(live, draft);
  assert.equal(d.counts.added, 2);
  assert.equal(d.counts.edited, 2);
  assert.equal(d.reordered, false); // inserting above existing cards keeps their relative order
  const tools = d.entries.find((x) => x.id === 'example-fuel-tools');
  assert.ok(tools.fields.some((f) => f.path === 'priceText' && f.before === 'From $49' && f.after === 'From $39'));
  assert.ok(tools.fields.some((f) => f.path === 'offer.code'));
  const sponsor = d.entries.find((x) => x.id === 'rvp-supply-oem-beadlocks');
  assert.equal(sponsor.wheels.entries.find((w) => w.id === 'sample-custom-wheel').change, 'added');
  assert.match(summarize(d), /2 added, 2 edited/);
});

test('diff: removal, visibility and no-op', () => {
  assert.equal(diffCatalogs(live, live).changed, false);
  const hidden = structuredClone(live);
  hidden.brands[0].hidden = true;
  const d = diffCatalogs(live, hidden);
  assert.equal(d.entries[0].visibility, 'hidden');
  assert.equal(d.visibility.after, 1);
  const removed = diffCatalogs(live, { brands: [live.brands[1]] });
  assert.equal(removed.counts.removed, 1);
  assert.ok(diffCatalogs(null, live).firstPublication);
});

test('diff: pure reorder is reported as moved', () => {
  const d = diffCatalogs(live, { brands: [...live.brands].reverse() });
  assert.equal(d.counts.moved, 2);
  assert.match(summarize(d), /reordered/);
});

test('resolve mirrors GearCatalog.content(at:)', () => {
  const c = resolveContent({ brands: [...draft.brands, { id: 'future', kind: 'video_card' }] }, 1_800_000_000);
  assert.deepEqual(c.pages.map((p) => p.id), ['northwind-sensors', 'example-fuel-tools', 'rvp-supply-oem-beadlocks']);
  assert.deepEqual(c.hidden.map((b) => b.id), ['harbor-garage-supply']);
  assert.deepEqual(c.skipped.map((b) => b.id), ['future']);
  assert.equal(c.moreSponsor.title, 'Sponsored by Sample Wheel Sponsor');
  assert.deepEqual(c.moreFeaturedBrands.map((b) => b.subtitle), ['Fictional ethanol content sensors', 'Prototype More card']);
  assert.equal(c.wheels.length, 9); // the hidden custom wheel is excluded
});

test('offer window: startsAt <= now < expiresAt', () => {
  const brand = draft.brands.find((b) => b.offer);
  const { startsAt, expiresAt } = brand.offer;
  const at = (t) => resolveContent({ brands: [brand] }, t).pages[0].offer;
  assert.equal(at(startsAt - 1), null);
  assert.ok(at(startsAt));
  assert.equal(at(expiresAt), null);
  assert.equal(nextOfferTransition({ brands: [brand] }, startsAt - 10), startsAt);
});

test('wheel layout: ring only for nine at standard size and width', () => {
  assert.equal(wheelLayout(9, {}).kind, 'ring');
  assert.equal(wheelLayout(8, {}).kind, 'grid');
  assert.equal(wheelLayout(9, { largeText: true }).kind, 'grid');
  assert.equal(wheelLayout(9, { narrow: true }).kind, 'grid');
});

test('app behaviour notes flag things that need an app release or surprise editors', () => {
  const notes = appBehaviourNotes({ brands: [{ id: 'x', kind: 'carousel', name: 'X' }, { ...live.brands[0], themeColor: '#f00' }] });
  assert.ok(notes.some((n) => n.level === 'app-change' && n.message.includes('kind "carousel"')));
  assert.ok(notes.some((n) => n.message.includes('"themeColor" is not part of v1')));
  const eight = structuredClone(live.brands[1]);
  eight.wheels[0].hidden = true;
  assert.ok(appBehaviourNotes({ brands: [eight] }).some((n) => n.message.includes('says "nine"')));
});

test('images: content-addressed storage naming', () => {
  const refs = imageReferences(draft);
  assert.ok(refs.length >= 4);
  for (const ref of refs) assert.ok(storageImageKey(ref.url), ref.url);
  assert.equal(previewSource('https://evil.example/x.png'), null);
  assert.equal(storageImageKey('https://storage.example.invalid/recommended-gear/images/a/../x.png'), null);
});
