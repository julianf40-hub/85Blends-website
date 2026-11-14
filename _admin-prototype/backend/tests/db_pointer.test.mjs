// Decision D10, option 2: the database is the publication channel (LOCAL stack, fictional data).
// Re-runs the concurrency, stale-writer, duplicate-request, lost-response and rollback scenarios
// against the new design, plus the read endpoint, caching and client-regression checks.
// The failing old-design demonstrations are preserved in tests/legacy-storage/.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { USERS } from '../tools/make-seed.mjs';
import { ENV, draftRow, fn, head, http, mfa, review, resetLocalDatabase, saveDraft, serviceWrite, signIn, sleep, sql, svc , needsFaults } from './helpers.mjs';
import { ClientModel } from './client-model.mjs';

let publisher;
before(async () => {
  resetLocalDatabase();
  await sleep(3000);
  publisher = await mfa('publisher');
});

const evidence = (name, data) => console.log(`EVIDENCE ${name} ${JSON.stringify(data)}`);
const count = (target) => Number(sql(`select count(*) from public.gear_catalog_publications where target = '${target}'`));
const pointer = (target) => JSON.parse(sql(`select json_build_object('publication', h.current_publication_id, 'revision', h.revision, 'publishedAt', h.published_at, 'digest', h.digest) from public.gear_publication_head h where h.target = '${target}'`));
const sha = (b) => createHash('sha256').update(b).digest('hex');
let edits = 0;
const edit = (label) => saveDraft(publisher, (c) => { c.brands[0].tagline = `${label} #${++edits}`; });

/** Fetches the public endpoint the apps use: no apikey, no Authorization, nothing but optional If-None-Match. */
async function catalog(target, { etag, method = 'GET' } = {}) {
  const res = await fetch(`${ENV.API_URL}/functions/v1/gear-catalog/${target}`, { method, headers: etag ? { 'If-None-Match': etag } : {} });
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, body, etag: res.headers.get('etag'), cache: res.headers.get('cache-control'),
    revision: res.headers.get('x-gear-revision'), publishedAt: Number(res.headers.get('x-gear-published-at')) };
}

/** Review, then publish with a fresh operation ID (returned so a test can retry it). */
async function reviewed(target, extra = {}) {
  const r = await review(publisher, target, extra.rollbackOf ? { rollbackOf: extra.rollbackOf } : {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { target, draftVersion: draftRow().version, expectedLiveRevision: head(target).revision, reviewDigest: r.data.reviewDigest,
    confirmation: target === 'production' ? 'PUBLISH PRODUCTION' : undefined, operationId: randomUUID(), ...extra };
}
const send = (body, headers = {}) => fn(publisher, { action: body.rollbackOf ? 'rollback' : 'publish', ...body, publicationId: body.rollbackOf }, headers);

// ---------------------------------------------------------------- publishing and reading
test('publish commits exact bytes and advances the pointer in one transaction; the endpoint serves those bytes', async () => {
  await edit('first');
  const p = await send(await reviewed('staging'));
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(p.data.replayed, false);
  const ptr = pointer('staging');
  assert.equal(ptr.publication, p.data.publicationId);
  assert.equal(ptr.revision, p.data.revision);
  const row = JSON.parse(sql(`select json_build_object('digest', digest, 'doc', document, 'aal', auth_aal, 'amr', auth_amr, 'op', operation_id) from public.gear_catalog_publications where id = '${p.data.publicationId}'`));
  assert.equal(sha(Buffer.from(row.doc, 'utf8')), row.digest, 'digest stored with the bytes');
  assert.equal(row.aal, 'aal2'); assert.ok(row.amr.some((m) => m.method === 'totp'), 'MFA evidence taken from the JWT in the database');
  assert.equal(row.op, p.data.operationId);
  const served = await catalog('staging');
  assert.equal(served.status, 200);
  assert.equal(sha(served.body), row.digest, 'served bytes are exactly the recorded bytes');
  assert.ok(served.body.equals(Buffer.from(row.doc, 'utf8')));
  assert.match(served.etag, new RegExp(`^(W/)?"${row.digest}"$`));
  assert.equal(served.cache, 'no-cache');
  assert.equal(served.revision, p.data.revision);
  assert.equal(sql(`select status from public.gear_publication_status where publication_id = '${p.data.publicationId}'`), 'committed');
  assert.equal(Number(sql(`select count(*) from storage.objects where bucket_id = 'recommended-gear' and name like '%catalog-v1.json'`)), 0, 'nothing written to Storage');
  evidence('publish', { publicationId: p.data.publicationId, digest: row.digest.slice(0, 16), servedBytes: served.body.length, etag: served.etag });
});

test('read endpoint: guests read Production and Staging separately with no sign-in; 304, HEAD, 404 before publishing; read-only', async () => {
  const prod = await catalog('production');
  assert.equal(prod.status, 404, 'nothing published to Production yet');
  assert.equal(JSON.parse(prod.body).error, 'not_published');
  const staging = await catalog('staging');
  assert.equal(staging.status, 200);
  const strong = staging.etag.replace(/^W\//, '');
  assert.equal((await catalog('staging', { etag: strong })).status, 304, 'strong ETag revalidates');
  assert.equal((await catalog('staging', { etag: `W/${strong}` })).status, 304, 'weak form too (the local gateway weakens ETags)');
  assert.equal((await catalog('staging', { etag: '"something-else"' })).status, 200);
  const headRes = await catalog('staging', { method: 'HEAD' });
  assert.equal(headRes.status, 200); assert.equal(headRes.body.length, 0);
  assert.equal((await catalog('unknown')).status, 404);
  const post = await fetch(`${ENV.API_URL}/functions/v1/gear-catalog/staging`, { method: 'POST', body: '{}' });
  assert.equal(post.status, 405, 'read-only');
  // An app user's own session (not an admin) is fine too, but never required.
  const user = await signIn('outsider');
  const withUser = await fetch(`${ENV.API_URL}/functions/v1/gear-catalog/staging`, { headers: { Authorization: `Bearer ${user}`, apikey: ENV.ANON_KEY } });
  assert.equal(withUser.status, 200);
  // The read RPC behind it is anon-executable and returns only the current publication.
  const viaRpc = await http('/rest/v1/rpc/gear_current_catalog', { method: 'POST', body: { p_target: 'staging' } });
  assert.equal(viaRpc.status, 200); assert.equal(viaRpc.data.length, 1);
  // Admin tables stay unreadable to anon (permission denied, or an empty result under RLS).
  const anon = await http('/rest/v1/gear_catalog_publications?select=id');
  assert.ok(anon.status >= 400 || (Array.isArray(anon.data) && anon.data.length === 0), JSON.stringify(anon));
});

test('Production: guests can read it once published; confirmation, approvals and the step-up are enforced', async () => {
  const missing = await send({ ...(await reviewed('production')), confirmation: 'nope' });
  assert.equal(missing.data.error, 'confirmation_required');
  await saveDraft(publisher, (c, meta) => { for (const b of c.brands) meta.approvals = { ...(meta.approvals ?? {}), [b.id]: 'approved' }; });
  const p = await send(await reviewed('production'));
  assert.equal(p.status, 200, JSON.stringify(p.data));
  const served = await catalog('production');
  assert.equal(served.status, 200);
  assert.equal(served.cache, 'public, max-age=60');
  assert.equal(served.revision, p.data.revision);
});

// ---------------------------------------------------------------- the five scenarios
test('concurrency: five publishers race from the same reviewed state; exactly one advances the pointer', async () => {
  await edit('race');
  const before = count('staging');
  const base = await reviewed('staging');
  const results = await Promise.all([0, 1, 2, 3, 4].map(() => send({ ...base, operationId: randomUUID() })));
  const ok = results.filter((r) => r.status === 200);
  const refused = results.filter((r) => r.status !== 200);
  evidence('concurrency', results.map((r) => ({ status: r.status, error: r.data.error ?? null })));
  assert.equal(ok.length, 1, JSON.stringify(results.map((r) => r.data)));
  assert.ok(refused.every((r) => r.status === 409 && ['live_changed', 'review_stale'].includes(r.data.error)), JSON.stringify(refused.map((r) => r.data)));
  assert.equal(count('staging'), before + 1);
  assert.equal(pointer('staging').revision, ok[0].data.revision);
  assert.equal((await catalog('staging')).revision, ok[0].data.revision);
});

test('stale writer: A validated and prepared, then delayed; B commits; A cannot replace the newer head (enforced in the database)', { skip: needsFaults }, async () => {
  await edit('stale A/B');
  const aBody = await reviewed('staging');
  const before = count('staging');
  // A pauses after preparing its intent, before the commit (a slow or suspended publisher).
  const aPromise = send(aBody, { 'x-gear-test-fault': 'pause_before_commit:4000' });
  await sleep(1500);
  const bBody = await reviewed('staging'); // same draft, same baseline: B is a second publisher
  const b = await send(bBody);
  assert.equal(b.status, 200, JSON.stringify(b.data));
  const a = await aPromise;
  evidence('stale-writer', { a: { status: a.status, error: a.data.error, message: a.data.message }, b: b.data.revision, pointer: pointer('staging').revision });
  assert.equal(a.status, 409); assert.equal(a.data.error, 'live_changed');
  assert.equal(count('staging'), before + 1, 'only B');
  assert.equal(pointer('staging').revision, b.data.revision);
  assert.equal((await catalog('staging')).revision, b.data.revision);
  assert.equal(sql(`select count(*) from private.gear_publish_intents where operation_id = '${aBody.operationId}' and publication_id is null`), '1', "A's intent stays uncommitted");
});

/** Starts a publish that pauses before its commit, then aborts the CLIENT side after `abortAfter` ms. */
async function abandoned(body, pauseMs, abortAfter) {
  const controller = new AbortController();
  const req = fetch(`${ENV.API_URL}/functions/v1/gear-publish`, { method: 'POST', signal: controller.signal,
    headers: { apikey: ENV.ANON_KEY, Authorization: `Bearer ${publisher}`, 'Content-Type': 'application/json', 'x-gear-test-fault': `pause_before_commit:${pauseMs}` },
    body: JSON.stringify({ action: 'publish', ...body }) }).catch((e) => ({ aborted: e.name }));
  await sleep(abortAfter);
  controller.abort();
  assert.deepEqual(await req, { aborted: 'AbortError' });
}
const committedBy = (op) => sql(`select coalesce(publication_id::text, '') from private.gear_publish_intents where operation_id = '${op}'`);

test('a client that gives up proves nothing: measured whether the server still committed; a retry yields exactly one publication either way', { skip: needsFaults }, async () => {
  await edit('abandoned, no competitor');
  const body = await reviewed('staging');
  const before = count('staging');
  await abandoned(body, 2000, 700);
  await sleep(3000); // well past the server-side pause
  const serverCommitted = committedBy(body.operationId) !== '';
  const retry = await send(body);
  evidence('client-abort', { serverCommittedAfterClientAbort: serverCommitted, retry: { status: retry.status, replayed: retry.data.replayed } });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.replayed, serverCommitted, 'the retry replays exactly when the abandoned request had committed');
  assert.equal(count('staging'), before + 1);
});

test('stale writer whose client gave up: whatever the server does, the database refuses it after a newer commit', { skip: needsFaults }, async () => {
  await edit('abandoned A');
  const aBody = await reviewed('staging');
  await abandoned(aBody, 4000, 1000); // the client times out; this proves nothing about the server
  const b = await send(await reviewed('staging'));
  assert.equal(b.status, 200);
  await sleep(4000); // A's server-side request resumes and attempts its commit
  assert.equal(pointer('staging').revision, b.data.revision, 'the newer head stays');
  assert.equal(sql(`select publication_id is null from private.gear_publish_intents where operation_id = '${aBody.operationId}'`), 't');
  // Retrying A's operation now reports the conflict instead of creating anything.
  const retry = await send(aBody);
  assert.equal(retry.status, 409); assert.equal(retry.data.error, 'live_changed');
});

test('duplicate requests: the same operation sent five times at once creates exactly one publication', async () => {
  await edit('duplicates');
  const body = await reviewed('staging');
  const before = count('staging');
  const results = await Promise.all([0, 1, 2, 3, 4].map(() => send(body)));
  evidence('duplicates', results.map((r) => ({ status: r.status, replayed: r.data.replayed ?? null, revision: r.data.revision ?? null, error: r.data.error ?? null })));
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.data)));
  assert.equal(new Set(results.map((r) => r.data.revision)).size, 1, 'one revision');
  assert.equal(results.filter((r) => r.data.replayed === false).length, 1, 'one original, the rest replays');
  assert.equal(count('staging'), before + 1);
});

test('lost response: the commit succeeded but the response was lost; a retry returns the original, never a second publication', { skip: needsFaults }, async () => {
  await edit('lost response');
  const body = await reviewed('staging');
  const before = count('staging');
  const lost = await send(body, { 'x-gear-test-fault': 'response_lost' });
  assert.equal(lost.status, 502); assert.equal(lost.data.error, 'test_response_lost');
  assert.equal(count('staging'), before + 1, 'it was committed');
  const retry = await send(body);
  evidence('lost-response', { first: lost.status, retry: { status: retry.status, replayed: retry.data.replayed, revision: retry.data.revision }, pointer: pointer('staging').revision });
  assert.equal(retry.status, 200); assert.equal(retry.data.replayed, true);
  assert.equal(retry.data.revision, pointer('staging').revision);
  assert.equal(count('staging'), before + 1, 'no second publication');
  // Reusing that operation ID for a different request is refused, not silently replayed.
  await edit('different request');
  const reused = await send({ ...(await reviewed('staging')), operationId: body.operationId });
  assert.equal(reused.status, 409); assert.equal(reused.data.error, 'operation_conflict');
});

test('a retry while the original request may still be in flight: one publication, both answers name it', { skip: needsFaults }, async () => {
  await edit('abort then retry');
  const body = await reviewed('staging');
  const before = count('staging');
  await abandoned(body, 2000, 500);
  // Retry while the original is still in flight, and again after it finished.
  const early = await send(body);
  await sleep(2500);
  const late = await send(body);
  evidence('abort-retry', { early: { status: early.status, replayed: early.data.replayed, revision: early.data.revision }, late: { status: late.status, replayed: late.data.replayed, revision: late.data.revision } });
  assert.equal(early.status, 200); assert.equal(late.status, 200);
  assert.equal(early.data.revision, late.data.revision);
  assert.equal(count('staging'), before + 1, 'one publication whichever request committed it');
});

test('rollback: a new revision with a newer publishedAt and the old content; reviewed and bound like a publish', async () => {
  const pubs = JSON.parse(sql(`select json_agg(json_build_object('id', id, 'revision', revision, 'publishedAt', published_at, 'doc', document) order by published_at) from public.gear_catalog_publications where target = 'staging'`));
  const source = pubs[0];
  const current = pointer('staging');
  const body = await reviewed('staging', { rollbackOf: source.id });
  const r = await send(body);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.notEqual(r.data.revision, source.revision);
  assert.ok(r.data.publishedAt > current.publishedAt, 'newer than the current head');
  assert.equal(r.data.rollbackOf, source.id);
  const served = JSON.parse((await catalog('staging')).body);
  assert.deepEqual(served.brands, JSON.parse(source.doc).brands, 'old content');
  assert.equal(served.revision, r.data.revision);
  // A stale rollback (reviewed before another commit) is refused like any stale publish.
  const staleRollback = await reviewed('staging', { rollbackOf: pubs[1].id });
  await edit('after rollback review');
  assert.equal((await send(await reviewed('staging'))).status, 200);
  const late = await send(staleRollback);
  assert.equal(late.status, 409); assert.ok(['live_changed', 'review_stale'].includes(late.data.error), late.data.error);
  // Retrying the successful rollback replays it.
  const again = await send(body);
  assert.equal(again.status, 200); assert.equal(again.data.replayed, true); assert.equal(again.data.revision, r.data.revision);
});

// ---------------------------------------------------------------- binding enforced by the database
test('a draft saved between validation and commit is refused by the database (draft_changed), nothing committed', { skip: needsFaults }, async () => {
  await edit('bound draft');
  const body = await reviewed('staging');
  const before = count('staging');
  const pending = send(body, { 'x-gear-test-fault': 'pause_before_commit:2500' });
  await sleep(1000);
  await edit('saved while the publisher waited');
  const r = await pending;
  assert.equal(r.status, 409); assert.equal(r.data.error, 'draft_changed');
  assert.equal(count('staging'), before);
});

test('the commit RPC cannot be used to bypass the function: no intent, wrong role, or anon all fail; intents are service-only', async () => {
  const unknown = await http('/rest/v1/rpc/gear_commit_publication', { method: 'POST', token: publisher, body: { p_operation_id: randomUUID() } });
  assert.match(JSON.stringify(unknown.data), /unknown_operation/);
  const editor = await mfa('editor');
  assert.match(JSON.stringify((await http('/rest/v1/rpc/gear_commit_publication', { method: 'POST', token: editor, body: { p_operation_id: randomUUID() } })).data), /publisher_required/);
  const aal1 = await signIn('publisher');
  assert.match(JSON.stringify((await http('/rest/v1/rpc/gear_commit_publication', { method: 'POST', token: aal1, body: { p_operation_id: randomUUID() } })).data), /publisher_required/);
  assert.ok((await http('/rest/v1/rpc/gear_commit_publication', { method: 'POST', body: { p_operation_id: randomUUID() } })).status >= 400, 'anon');
  for (const rpc of ['gear_prepare_intent', 'gear_find_intent', 'gear_intent_overview']) {
    const r = await http(`/rest/v1/rpc/${rpc}`, { method: 'POST', token: publisher, body: rpc === 'gear_prepare_intent' ? { p: {} } : rpc === 'gear_find_intent' ? { p_operation_id: randomUUID() } : {} });
    assert.ok(r.status >= 400, `${rpc} callable by the publisher: ${r.status}`);
  }
  assert.ok((await http('/rest/v1/gear_publish_intents', { token: publisher })).status >= 400, 'intents are not exposed');
});

test('Production step-up is enforced by the database at commit, not only by the function', async () => {
  // Prepare a valid Production intent exactly as the function would (service role), then commit it
  // directly with a publisher session whose TOTP verification is older than the window (40 s locally).
  await saveDraft(publisher, (c, meta) => { c.brands[0].tagline = 'step-up check'; for (const b of c.brands) meta.approvals = { ...(meta.approvals ?? {}), [b.id]: 'approved' }; });
  const p = pointer('production');
  const doc = { schemaVersion: 1, revision: randomUUID(), publishedAt: Math.max(Math.floor(Date.now() / 1000), p.publishedAt + 1) + 120, brands: draftRow().catalog.brands };
  const text = JSON.stringify(doc, null, 2) + '\n';
  const op = randomUUID();
  const old = await mfa('publisher');
  const prepared = await svc('gear_prepare_intent', { p: { operation_id: op, target: 'production', user_id: USERS.publisher.id, request_digest: 'test', revision: doc.revision,
    published_at: doc.publishedAt, document: text, digest: sha(Buffer.from(text)), summary: 'step-up test', expected_publication_id: p.publication,
    draft_version: draftRow().version, rollback_of: null, validator_version: 'test' } });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.data));
  await sleep(42_000);
  const late = await http('/rest/v1/rpc/gear_commit_publication', { method: 'POST', token: old, body: { p_operation_id: op } });
  assert.match(JSON.stringify(late.data), /mfa_step_up_required/);
  assert.equal(pointer('production').revision, p.revision);
  const fresh = await mfa('publisher');
  const ok = await http('/rest/v1/rpc/gear_commit_publication', { method: 'POST', token: fresh, body: { p_operation_id: op } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(pointer('production').revision, doc.revision);
});

// ---------------------------------------------------------------- no second channel
test('the old mutable Storage path is not a publication channel: no client can write it, and it is never served', async () => {
  const before = await catalog('staging');
  const write = await http('/storage/v1/object/recommended-gear/staging/catalog-v1.json', { method: 'POST', token: publisher, raw: true, body: '{"x":1}',
    headers: { 'Content-Type': 'application/json', 'x-upsert': 'true' } });
  assert.ok(write.status >= 400, `publisher wrote the legacy object: ${write.status}`);
  // The bucket accepts images only, so even a key holder's ordinary JSON upload is refused.
  const foreign = JSON.parse(before.body); foreign.revision = randomUUID(); foreign.publishedAt += 9999; foreign.brands = [];
  assert.equal((await serviceWrite('staging', JSON.stringify(foreign))).status, 400, 'JSON is not an allowed type');
  // A key holder can still force bytes there (mislabelled as an image), but nothing reads it as the catalog.
  const forced = await http('/storage/v1/object/recommended-gear/staging/catalog-v1.json', { method: 'POST', key: ENV.SERVICE_ROLE_KEY, token: ENV.SERVICE_ROLE_KEY,
    raw: true, body: JSON.stringify(foreign), headers: { 'Content-Type': 'image/png', 'x-upsert': 'true' } });
  assert.equal(forced.status, 200, JSON.stringify(forced.data));
  const after = await catalog('staging');
  assert.ok(after.body.equals(before.body), 'endpoint still serves the database pointer');
  const v = await fn(publisher, { action: 'verify' });
  assert.ok(v.data.info.some((i) => i.kind === 'legacy_storage_object' && i.target === 'staging'), 'verifier reports the stray object');
  assert.equal(v.data.alerts.filter((a) => a.kind !== 'image').length, 0, JSON.stringify(v.data.alerts));
  // The Storage-path RPCs are not callable, even with the service key.
  for (const rpc of ['gear_acquire_lease', 'gear_record_publication', 'gear_authorize_write']) {
    assert.ok((await svc(rpc, {})).status >= 400, `${rpc} still callable`);
  }
});

// ---------------------------------------------------------------- cache behavior and installed clients
test('delayed or cached older responses cannot regress a client that already accepted a newer publication', async () => {
  const client = new ClientModel();
  await edit('cache v1');
  await send(await reviewed('staging'));
  const v1 = await catalog('staging');           // a response that will be delivered late
  await edit('cache v2');
  await send(await reviewed('staging'));
  const v2 = await catalog('staging');
  assert.equal(client.receive(v2), 'updated');
  assert.equal(client.receive(v1), 'rejected(stale)', 'a delayed older response is rejected');
  assert.equal(client.state.document.revision, v2.revision, 'the client keeps the newer publication');
  assert.equal(client.receive({ status: 304 }), 'notModified');
  assert.equal(client.receive({ status: 404, body: '{}' }), 'httpStatus(404)');
  assert.equal(client.receive({ status: 503, body: '{}' }), 'httpStatus(503)');
  assert.equal(client.state.document.revision, v2.revision, 'no status clears or regresses it');
  assert.equal(client.receive(v2), 'unchanged');
  // A rollback to v1's content is a NEW revision with a newer publishedAt, so the client takes it.
  const v1Id = sql(`select id from public.gear_catalog_publications where revision = '${v1.revision}'`);
  await send(await reviewed('staging', { rollbackOf: v1Id }));
  const v3 = await catalog('staging');
  assert.equal(client.receive(v3), 'updated');
  assert.equal(client.receive(v2), 'rejected(stale)');
  evidence('client-model', client.log);
});

test('readers during concurrent publishing only ever see complete, digest-matching publications, never going backwards', async () => {
  const seen = [];
  let stop = false;
  const reader = (async () => { while (!stop) { const r = await catalog('staging'); seen.push(r); } })();
  for (let i = 0; i < 4; i++) { await edit(`reader ${i}`); assert.equal((await send(await reviewed('staging'))).status, 200); }
  await sleep(300);
  stop = true;
  await reader;
  const known = new Map(JSON.parse(sql(`select json_agg(json_build_array(revision, digest)) from public.gear_catalog_publications where target = 'staging'`)));
  let last = 0;
  for (const r of seen) {
    assert.equal(r.status, 200);
    const doc = JSON.parse(r.body);
    assert.equal(known.get(doc.revision), sha(r.body), 'bytes are exactly a recorded publication');
    assert.equal(r.etag.replace(/^W\//, ''), `"${sha(r.body)}"`);
    assert.ok(doc.publishedAt >= last, 'a sequential reader never goes backwards');
    last = doc.publishedAt;
  }
  evidence('readers', { responses: seen.length, distinctRevisions: new Set(seen.map((r) => r.revision)).size });
  assert.ok(new Set(seen.map((r) => r.revision)).size >= 2, 'the reader observed publications change');
});

test('verifier (on demand, read-only): pointer, digest and endpoint agree; nothing is repaired or deleted', async () => {
  const v = await fn(publisher, { action: 'verify' });
  assert.equal(v.status, 200);
  for (const t of ['staging', 'production']) {
    assert.equal(v.data.targets[t].endpoint.status, 200);
    assert.equal(v.data.targets[t].endpoint.etag.replace(/^W\//, ''), `"${pointer(t).digest}"`);
  }
  assert.deepEqual(v.data.alerts.filter((a) => !['image'].includes(a.kind)), []);
  assert.equal(v.data.alertDelivery.configured, false);
});
