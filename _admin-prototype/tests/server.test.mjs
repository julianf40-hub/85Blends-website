// Server-side rules the real Edge Functions / RLS must also enforce.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createAdminServer, PRODUCTION_CONFIRMATION } from '../server.mjs';

let base;
let server;
let stateDir;
let clockMs = Date.UTC(2026, 10, 13, 12, 0, 0);

const headers = (user, aal = 'aal2') => ({ 'X-Prototype-User': user, 'X-Prototype-AAL': aal, Origin: base, 'Content-Type': 'application/json' });
async function call(path, { method = 'GET', user = 'publisher@example.test', aal, body, extra = {} } = {}) {
  const res = await fetch(base + path, { method, headers: { ...headers(user, aal), ...extra }, body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}
const state = async () => (await call('/api/state')).data;
async function saveDraft(mutate, { user = 'publisher@example.test', aal } = {}) {
  const s = await state();
  const working = { catalog: structuredClone(s.draft.catalog), meta: structuredClone(s.draft.meta) };
  mutate(working);
  return call('/api/draft', { method: 'PUT', user, aal, body: working, extra: { 'If-Match': `"v${s.draft.version}"` } });
}
async function publish(target, extra = {}) {
  const s = await state();
  return call('/api/publish', { method: 'POST', body: { target, draftVersion: s.draft.version, expectedLiveRevision: s.live[target].head?.revision ?? null, confirmation: target === 'production' ? PRODUCTION_CONFIRMATION : undefined, ...extra } });
}
const approveAll = (w) => { for (const b of w.catalog.brands) w.meta.approvals[b.id] = 'approved'; };

before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'gear-admin-'));
  const admin = createAdminServer({ stateDir, clock: () => clockMs });
  await admin.initialize();
  await new Promise((resolve) => admin.server.listen(0, '127.0.0.1', resolve));
  server = admin.server;
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  await rm(stateDir, { recursive: true, force: true });
});

test('unauthenticated and non-admin users are refused', async () => {
  assert.equal((await call('/api/state', { user: '' })).status, 401);
  assert.equal((await call('/api/state', { user: 'viewer@example.test' })).status, 403);
});

test('writes need MFA (aal2) and a same-origin request', async () => {
  const r = await saveDraft((w) => { w.catalog.brands[0].priceText = 'From $1'; }, { aal: 'aal1' });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'mfa_required');
  const s = await state();
  const cross = await fetch(`${base}/api/draft`, { method: 'PUT', headers: { ...headers('publisher@example.test'), Origin: 'https://evil.example', 'If-Match': `"v${s.draft.version}"` }, body: JSON.stringify(s.draft) });
  assert.equal(cross.status, 403);
});

test('draft save uses optimistic locking (If-Match)', async () => {
  const s = await state();
  const noMatch = await call('/api/draft', { method: 'PUT', body: s.draft });
  assert.equal(noMatch.status, 428);
  const first = await call('/api/draft', { method: 'PUT', body: s.draft, extra: { 'If-Match': `"v${s.draft.version}"` } });
  assert.equal(first.status, 200);
  const stale = await call('/api/draft', { method: 'PUT', user: 'editor@example.test', body: s.draft, extra: { 'If-Match': `"v${s.draft.version}"` } });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.current.version, s.draft.version + 1);
});

test('the browser cannot set revision or publishedAt', async () => {
  const r = await saveDraft((w) => { w.catalog.revision = 'mine'; w.catalog.publishedAt = 9_999_999_999; });
  assert.equal(r.data.draft.catalog.revision, undefined);
  assert.equal(r.data.draft.catalog.publishedAt, undefined);
});

test('editors may publish to staging but not production', async () => {
  const s = await state();
  const r = await call('/api/publish', { method: 'POST', user: 'editor@example.test', body: { target: 'production', draftVersion: s.draft.version, expectedLiveRevision: s.live.production.head.revision, confirmation: PRODUCTION_CONFIRMATION } });
  assert.equal(r.status, 403);
  const staged = await call('/api/publish', { method: 'POST', user: 'editor@example.test', body: { target: 'staging', draftVersion: s.draft.version, expectedLiveRevision: s.live.staging.head?.revision ?? null } });
  assert.equal(staged.status, 200, JSON.stringify(staged.data));
  assert.equal(staged.data.simulated, true);
});

test('production is blocked by a pending approval and needs the typed confirmation', async () => {
  const blocked = await publish('production');
  assert.equal(blocked.status, 422);
  assert.ok(blocked.data.errors.some((x) => x.message.includes('approval is pending')));
  await saveDraft(approveAll);
  assert.equal((await publish('production', { confirmation: 'yes' })).status, 400);
});

test('stale reviews are refused: live changed or draft changed', async () => {
  const s = await state();
  const wrongLive = await call('/api/publish', { method: 'POST', body: { target: 'production', draftVersion: s.draft.version, expectedLiveRevision: 'something-else', confirmation: PRODUCTION_CONFIRMATION } });
  assert.equal(wrongLive.status, 409);
  assert.equal(wrongLive.data.error, 'live_changed');
  const wrongDraft = await call('/api/publish', { method: 'POST', body: { target: 'production', draftVersion: s.draft.version - 1, expectedLiveRevision: s.live.production.head.revision, confirmation: PRODUCTION_CONFIRMATION } });
  assert.equal(wrongDraft.status, 409);
});

test('invalid content is refused server-side even if the browser is bypassed', async () => {
  await saveDraft((w) => { w.catalog.brands[0].destinationURL = 'javascript:alert(1)'; });
  const r = await publish('staging');
  assert.equal(r.status, 422);
  await saveDraft((w) => { w.catalog.brands[0].destinationURL = 'https://example.com/northwind'; });
});

test('concurrent publishes are serialized with strictly increasing publishedAt and unique revisions', async () => {
  const results = await Promise.all([publish('production'), publish('production')]);
  const ok = results.filter((r) => r.status === 200);
  const conflicts = results.filter((r) => r.status === 409);
  assert.equal(ok.length, 1, JSON.stringify(results.map((r) => r.data)));
  assert.equal(conflicts.length, 1); // the second saw a different live revision than it reviewed
  // Rapid successive publishes in the same second still increase.
  await saveDraft((w) => { w.catalog.brands[0].priceText = 'From $99'; });
  const next = await publish('production');
  assert.equal(next.status, 200);
  assert.equal(next.data.publishedAt, ok[0].data.publishedAt + 1);
  assert.notEqual(next.data.revision, ok[0].data.revision);
});

test('publishing identical content again is refused (devices would treat it as unchanged)', async () => {
  const s = await state();
  // republish the same brands: a new revision makes bytes differ, so it IS a valid newer publication
  const again = await publish('production');
  assert.equal(again.status, 200);
  assert.ok(again.data.publishedAt > s.live.production.head.publishedAt);
});

test('rollback is a new publication with a new revision and newer publishedAt', async () => {
  const { data } = await call('/api/history?target=production');
  const seed = data.history.at(-1);
  const s = await state();
  const r = await call('/api/rollback', { method: 'POST', body: { target: 'production', publicationId: seed.id, expectedLiveRevision: s.live.production.head.revision, confirmation: PRODUCTION_CONFIRMATION } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.notEqual(r.data.revision, seed.revision);
  assert.ok(r.data.publishedAt > s.live.production.head.publishedAt);
  const live = JSON.parse(await readFile(join(stateDir, 'objects', 'production', 'catalog-v1.json'), 'utf8'));
  assert.deepEqual(live.brands, JSON.parse(seed.document).brands);
  const editor = await call('/api/rollback', { method: 'POST', user: 'editor@example.test', body: { target: 'production', publicationId: seed.id, expectedLiveRevision: r.data.revision, confirmation: PRODUCTION_CONFIRMATION } });
  assert.equal(editor.status, 403);
});

test('history is append-only and records who, when, digest and summary', async () => {
  const lines = (await readFile(join(stateDir, 'history.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.length >= 5);
  for (const h of lines) {
    assert.ok(h.revision && h.publishedAt && h.publishedBy && h.summary);
    assert.equal(createHash('sha256').update(h.document).digest('hex'), h.digest);
  }
});

test('a live publishedAt far in the future stops publishing (clock guard)', async () => {
  const saved = clockMs;
  clockMs = Date.UTC(2026, 9, 1); // clock moved back ~6 weeks
  const r = await publish('production');
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'live_in_future');
  clockMs = saved;
});

test('uploads: signed, single-use, digest-checked, type-sniffed, never overwritten', async () => {
  const png = await readFile(new URL('../data/images/' + (await readdir(new URL('../data/images/', import.meta.url)))[0], import.meta.url));
  const fresh = Buffer.concat([png, Buffer.from('x')]); // trailing byte: new digest, still a PNG header
  const sha = createHash('sha256').update(fresh).digest('hex');
  assert.equal((await call('/api/uploads/sign', { method: 'POST', body: { brandId: 'northwind-sensors', contentType: 'image/gif', byteLength: 10, sha256: sha } })).status, 415);
  assert.equal((await call('/api/uploads/sign', { method: 'POST', body: { brandId: 'northwind-sensors', contentType: 'image/png', byteLength: 6_000_000, sha256: sha } })).status, 413);
  const grant = await call('/api/uploads/sign', { method: 'POST', body: { brandId: 'northwind-sensors', contentType: 'image/png', byteLength: fresh.length, sha256: sha } });
  assert.equal(grant.status, 200);
  assert.match(grant.data.publicURL, new RegExp(`/images/northwind-sensors/${sha}\\.png$`));
  const wrong = await call(grant.data.uploadURL, { method: 'PUT', body: new Uint8Array(fresh.length) });
  assert.equal(wrong.status, 400); // digest mismatch; token is now spent
  assert.equal((await call(grant.data.uploadURL, { method: 'PUT', body: new Uint8Array(fresh) })).status, 403);
  const again = await call('/api/uploads/sign', { method: 'POST', body: { brandId: 'northwind-sensors', contentType: 'image/png', byteLength: fresh.length, sha256: sha } });
  assert.equal((await call(again.data.uploadURL, { method: 'PUT', body: new Uint8Array(fresh) })).status, 201);
  const dup = await call('/api/uploads/sign', { method: 'POST', body: { brandId: 'northwind-sensors', contentType: 'image/png', byteLength: fresh.length, sha256: sha } });
  assert.equal(dup.data.alreadyStored, true);
  const img = await fetch(`${base}/images/${sha}.png`);
  assert.equal(img.status, 200);
  assert.match(img.headers.get('cache-control'), /immutable/);
});

test('security headers and static path containment', async () => {
  const res = await fetch(`${base}/`);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  for (const path of ['/../server.mjs', '/%2e%2e/server.mjs', '/lib/../server.mjs', '/images/../server.mjs']) {
    const r = await fetch(base + path);
    const body = await r.text();
    assert.ok(!body.includes('createAdminServer'), path);
  }
});
