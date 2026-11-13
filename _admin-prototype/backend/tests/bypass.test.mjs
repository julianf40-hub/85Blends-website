// Bypass review: a caller who skips gear-publish and talks to PostgREST / Storage directly.
// Asserts the secure outcome, except B9, which pins a documented limitation of Storage RLS.
// Run serially with the main suite (shared local database):
//   node --test --test-concurrency=1 tests/*.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { USERS } from '../tools/make-seed.mjs';
import { directWrite, fn, grantFor, http, latestDocument, mfa, publicRead, publish, resetLocalDatabase, saveDraft, signIn, sleep, sql, svc } from './helpers.mjs';

let publisher;

before(async () => {
  resetLocalDatabase();
  await sleep(3000);
  publisher = await mfa('publisher');
  await saveDraft(publisher, (c, m) => { for (const b of c.brands) m.approvals[b.id] = 'approved'; });
  for (const target of ['staging', 'production']) {
    const r = await publish(publisher, target);
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
});

test('B1: lease tokens and prepared versions are not readable over REST (fixed; readable at f7d2a3c)', async () => {
  await saveDraft(publisher, (c) => { c.brands[0].priceText = 'From $201'; });
  const crashed = await publish(publisher, 'staging', {}, { 'x-gear-test-fault': 'crash_after_commit' }); // leaves a live lease
  assert.equal(crashed.status, 500);
  for (const column of ['lease_token', 'lease_expires_at', 'expected_object_version', 'expected_object_known']) {
    const r = await http(`/rest/v1/gear_publication_head?select=target,${column}`, { token: publisher });
    assert.ok(r.status >= 400, `${column} readable: ${r.status} ${JSON.stringify(r.data)}`);
  }
  const visible = await http('/rest/v1/gear_publication_head?select=target,revision,published_at,digest', { token: publisher });
  assert.equal(visible.status, 200);
  assert.equal(visible.data.length, 2);
  await sleep(7000);
  assert.equal((await fn(publisher, { action: 'reconcile', target: 'staging' })).data.state, 'repaired');
});

test('B2: the publisher cannot acquire a lease, prepare, or issue a write grant', async () => {
  for (const [rpc, body] of [['gear_acquire_lease', { p_target: 'staging', p_ttl_seconds: 30 }], ['gear_prepare_write', { p_token: crypto.randomUUID(), p_target: 'staging' }],
    ['gear_authorize_write', { p_token: crypto.randomUUID(), p_target: 'staging', p_publication_id: crypto.randomUUID(), p_user_id: USERS.publisher.id }]]) {
    const r = await http(`/rest/v1/rpc/${rpc}`, { method: 'POST', token: publisher, body });
    assert.ok(r.status >= 400, `${rpc}: ${r.status}`);
  }
});

test('B3: a leaked lease token is not a write grant; without the nonce nothing is written', async () => {
  const grant = await grantFor('staging');
  try {
    const w = await directWrite('staging', publisher, grant.lease, latestDocument('staging'));
    assert.ok(w.status >= 400, `lease token accepted as grant: ${w.status}`);
  } finally { await grant.release(); }
});

test('B4: a spent grant read back from object metadata cannot be replayed', async () => {
  await saveDraft(publisher, (c) => { c.brands[0].priceText = 'From $204'; });
  assert.equal((await publish(publisher, 'staging')).status, 200);
  const info = await http('/storage/v1/object/info/authenticated/recommended-gear/staging/catalog-v1.json', { token: publisher });
  const nonce = (info.data?.user_metadata ?? info.data?.metadata?.user_metadata ?? {}).gear_write ?? sql(`select user_metadata ->> 'gear_write' from storage.objects where name = 'staging/catalog-v1.json'`);
  assert.ok(nonce, 'nonce present after the write');
  const w = await directWrite('staging', publisher, nonce, latestDocument('staging'));
  assert.ok(w.status >= 400, `replayed spent grant: ${w.status}`);
});

test('B5: environment and path binding: a Staging grant cannot write Production', async () => {
  const staging = await grantFor('staging');
  const production = await grantFor('production');
  try {
    publisher = await mfa('publisher');
    const w = await directWrite('production', publisher, staging.nonce, latestDocument('production'));
    assert.ok(w.status >= 400, `staging grant wrote production: ${w.status}`);
    const other = await http('/storage/v1/object/recommended-gear/staging/other.json', { method: 'POST', token: publisher, body: '{}', raw: true,
      headers: { 'Content-Type': 'application/json', 'x-metadata': Buffer.from(JSON.stringify({ gear_write: staging.nonce })).toString('base64') } });
    assert.ok(other.status >= 400, `grant used for another path: ${other.status}`);
  } finally { await staging.release(); await production.release(); }
});

test('B6: publication binding: the declared size must match the authorized publication', async () => {
  const grant = await grantFor('staging');
  try {
    const w = await directWrite('staging', publisher, grant.nonce, latestDocument('staging') + '   ');
    assert.ok(w.status >= 400, `different size accepted: ${w.status}`);
  } finally { await grant.release(); }
});

test('B7: expired and released grants are refused; a positive control succeeds once (then CAS)', async () => {
  const short = await grantFor('staging', 1);
  await sleep(2000);
  assert.ok((await directWrite('staging', publisher, short.nonce, latestDocument('staging'))).status >= 400, 'expired');
  await short.release();
  const grant = await grantFor('staging');
  await grant.release();
  assert.ok((await directWrite('staging', publisher, grant.nonce, latestDocument('staging'))).status >= 400, 'released');
  const live = await grantFor('staging');
  try {
    assert.equal((await directWrite('staging', publisher, live.nonce, latestDocument('staging'))).status, 200, 'positive control');
    assert.ok((await directWrite('staging', publisher, live.nonce, latestDocument('staging'))).status >= 400, 'second use refused (CAS)');
  } finally { await live.release(); }
});

test('B8: authorization changes are enforced: no aal2, an editor, a removed or swapped publisher', async () => {
  const grant = await grantFor('staging');
  try {
    assert.ok((await directWrite('staging', await signIn('publisher'), grant.nonce, latestDocument('staging'))).status >= 400, 'aal1');
    assert.ok((await directWrite('staging', await mfa('editor'), grant.nonce, latestDocument('staging'))).status >= 400, 'editor');
    publisher = await mfa('publisher');
    sql(`delete from public.gear_admins where user_id = '${USERS.publisher.id}'`);
    assert.ok((await directWrite('staging', publisher, grant.nonce, latestDocument('staging'))).status >= 400, 'role removed');
    const refused = await svc('gear_authorize_write', { p_token: grant.lease, p_target: 'staging', p_publication_id: sql(`select id from public.gear_catalog_publications where target = 'staging' order by published_at desc limit 1`), p_user_id: USERS.publisher.id });
    assert.equal(refused.status, 403, 'no grant is issued while the publisher role is missing');
    sql(`insert into public.gear_admins (user_id, role) values ('${USERS.spare.id}', 'publisher')`);
    assert.ok((await directWrite('staging', await mfa('spare'), grant.nonce, latestDocument('staging'))).status >= 400, 'swapped publisher: the grant is bound to the account it was issued for');
  } catch (error) {
    throw error;
  } finally {
    sql(`delete from public.gear_admins where user_id = '${USERS.spare.id}'; insert into public.gear_admins (user_id, role) values ('${USERS.publisher.id}', 'publisher') on conflict do nothing;`);
    await grant.release();
  }
  // through the function: authorization removed while it is paused after its commit
  publisher = await mfa('publisher');
  await saveDraft(publisher, (c) => { c.brands[0].priceText = 'From $208'; });
  const before = (await publicRead('staging')).data.revision;
  // the grant is issued, then the role is removed before the upload starts: Storage RLS must refuse
  const pending = publish(publisher, 'staging', {}, { 'x-gear-test-fault': 'pause_before_upload:2500' });
  const committedBy = Date.now() + 2000;
  while (sql(`select revision::text from public.gear_publication_head where target = 'staging'`) === before && Date.now() < committedBy) await sleep(50);
  sql(`delete from public.gear_admins where user_id = '${USERS.publisher.id}'`);
  const r = await pending;
  sql(`insert into public.gear_admins (user_id, role) values ('${USERS.publisher.id}', 'publisher') on conflict do nothing`);
  assert.equal(r.data.error, 'storage_write_rejected', JSON.stringify(r.data));
  assert.equal((await publicRead('staging')).data.revision, before, 'served object unchanged');
  await sleep(7000);
  assert.equal((await fn(publisher, { action: 'reconcile', target: 'staging' })).data.state, 'repaired');
});

test('B9: different bytes of the same size with a live grant: refused at commit by the content check (was accepted before the commit guard)', async () => {
  // The RLS dry run sees only the declared length, so it passes. The candidate commit guard
  // (migration 20261113220000) compares the stored size and eTag (MD5 of the bytes) with the
  // recorded publication inside Storage's committing transaction, and refuses.
  const servedBefore = (await publicRead('staging')).data?.revision;
  const versionBefore = sql(`select version from storage.objects where bucket_id = 'recommended-gear' and name = 'staging/catalog-v1.json'`);
  const grant = await grantFor('staging');
  let write;
  try {
    const original = latestDocument('staging');
    const sameSize = original.replace(/"From \$\d{3}"/, '"From $999"');
    assert.equal(Buffer.byteLength(sameSize), Buffer.byteLength(original));
    assert.notEqual(sameSize, original);
    write = await directWrite('staging', publisher, grant.nonce, sameSize);
  } finally { await grant.release(); }
  assert.equal(write.status, 500, JSON.stringify(write.data)); // Storage reports the trigger's PT403 as a DatabaseError
  assert.match(JSON.stringify(write.data), /PT403/);
  assert.equal(sql(`select version from storage.objects where bucket_id = 'recommended-gear' and name = 'staging/catalog-v1.json'`), versionBefore, 'row unchanged');
  assert.equal((await publicRead('staging')).data?.revision, servedBefore, 'served bytes unchanged');
  assert.equal((await fn(publisher, { action: 'inspect', target: 'staging' })).data.state, 'in_sync');
});
