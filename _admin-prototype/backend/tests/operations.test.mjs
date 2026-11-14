// Operation IDs are bound to the publisher, the environment and the request content; retries never
// cross those boundaries, before or after cleanup. Pending-operation cleanup keeps committed replay
// protection. (Current design, D10 option 2; LOCAL stack, fictional data.)
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { USERS } from '../tools/make-seed.mjs';
import { draftRow, fn, head, http, mfa, review, resetLocalDatabase, saveDraft, sleep, sql, svc  } from './helpers.mjs';

let publisher;
before(async () => {
  resetLocalDatabase();
  await sleep(3000);
  publisher = await mfa('publisher');
  await saveDraft(publisher, (c, meta) => { for (const b of c.brands) meta.approvals = { ...(meta.approvals ?? {}), [b.id]: 'approved' }; });
});

const evidence = (name, data) => console.log(`EVIDENCE ${name} ${JSON.stringify(data)}`);
const total = () => Number(sql(`select count(*) from public.gear_catalog_publications`));
let n = 0;
const edit = () => saveDraft(publisher, (c) => { c.brands[0].tagline = `operation test ${++n}`; });
async function body(target, extra = {}) {
  const r = await review(publisher, target, extra.rollbackOf ? { rollbackOf: extra.rollbackOf } : {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { target, draftVersion: draftRow().version, expectedLiveRevision: head(target).revision, reviewDigest: r.data.reviewDigest,
    confirmation: target === 'production' ? 'PUBLISH PRODUCTION' : undefined, operationId: randomUUID(), ...extra };
}
// Mirrors gear-publish requestFingerprint(): the request content an operation ID is bound to.
const fingerprint = (b) => createHash('sha256').update(JSON.stringify({
  target: b.target, action: b.rollbackOf ? 'rollback' : 'publish', reviewDigest: b.reviewDigest ?? null,
  draftVersion: b.rollbackOf ? null : b.draftVersion ?? null, expectedLiveRevision: b.expectedLiveRevision ?? null, rollbackOf: b.rollbackOf ?? null,
})).digest('hex');
/** Prepares a pending (uncommitted) operation for a request exactly as gear-publish does (service role). */
async function preparePending(b) {
  const h = JSON.parse(sql(`select json_build_object('id', current_publication_id, 'at', published_at) from public.gear_publication_head where target = '${b.target}'`));
  const doc = { schemaVersion: 1, revision: randomUUID(), publishedAt: Math.max(Math.floor(Date.now() / 1000), (h.at ?? 0) + 1), brands: draftRow().catalog.brands };
  const text = JSON.stringify(doc, null, 2) + '\n';
  const r = await svc('gear_prepare_intent', { p: { operation_id: b.operationId, target: b.target, user_id: USERS.publisher.id, request_digest: fingerprint(b),
    revision: doc.revision, published_at: doc.publishedAt, document: text, digest: createHash('sha256').update(text).digest('hex'), summary: 'pending test operation',
    expected_publication_id: h.id, draft_version: b.rollbackOf ? null : draftRow().version, rollback_of: b.rollbackOf ?? null, validator_version: 'test' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}
const send = (b, token = publisher) => fn(token, { action: b.rollbackOf ? 'rollback' : 'publish', ...b, publicationId: b.rollbackOf });

test('environment boundary: a Staging operation ID cannot be used for Production (before or after it committed)', async () => {
  publisher = await mfa('publisher'); // Production calls need a TOTP within the step-up window
  await edit();
  const staging = await body('staging');
  const before = total();
  // Pending: prepared but not yet committed.
  await preparePending(staging);
  const crossPending = await send({ ...(await body('production')), operationId: staging.operationId });
  assert.equal((await send(staging)).status, 200, 'the Staging request commits its own pending operation');
  const crossCommitted = await send({ ...(await body('production')), operationId: staging.operationId });
  evidence('cross-environment', { pending: crossPending.data.error, committed: crossCommitted.data.error });
  assert.equal(crossPending.data.error, 'operation_conflict');
  assert.equal(crossCommitted.data.error, 'operation_conflict');
  assert.equal(total(), before + 1, 'only the Staging publication');
  assert.equal(Number(sql(`select count(*) from public.gear_catalog_publications where target = 'production'`)), 0);
  const replay = await send(staging);
  assert.equal(replay.status, 200); assert.equal(replay.data.replayed, true); assert.equal(replay.data.target, 'staging');
});

test('content boundary: the same operation ID with different request content is refused, field by field', async () => {
  await edit();
  const original = await body('staging');
  assert.equal((await send(original)).status, 200);
  const before = total();
  const variants = {
    reviewDigest: { ...original, reviewDigest: '0'.repeat(64) },
    draftVersion: { ...original, draftVersion: original.draftVersion + 1 },
    expectedLiveRevision: { ...original, expectedLiveRevision: randomUUID() },
    asRollback: { ...original, rollbackOf: sql(`select id from public.gear_catalog_publications where target = 'staging' order by published_at limit 1`) },
  };
  const results = {};
  for (const [k, v] of Object.entries(variants)) results[k] = (await send(v)).data.error;
  evidence('content-variants', results);
  for (const [k, e] of Object.entries(results)) assert.equal(e, 'operation_conflict', k);
  assert.equal(total(), before);
  assert.equal((await send(original)).data.replayed, true, 'the original request still replays');
});

test('publisher boundary: another account cannot commit or replay someone else\'s operation (database and function)', async () => {
  await edit();
  // A pending intent prepared for the publisher exactly as gear-publish would (service role).
  const op = randomUUID();
  const p = JSON.parse(sql(`select json_build_object('id', current_publication_id, 'at', published_at) from public.gear_publication_head where target = 'staging'`));
  const doc = { schemaVersion: 1, revision: randomUUID(), publishedAt: Math.max(Math.floor(Date.now() / 1000), p.at + 1), brands: draftRow().catalog.brands };
  const text = JSON.stringify(doc, null, 2) + '\n';
  const prep = await svc('gear_prepare_intent', { p: { operation_id: op, target: 'staging', user_id: USERS.publisher.id, request_digest: 'fingerprint', revision: doc.revision,
    published_at: doc.publishedAt, document: text, digest: createHash('sha256').update(text).digest('hex'), summary: 'publisher boundary', expected_publication_id: p.id,
    draft_version: draftRow().version, rollback_of: null, validator_version: 'test' } });
  assert.equal(prep.status, 200, JSON.stringify(prep.data));
  // Swap the publisher role to the spare account (single-publisher rule), then try to commit as them.
  sql(`delete from public.gear_admins where user_id = '${USERS.publisher.id}'; insert into public.gear_admins (user_id, role) values ('${USERS.spare.id}', 'publisher');`);
  try {
    const spare = await mfa('spare');
    const viaDb = await http('/rest/v1/rpc/gear_commit_publication', { method: 'POST', token: spare, body: { p_operation_id: op } });
    const viaFn = await fn(spare, { action: 'publish', target: 'staging', operationId: op, reviewDigest: 'x', draftVersion: draftRow().version, expectedLiveRevision: head('staging').revision });
    evidence('cross-publisher', { database: viaDb.data?.message, function: viaFn.data.error });
    assert.match(viaDb.data.message, /^not_your_operation/);
    assert.equal(viaFn.data.error, 'publisher_not_pinned', 'the function refuses any account other than the pinned publisher first');
    assert.equal(sql(`select publication_id is null from private.gear_publish_intents where operation_id = '${op}'`), 't');
  } finally {
    sql(`delete from public.gear_admins where user_id = '${USERS.spare.id}'; insert into public.gear_admins (user_id, role) values ('${USERS.publisher.id}', 'publisher');`);
  }
});

test('cleanup: expired pending operations are removed; committed operations keep replay protection and their boundaries', async () => {
  publisher = await mfa('publisher');
  await edit();
  const committed = await body('staging');
  const c = await send(committed);
  assert.equal(c.status, 200);
  // A pending operation whose request was abandoned (its client never retried), expired 2 hours ago.
  await edit();
  const abandoned = await body('staging');
  await preparePending(abandoned);
  sql(`update private.gear_publish_intents set expires_at = now() - interval '2 hours' where operation_id = '${abandoned.operationId}'`);
  const late = await send(abandoned); // a retry before cleanup finds the operation expired
  assert.equal(late.data.error, 'operation_expired');
  // A fresh pending operation that must survive cleanup.
  const fresh = randomUUID();
  sql(`insert into private.gear_publish_intents (operation_id, target, user_id, request_digest, revision, published_at, document, digest, summary, draft_version, validator_version, expires_at)
       select '${fresh}', 'staging', '${USERS.publisher.id}', 'x', gen_random_uuid(), 1, '{}', encode(sha256(convert_to('{}', 'UTF8')), 'hex'), 'fresh', 1, 'test', now() + interval '10 minutes'`);
  // Make every committed intent "old" so cleanup removes them too.
  sql(`update private.gear_publish_intents set created_at = now() - interval '30 days' where publication_id is not null`);

  assert.ok((await http('/rest/v1/rpc/gear_cleanup_operations', { method: 'POST', token: publisher, body: {} })).status >= 400, 'not callable by clients');
  const cleaned = await svc('gear_cleanup_operations', {});
  evidence('cleanup', cleaned.data);
  assert.ok(cleaned.data.pendingDeleted >= 1); assert.ok(cleaned.data.committedDeleted >= 1);
  assert.equal(sql(`select count(*) from private.gear_publish_intents where operation_id = '${abandoned.operationId}'`), '0');
  assert.equal(sql(`select count(*) from private.gear_publish_intents where operation_id = '${fresh}'`), '1', 'unexpired pending kept');
  assert.equal(sql(`select count(*) from private.gear_publish_intents where operation_id = '${committed.operationId}'`), '0', 'committed intent removed');

  // Replay after cleanup: recognized from the append-only publication; never a second publication.
  const before = total();
  const replay = await send(committed);
  assert.equal(replay.status, 200); assert.equal(replay.data.replayed, true); assert.equal(replay.data.revision, c.data.revision);
  assert.equal(total(), before);
  // Boundaries still hold after cleanup.
  assert.equal((await send({ ...(await body('production')), operationId: committed.operationId })).data.error, 'operation_conflict');
  assert.equal((await send({ ...committed, reviewDigest: '1'.repeat(64) })).data.error, 'operation_conflict');
  // The cleaned abandoned operation never committed: a retry is a fresh attempt, bound to the same
  // fingerprint and re-checked against the current state. Nothing moved, so it commits exactly once;
  // a further retry replays it.
  const retryAbandoned = await send(abandoned);
  assert.equal(retryAbandoned.status, 200, JSON.stringify(retryAbandoned.data)); assert.equal(retryAbandoned.data.replayed, false);
  const again = await send(abandoned);
  assert.equal(again.data.replayed, true); assert.equal(again.data.revision, retryAbandoned.data.revision);
  assert.equal(total(), before + 1);
  sql(`delete from private.gear_publish_intents where operation_id = '${fresh}'`);
});
