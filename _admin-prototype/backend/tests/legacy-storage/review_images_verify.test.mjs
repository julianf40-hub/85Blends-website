// Reviewed-change binding, CORS/origin checks, validated image uploads and the on-demand verifier.
// Local stack, fictional data. Run serially with the other suites:
//   node --test --test-concurrency=1 tests/*.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { ENV, FN, draftRow, fn, head, http, mfa, publicRead, publish, resetLocalDatabase, review, saveDraft, serviceWrite, sleep, sql } from '../helpers.mjs';

let publisher;
let editor;

// ---- tiny image builders (fictional test images) ----------------------------------------------
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(width, height, seed = 0) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const small = width * height <= 64 * 64;
  const raw = small ? Buffer.alloc((width * 3 + 1) * height, seed) : Buffer.alloc(16, seed); // header-only check for huge sizes
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function jpegHeader(width, height) {
  // SOI, SOF0 with dimensions, EOI: enough for header sniffing (not a renderable photo)
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}
const heic = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(16)]);
const upload = (token, brand, bytes, type) => http(`/functions/v1/${FN.name}?action=upload_image&brand=${brand}`, { method: 'POST', token, body: bytes, raw: true, headers: { 'Content-Type': type } });

before(async () => {
  resetLocalDatabase({ legacyStoragePath: true });
  await sleep(3000);
  publisher = await mfa('publisher');
  editor = await mfa('editor');
  await saveDraft(publisher, (c, m) => { for (const b of c.brands) m.approvals[b.id] = 'approved'; });
});

// ---------------------------------------------------------------- reviewed-change binding
test('publish is bound to the reviewed draft: a draft saved after review makes the publish stale', async () => {
  const reviewed = await review(publisher, 'staging');
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
  assert.ok(reviewed.data.reviewDigest);
  await saveDraft(editor, (c) => { c.brands[0].priceText = 'From $301'; });
  const r = await fn(publisher, { action: 'publish', target: 'staging', draftVersion: reviewed.data.draftVersion, expectedLiveRevision: null, reviewDigest: reviewed.data.reviewDigest });
  assert.equal(r.data.error, 'draft_changed', JSON.stringify(r.data));
});

test('publish is bound to the reviewed approvals and baseline (same draft version, different digest)', async () => {
  // approvals live in the draft meta, so changing them bumps the version; forge the same version with a stale digest instead
  const reviewed = await review(publisher, 'production');
  const forged = { ...reviewed.data, reviewDigest: createHash('sha256').update('something else').digest('hex') };
  const r = await fn(publisher, { action: 'publish', target: 'production', draftVersion: forged.draftVersion, expectedLiveRevision: null, confirmation: 'PUBLISH PRODUCTION', reviewDigest: forged.reviewDigest });
  assert.equal(r.data.error, 'review_stale', JSON.stringify(r.data));
  const missing = await fn(publisher, { action: 'publish', target: 'staging', draftVersion: draftRow().version, expectedLiveRevision: null });
  assert.equal(missing.data.error, 'review_stale');
  // baseline change: a publication to staging after the review changes the live revision
  const stagingReview = await review(publisher, 'staging');
  assert.equal((await publish(publisher, 'staging')).status, 200);
  const late = await fn(publisher, { action: 'publish', target: 'staging', draftVersion: draftRow().version, expectedLiveRevision: stagingReview.data.live?.revision ?? null, reviewDigest: stagingReview.data.reviewDigest });
  assert.equal(late.data.error, 'live_changed');
});

test('acknowledging drift after a review changes the baseline, so the old review is stale', async () => {
  const before = await review(publisher, 'staging');
  const current = (await publicRead('staging')).data;
  await serviceWrite('staging', JSON.stringify({ ...current, revision: `bypass-${Date.now()}`, publishedAt: Math.floor(Date.now() / 1000) + 10, brands: current.brands.slice(1) }, null, 2) + '\n');
  const drift = (await fn(publisher, { action: 'inspect', target: 'staging' })).data;
  assert.equal((await fn(publisher, { action: 'acknowledge', target: 'staging', digest: drift.originDigest })).status, 200);
  const r = await fn(publisher, { action: 'publish', target: 'staging', draftVersion: draftRow().version, expectedLiveRevision: head('staging').revision, reviewDigest: before.data.reviewDigest });
  assert.equal(r.data.error, 'review_stale', JSON.stringify(r.data));
  const fresh = await review(publisher, 'staging');
  assert.equal(fresh.data.baseline, 'acknowledged_storage');
  assert.equal((await publish(publisher, 'staging')).status, 200);
});

// ---------------------------------------------------------------- origin / CORS
test('browser origin: the admin origin gets CORS; any other origin is refused server-side', async () => {
  // Locally the Kong gateway answers preflights itself ('*'); hosted functions must set CORS (hosted check).
  const pre = await fetch(`${ENV.API_URL}/functions/v1/gear-publish`, { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:4174', 'Access-Control-Request-Method': 'POST' } });
  assert.ok(pre.status < 300);
  assert.ok(['http://127.0.0.1:4174', '*'].includes(pre.headers.get('access-control-allow-origin')));
  // the authoritative control: the function itself refuses other origins
  const ok = await http('/functions/v1/gear-publish', { method: 'POST', token: publisher, body: { action: 'inspect', target: 'staging' }, headers: { Origin: 'http://127.0.0.1:4174' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers?.get?.('access-control-allow-origin') ?? 'http://127.0.0.1:4174', 'http://127.0.0.1:4174');
  const evil = await http('/functions/v1/gear-publish', { method: 'POST', token: publisher, body: { action: 'inspect', target: 'staging' }, headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  assert.equal(evil.data.error, 'bad_origin');
});

// ---------------------------------------------------------------- images
test('image upload: PNG and JPEG accepted (content-addressed, idempotent); editors may upload', async () => {
  const p = png(8, 8, 7);
  const r = await upload(editor, 'northwind-sensors', p, 'image/png');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const sha = createHash('sha256').update(p).digest('hex');
  assert.equal(r.data.publicURL, `https://storage.example.invalid/recommended-gear/images/northwind-sensors/${sha}.png`);
  assert.equal(r.data.width, 8);
  const again = await upload(publisher, 'northwind-sensors', p, 'image/png');
  assert.equal(again.data.alreadyStored, true);
  const j = await upload(publisher, 'example-fuel-tools', jpegHeader(640, 480), 'image/jpeg');
  assert.equal(j.status, 200, JSON.stringify(j.data));
  assert.equal(j.data.height, 480);
  const stored = await http(`/storage/v1/object/public/recommended-gear/images/northwind-sensors/${sha}.png`);
  assert.equal(stored.status, 200);
});

test('image upload: HEIF/HEIC, spoofed types, non-images, oversized dimensions and non-admins are refused', async () => {
  assert.equal((await upload(publisher, 'x', heic(), 'image/heic')).data.error, 'heif_disabled');
  assert.equal((await upload(publisher, 'x', heic(), 'image/png')).data.error, 'heif_disabled'); // sniffed, whatever is declared
  assert.equal((await upload(publisher, 'x', png(4, 4), 'image/jpeg')).data.error, 'type_mismatch');
  assert.equal((await upload(publisher, 'x', Buffer.from('<svg/>'), 'image/png')).data.error, 'type_mismatch');
  assert.equal((await upload(publisher, 'x', png(9000, 10), 'image/png')).data.error, 'too_many_pixels');
  assert.equal((await upload(publisher, 'x', png(7000, 7000), 'image/png')).data.error, 'too_many_pixels'); // 49 MP
  assert.equal((await upload(publisher, 'Bad Brand', png(4, 4), 'image/png')).data.error, 'bad_brand');
  assert.equal((await upload(await mfa('outsider'), 'x', png(4, 4), 'image/png')).data.error, 'not_admin');
});

test('image storage rules: no direct uploads without a grant, no overwrites, no deletes', async () => {
  const p = png(5, 5, 9);
  const sha = createHash('sha256').update(p).digest('hex');
  const direct = await http(`/storage/v1/object/recommended-gear/images/x/${sha}.png`, { method: 'POST', token: publisher, body: p, raw: true, headers: { 'Content-Type': 'image/png' } });
  assert.ok(direct.status >= 400, `direct image upload: ${direct.status}`);
  const ok = await upload(publisher, 'x', p, 'image/png');
  assert.equal(ok.status, 200);
  const overwrite = await http(`/storage/v1/object/recommended-gear/images/x/${sha}.png`, { method: 'POST', token: publisher, body: png(5, 5, 1), raw: true, headers: { 'Content-Type': 'image/png', 'x-upsert': 'true' } });
  assert.ok(overwrite.status >= 400, `overwrite: ${overwrite.status}`);
  const del = await http(`/storage/v1/object/recommended-gear/images/x/${sha}.png`, { method: 'DELETE', token: publisher });
  assert.ok(del.status >= 400 || (await http(`/storage/v1/object/public/recommended-gear/images/x/${sha}.png`)).status === 200, 'still present after delete attempt');
  assert.equal((await http(`/storage/v1/object/public/recommended-gear/images/x/${sha}.png`)).status, 200);
});

test('review blocks Production when a referenced gear image is missing; Staging warns for non-gear hosts', async () => {
  await saveDraft(publisher, (c) => { c.brands[0].heroImageURL = `https://storage.example.invalid/recommended-gear/images/northwind-sensors/${'0'.repeat(64)}.png`; });
  const prod = await review(publisher, 'production');
  assert.ok(prod.data.errors.some((e) => /image not found/.test(e.message)), JSON.stringify(prod.data.errors));
  await saveDraft(publisher, (c) => { c.brands[0].heroImageURL = 'https://cdn.example.com/hero.png'; });
  const staging = await review(publisher, 'staging');
  assert.ok(staging.data.warnings.some((w) => /not on gear image storage/.test(w.message)));
  const prod2 = await review(publisher, 'production');
  assert.ok(prod2.data.errors.some((e) => /not on gear image storage/.test(e.message)));
});

// ---------------------------------------------------------------- verifier
test('verifier (on demand, read-only): reports drift, missing images and unreferenced images; deletes nothing', async () => {
  const before = sql(`select count(*) from storage.objects where bucket_id = 'recommended-gear'`);
  const report = await fn(publisher, { action: 'verify' });
  assert.equal(report.status, 200, JSON.stringify(report.data));
  const r = report.data;
  assert.ok(r.info.some((a) => a.target === 'draft' && a.kind === 'image'), 'draft image on a non-gear host is reported (warning level for drafts)');
  assert.ok(r.images.unreferenced.length >= 2, 'test uploads are unreferenced');
  assert.ok(r.images.unreferenced.every((o) => o.deleted === false));
  assert.equal(r.alertDelivery.configured, false);
  assert.equal(sql(`select count(*) from storage.objects where bucket_id = 'recommended-gear'`), before, 'nothing deleted');
  assert.match(sql(`select string_agg(event, ',') from public.gear_audit_log`), /verify_run/);
  // drift is an alert
  await serviceWrite('staging', '{"schemaVersion":1,"revision":"","brands":"x"}');
  const again = (await fn(publisher, { action: 'verify' })).data;
  assert.ok(again.alerts.some((a) => a.target === 'staging' && a.kind === 'storage_drift'));
  // an editor may run it too (read-only)
  assert.equal((await fn(editor, { action: 'verify' })).status, 200);
});
