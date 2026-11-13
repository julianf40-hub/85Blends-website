// Port of tools/remote-gear/test_validate_catalog.py (E85-Blends-App, main e6c42ed) ValidatorTests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assertPublishable, parseBytes, checkSuccessor, CatalogRejected, RVP_SPONSOR_ID, MAXIMUM_BYTES, encodeCatalog, secureURL, collectIssues,
} from '../lib/validator.mjs';

const live = JSON.parse(readFileSync(new URL('../data/fictional-live-production.json', import.meta.url)));
const sponsorSeed = () => structuredClone(live.brands.find((b) => b.kind === 'rvp_wheels'));
const neutral = (o = {}) => ({ id: 'new-brand', kind: 'brand', name: 'New Brand', tagline: 'Tools', description: 'Product details', ctaTitle: 'View products', destinationURL: 'https://example.com/products', ...o });
const doc = (brands = [], o = {}) => ({ schemaVersion: 1, revision: 'r1', publishedAt: 1_800_000_000, brands, ...o });
const offer = { amountOff: 50, eligibleProducts: 'eligible kits', code: 'SAVE50', terms: 'Terms at checkout.', disclosure: 'We may earn a commission.' };
const rejected = (d) => assert.throws(() => assertPublishable(d), CatalogRejected);
const raw = (d) => new TextEncoder().encode(JSON.stringify(d));

test('fictional seeds are publishable', () => {
  parseBytes(readFileSync(new URL('../data/fictional-live-production.json', import.meta.url)));
  const draft = JSON.parse(readFileSync(new URL('../data/fictional-draft.json', import.meta.url)));
  assertPublishable(doc(draft.catalog.brands));
});

test('empty catalog is valid', () => assert.deepEqual(assertPublishable(doc()), []));

test('unsupported version', () => {
  assert.throws(() => assertPublishable(doc([], { schemaVersion: 2 })), (e) => e.unsupported === true);
});

test('unknown kind is skipped, not rejected', () => {
  assert.ok(assertPublishable(doc([{ id: 'future', kind: 'video_card' }])).some((w) => w.includes('unknown')));
});

test('duplicates and ids', () => {
  rejected(doc([neutral(), neutral()]));
  rejected(doc([neutral({ id: 'Bad ID' })]));
  rejected(doc([{ kind: 'video_card' }]));
});

test('unsafe urls', () => {
  for (const url of ['javascript:alert(1)', 'http://example.com', 'https://user:pw@example.com', 'e85blends://open', 'https://', 'https:example.com', 'https://@example.com', 'https://exa mple.com']) {
    rejected(doc([neutral({ destinationURL: url })]));
  }
  rejected(doc([neutral({ heroImageURL: 'http://cdn.example.com/a.png' })]));
  rejected(doc([neutral({ logo: { url: 'https://a.example/l.png', darkURL: 'ftp://x' } })]));
  assert.ok(secureURL('HTTPS://Example.com/path?q=1#x'));
  assert.ok(secureURL('https://example.com:8443'));
});

test('neutral brand cannot claim sponsorship or RVP identity', () => {
  rejected(doc([neutral({ tagline: 'Our official sponsor' })]));
  rejected(doc([neutral({ more: { subtitle: 'Partner gear' } })]));
  rejected(doc([neutral({ id: RVP_SPONSOR_ID })]));
  rejected(doc([neutral({ wheels: [] })]));
  const sponsor = sponsorSeed();
  sponsor.id = 'another-sponsor';
  rejected(doc([sponsor]));
});

test('sponsor cannot carry price, offer or remote branding', () => {
  for (const [key, value] of [['priceText', '$1'], ['logo', { url: 'https://a.example/l.png' }], ['heroImageURL', 'https://a.example/h.png'], ['offer', offer]]) {
    rejected(doc([{ ...sponsorSeed(), [key]: value }]));
  }
  rejected(doc([sponsorSeed(), sponsorSeed()]));
});

test('new wheel requires remote image', () => {
  const sponsor = sponsorSeed();
  sponsor.wheels.push({ id: 'new-wheel', displayName: 'New', accessibilityName: 'New wheel', productURL: 'https://example.com/products/new' });
  rejected(doc([sponsor]));
  sponsor.wheels.at(-1).imageURL = 'https://cdn.example.com/gear/new-wheel-v1.png';
  assertPublishable(doc([sponsor]));
});

test('offer rules', () => {
  assertPublishable(doc([neutral({ offer: { ...offer, startsAt: 1_800_000_000, expiresAt: 1_800_086_400 } })]));
  rejected(doc([neutral({ offer: { ...offer, startsAt: 5, expiresAt: 5 } })]));
  rejected(doc([neutral({ offer: { ...offer, amountOff: 0 } })]));
  rejected(doc([neutral({ offer: { ...offer, amountOff: 2.5 } })]));
  rejected(doc([neutral({ offer: { ...offer, code: 'TWO WORDS' } })]));
  rejected(doc([neutral({ offer: { ...offer, disclosure: ' ' } })]));
});

test('text limits (code points, like Python len)', () => {
  rejected(doc([neutral({ name: 'x'.repeat(61) })]));
  assertPublishable(doc([neutral({ name: '🚗'.repeat(60) })]));
  rejected(doc([neutral({ priceText: '' })]));
  rejected(doc([neutral({ hidden: 'yes' })]));
});

test('size limit and strict JSON', () => {
  assert.throws(() => parseBytes(new Uint8Array(MAXIMUM_BYTES + 1).fill(32)), CatalogRejected);
  assert.throws(() => parseBytes(new TextEncoder().encode('﻿{}')), CatalogRejected);
  assert.throws(() => parseBytes(new Uint8Array([0xff, 0xfe])), CatalogRejected);
});

test('successor rules', () => {
  const liveDoc = doc([], { revision: 'a', publishedAt: 200 });
  const newer = doc([], { revision: 'b', publishedAt: 201 });
  assert.equal(checkSuccessor(liveDoc, raw(liveDoc), liveDoc, raw(liveDoc)), 'unchanged');
  assert.equal(checkSuccessor(liveDoc, raw(liveDoc), newer, raw(newer)), 'newer');
  for (const c of [doc([], { revision: 'b', publishedAt: 200 }), doc([], { revision: 'b', publishedAt: 100 }), doc([neutral()], { revision: 'a', publishedAt: 300 })]) {
    assert.throws(() => checkSuccessor(liveDoc, raw(liveDoc), c, raw(c)), CatalogRejected);
  }
  const reused = doc([], { revision: 'old', publishedAt: 300 });
  assert.throws(() => checkSuccessor(liveDoc, raw(liveDoc), reused, raw(reused), ['old']), CatalogRejected);
});

test('withdrawal cannot be undone by older or equal timestamps', () => {
  const withdrawn = doc([], { revision: 'withdrawn', publishedAt: 2000 });
  for (const r of [doc([neutral()], { revision: 'with-brand', publishedAt: 1000 }), doc([neutral()], { revision: 'other', publishedAt: 2000 })]) {
    assert.throws(() => checkSuccessor(withdrawn, raw(withdrawn), r, raw(r), ['with-brand']), CatalogRejected);
  }
});

test('collectIssues reports every problem with a field path', () => {
  const { errors } = collectIssues(doc([neutral({ name: '', destinationURL: 'http://x', priceText: '' })]));
  const paths = errors.map((x) => x.path);
  assert.ok(paths.includes('brands[0].name'));
  assert.ok(paths.includes('brands[0].destinationURL'));
  assert.ok(paths.includes('brands[0].priceText'));
});

test('encoder matches publish_catalog.encode layout', () => {
  const text = new TextDecoder().decode(encodeCatalog({ a: 1, b: [], c: {}, d: 'é' }));
  assert.equal(text, '{\n  "a": 1,\n  "b": [],\n  "c": {},\n  "d": "é"\n}\n');
});
