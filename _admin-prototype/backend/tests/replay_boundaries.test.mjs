// Replay boundaries under the duplicate-request race (current design). A request that looked its
// operation up BEFORE the original committed must still be refused when it differs in environment or
// request fingerprint: with the intent present (normal check) and after cleanup (the fallback path that
// re-reads the operation when gear_prepare_intent refuses). The publisher boundary is checked at the
// database, because only the single pinned publisher can reach the function at all.
// The four races need the test-only pause_after_lookup fault: the only way to make a request's lookup run
// before the original commits, deterministically. The package has no such hook, so they skip there; the
// function code they reach (the prepare fallback) runs only under real concurrency.
// The database half of both paths runs against the package too (tools/check-deploy-package.sh), through
// the service-role RPCs gear-publish itself calls and the real cleanup (gear_cleanup_operations).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { USERS } from '../tools/make-seed.mjs';
import { draftRow, fn, head, mfa, needsFaults, review, resetLocalDatabase, saveDraft, sleep, sql, svc } from './helpers.mjs';

let publisher;
before(async () => {
  resetLocalDatabase(); await sleep(3000);
  publisher = await mfa('publisher');
  await saveDraft(publisher, (c, meta) => { for (const b of c.brands) meta.approvals = { ...(meta.approvals ?? {}), [b.id]: 'approved' }; });
});
const ev = (n, d) => console.log('EVIDENCE ' + n + ' ' + JSON.stringify(d));
const total = (t) => Number(sql("select count(*) from public.gear_catalog_publications" + (t ? " where target = '" + t + "'" : '')));
let n = 0;
const edit = () => saveDraft(publisher, (c) => { c.brands[0].tagline = 'fallback ' + (++n); });
async function body(target, extra = {}) {
  const r = await review(publisher, target, extra.rollbackOf ? { rollbackOf: extra.rollbackOf } : {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { target, draftVersion: draftRow().version, expectedLiveRevision: head(target).revision, reviewDigest: r.data.reviewDigest,
    confirmation: target === 'production' ? 'PUBLISH PRODUCTION' : undefined, operationId: randomUUID(), ...extra };
}
const send = (b, h = {}) => fn(publisher, { action: b.rollbackOf ? 'rollback' : 'publish', ...b, publicationId: b.rollbackOf }, h);
const deleteIntent = (op) => sql("delete from private.gear_publish_intents where operation_id = '" + op + "'");

for (const cleanup of [false, true]) {
  test('environment: a Production request racing a committed Staging operation with the same ID is refused' + (cleanup ? ' (after cleanup: fallback path)' : ' (intent present)'), { skip: needsFaults }, async () => {
    publisher = await mfa('publisher');
    await edit();
    const staging = await body('staging');
    const prod = { ...(await body('production')), operationId: staging.operationId };
    const before = total();
    const racing = send(prod, { 'x-gear-test-fault': 'pause_after_lookup:3000' }); // looks up first: nothing yet
    await sleep(800);
    const committed = await send(staging);
    assert.equal(committed.status, 200, JSON.stringify(committed.data));
    if (cleanup) deleteIntent(staging.operationId);
    const r = await racing;
    ev('fallback-environment-' + cleanup, { status: r.status, error: r.data.error });
    assert.equal(r.status, 409); assert.equal(r.data.error, 'operation_conflict');
    assert.equal(total('production'), 0); assert.equal(total(), before + 1);
  });

  test('fingerprint: a rollback racing a committed publish with the same ID is refused' + (cleanup ? ' (after cleanup: fallback path)' : ' (intent present)'), { skip: needsFaults }, async () => {
    await edit();
    const pub = await body('staging');
    await send(pub); // something to roll back to
    await edit();
    const forward = await body('staging');
    const source = sql("select id from public.gear_catalog_publications where target = 'staging' order by published_at limit 1");
    const rollback = { ...(await body('staging', { rollbackOf: source })), operationId: forward.operationId };
    const before = total();
    const racing = send(rollback, { 'x-gear-test-fault': 'pause_after_lookup:3000' });
    await sleep(800);
    const committed = await send(forward);
    assert.equal(committed.status, 200, JSON.stringify(committed.data));
    if (cleanup) deleteIntent(forward.operationId);
    const r = await racing;
    ev('fallback-fingerprint-' + cleanup, { status: r.status, error: r.data.error });
    assert.equal(r.status, 409); assert.equal(r.data.error, 'operation_conflict');
    assert.equal(total(), before + 1);
  });
}

// Cleanup as it runs in production: committed intents older than the retention are deleted by
// gear_cleanup_operations (the age is set directly, as in operations.test.mjs).
async function cleanUpCommitted(op) {
  sql("update private.gear_publish_intents set created_at = now() - interval '30 days' where operation_id = '" + op + "'");
  const cleaned = await svc('gear_cleanup_operations', {});
  assert.equal(cleaned.status, 200, JSON.stringify(cleaned.data));
  assert.ok(cleaned.data.committedDeleted >= 1);
  assert.equal(sql("select count(*) from private.gear_publish_intents where operation_id = '" + op + "'"), '0', 'committed intent removed by cleanup');
}

test('database half, intent present: preparing a committed operation ID for another environment or request returns the original intent unchanged', async () => {
  // gear-publish's check after prepare (!intent.created && !sameRequest(intent)) relies on this answer.
  await edit();
  const b = await body('staging');
  const c = await send(b);
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const stored = JSON.parse(sql("select json_build_object('target', target, 'user_id', user_id, 'request_digest', request_digest, 'publication_id', publication_id) from private.gear_publish_intents where operation_id = '" + b.operationId + "'"));
  const before = total();
  const attempt = (over) => svc('gear_prepare_intent', { p: { operation_id: b.operationId, target: 'staging', user_id: USERS.publisher.id, request_digest: stored.request_digest,
    revision: randomUUID(), published_at: Math.floor(Date.now() / 1000) + 5, document: '{}', digest: createHash('sha256').update('{}').digest('hex'), summary: 'race',
    expected_publication_id: null, draft_version: draftRow().version, rollback_of: null, validator_version: 'test', ...over } });
  const results = {};
  for (const [k, over] of Object.entries({ production: { target: 'production' }, otherFingerprint: { request_digest: 'f'.repeat(64) }, otherAccount: { user_id: USERS.spare.id } })) {
    const r = await attempt(over);
    assert.equal(r.status, 200, k + ' ' + JSON.stringify(r.data));
    results[k] = r.data;
    assert.equal(r.data.created, false, k);
    assert.equal(r.data.target, stored.target, k); assert.equal(r.data.user_id, stored.user_id, k);
    assert.equal(r.data.request_digest, stored.request_digest, k); assert.equal(r.data.publication_id, stored.publication_id, k);
  }
  ev('database-intent-present', Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { created: v.created, target: v.target }])));
  const storedNow = JSON.parse(sql("select json_build_object('target', target, 'user_id', user_id, 'request_digest', request_digest, 'publication_id', publication_id) from private.gear_publish_intents where operation_id = '" + b.operationId + "'"));
  assert.deepEqual(storedNow, stored, 'stored intent unchanged');
  assert.equal(total(), before, 'nothing published');
});

test('publisher: after cleanup, the database refuses to bind a committed operation ID to any account, and lookup keeps the original publisher', async () => {
  await edit();
  const b = await body('staging');
  assert.equal((await send(b)).status, 200);
  await cleanUpCommitted(b.operationId);
  const found = (await svc('gear_find_operation', { p_operation_id: b.operationId })).data;
  assert.equal(found.state, 'committed'); assert.equal(found.user_id, USERS.publisher.id);
  assert.equal(found.target, 'staging', 'lookup keeps the original environment');
  const other = await svc('gear_prepare_intent', { p: { operation_id: b.operationId, target: 'staging', user_id: USERS.spare.id, request_digest: 'x' } });
  ev('fallback-publisher', { found: { state: found.state, samePublisher: found.user_id === USERS.publisher.id }, otherAccount: other.data?.message?.slice(0, 60) });
  assert.match(JSON.stringify(other.data), /operation_conflict/);
  const production = await svc('gear_prepare_intent', { p: { operation_id: b.operationId, target: 'production', user_id: USERS.publisher.id, request_digest: 'x' } });
  assert.match(JSON.stringify(production.data), /operation_conflict/, 'nor to another environment');
});
