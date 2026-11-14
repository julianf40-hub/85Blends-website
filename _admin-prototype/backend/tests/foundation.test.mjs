// Integration tests against the LOCAL Supabase stack (fictional data only).
//
//   cd _admin-prototype/backend && supabase start && node --test tests/
//
// Resets the local database first. Uses real Auth (password sign-in + TOTP enrollment and
// verification), PostgREST/RLS, Storage and the gear-publish Edge Function.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { USERS, LOCAL_TEST_PASSWORD, LOCAL_STEP_UP_SECONDS } from '../tools/make-seed.mjs';

import { review, grantFor, latestDocument, latestPublicationId, DIR, ENV, base32, claims, directWrite, draftRow, factors, fn, head, http, mfa, objectPath, publicRead, publish, resetLocalDatabase, saveDraft, serviceWrite, sessions, sh, signIn, sleep, sql, sqlError, svc, totp } from './helpers.mjs';

let publisher; // aal2 session of the pinned publisher

before(async () => {
  resetLocalDatabase();
  await sleep(3000); // let PostgREST reload its schema cache after the reset
  publisher = await mfa('publisher');
});

// ---------------------------------------------------------------- shared contract
test('shared modules in the function are byte-identical to the prototype lib', () => {
  for (const f of ['validator.mjs', 'diff.mjs']) {
    assert.ok(readFileSync(new URL(`../supabase/functions/_shared/${f}`, import.meta.url)).equals(readFileSync(new URL(`../../lib/${f}`, import.meta.url))), f);
  }
});

// ---------------------------------------------------------------- Auth / MFA
test('real TOTP: password sign-in is aal1; verifying a TOTP challenge yields aal2 with a totp amr entry', async () => {
  const aal1 = await signIn('publisher');
  assert.equal(claims(aal1).aal, 'aal1');
  assert.equal(claims(publisher).aal, 'aal2');
  assert.ok(claims(publisher).amr.some((m) => m.method === 'totp'));
  const wrong = await http(`/auth/v1/factors/${factors.publisher.id}/challenge`, { method: 'POST', token: aal1, body: {} });
  const bad = await http(`/auth/v1/factors/${factors.publisher.id}/verify`, { method: 'POST', token: aal1, body: { challenge_id: wrong.data.id, code: '000000' === totp(factors.publisher.secret) ? '111111' : '000000' } });
  assert.notEqual(bad.status, 200);
});

test('sign-ups are disabled', async () => {
  const r = await http('/auth/v1/signup', { method: 'POST', body: { email: 'new@example.test', password: LOCAL_TEST_PASSWORD } });
  assert.notEqual(r.status, 200);
});

// ---------------------------------------------------------------- RLS and grants
test('RLS: anon and aal1 see nothing; aal2 admins can read; outsiders cannot', async () => {
  const anon = await http('/rest/v1/gear_catalog_drafts?select=version');
  assert.ok(anon.status >= 400 || (Array.isArray(anon.data) && anon.data.length === 0), JSON.stringify(anon));
  const aal1 = await http('/rest/v1/gear_catalog_drafts?select=version', { token: await signIn('publisher') });
  assert.deepEqual(aal1.data, []);
  const aal2 = await http('/rest/v1/gear_catalog_drafts?select=version', { token: publisher });
  assert.equal(aal2.data.length, 1);
  const outsider = await http('/rest/v1/gear_catalog_drafts?select=version', { token: await mfa('outsider') });
  assert.deepEqual(outsider.data, []);
});

test('clients cannot write tables or call the service-only publication RPCs', async () => {
  const insert = await http('/rest/v1/gear_admins', { method: 'POST', token: publisher, body: { user_id: USERS.outsider.id, role: 'editor' } });
  assert.ok(insert.status >= 400, JSON.stringify(insert));
  for (const rpc of ['gear_acquire_lease', 'gear_record_publication', 'gear_record_status', 'gear_record_drift_ack', 'gear_audit']) {
    const r = await http(`/rest/v1/rpc/${rpc}`, { method: 'POST', token: publisher, body: {} });
    assert.ok(r.status >= 400, `${rpc}: ${r.status}`);
  }
});

// ---------------------------------------------------------------- draft concurrency
test('save_gear_draft: aal2 admins only, optimistic version lock, server-stamped fields stripped', async () => {
  assert.equal((await saveDraft(await signIn('editor'))).status, 403); // aal1
  assert.equal((await saveDraft(await mfa('outsider'))).status, 403); // not an admin
  const editor = await mfa('editor');
  const before = draftRow().version;
  const ok = await saveDraft(editor, (c) => { c.revision = 'browser-set'; c.publishedAt = 9_999_999_999; c.brands[0].priceText = 'From $77'; });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.version, before + 1);
  assert.equal(ok.data.catalog.revision, undefined);
  assert.equal(ok.data.catalog.publishedAt, undefined);
  const stale = await http('/rest/v1/rpc/save_gear_draft', { method: 'POST', token: publisher, body: { expected_version: before, new_catalog: ok.data.catalog, new_meta: ok.data.meta } });
  assert.equal(stale.status, 409, JSON.stringify(stale.data));
  // two concurrent saves from the same base: exactly one wins
  const base = draftRow();
  const [a, b] = await Promise.all([publisher, editor].map((t) => http('/rest/v1/rpc/save_gear_draft', { method: 'POST', token: t, body: { expected_version: base.version, new_catalog: base.catalog, new_meta: base.meta } })));
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
});

// ---------------------------------------------------------------- database guarantees
test('DB: one publisher only; publications require the publisher, aal2, a matching digest, JSON matching the row, increasing publishedAt; append-only', () => {
  assert.match(sqlError(`insert into public.gear_admins (user_id, role) values ('${USERS.spare.id}', 'publisher')`), /gear_admins_single_publisher/);
  // a document that matches its row: schemaVersion 1, revision, publishedAt, brands array
  const docFor = (rev, at) => JSON.stringify({ schemaVersion: 1, revision: rev, publishedAt: at, brands: [] });
  const row = (by, aal, at, { rev = crypto.randomUUID(), doc = docFor(rev, at), digest } = {}) => `insert into public.gear_catalog_publications (target, revision, published_at, document, digest, summary, validator_version, published_by, auth_aal)
    values ('staging', '${rev}', ${at}, '${doc}', ${digest ?? `encode(sha256(convert_to('${doc}', 'UTF8')), 'hex')`}, 't', 't', '${by}', '${aal}')`;
  assert.match(sqlError(row(USERS.editor.id, 'aal2', 1)), /authored by the publisher/);
  assert.match(sqlError(row(USERS.publisher.id, 'aal1', 1)), /aal2/);
  assert.match(sqlError(row(USERS.publisher.id, 'aal2', 1, { digest: `'00'` })), /digest/);
  assert.match(sqlError(row(USERS.publisher.id, 'aal2', 1, { doc: '{}' })), /does not match the publication row/);
  assert.match(sqlError(row(USERS.publisher.id, 'aal2', 1, { doc: docFor(crypto.randomUUID(), 1) })), /does not match the publication row/); // revision mismatch
  assert.match(sqlError(row(USERS.publisher.id, 'aal2', 1, { doc: 'not json' })), /not JSON/);
  sql(row(USERS.publisher.id, 'aal2', 1000));
  assert.match(sqlError(row(USERS.publisher.id, 'aal2', 1000)), /strictly increase/);
  assert.match(sqlError(`update public.gear_catalog_publications set summary = 'x'`), /append-only/);
  assert.match(sqlError(`delete from public.gear_catalog_publications`), /append-only/);
  // remove the probe row for the rest of the suite (superuser maintenance path, trigger disabled explicitly)
  sql(`alter table public.gear_catalog_publications disable trigger gear_publications_append_only;
       delete from public.gear_catalog_publications; alter table public.gear_catalog_publications enable trigger gear_publications_append_only;`);
});

// ---------------------------------------------------------------- Storage writes
// Storage RLS write checks live in tests/bypass.test.mjs (they need a recorded publication to authorize).

// ---------------------------------------------------------------- function authorization
test('gear-publish: editor, aal1, outsider and signed-out sessions are refused', async () => {
  assert.equal((await publish(await mfa('editor'), 'staging')).data.error, 'publisher_required');
  assert.equal((await publish(await signIn('publisher'), 'staging')).data.error, 'mfa_required');
  assert.equal((await publish(await mfa('outsider'), 'staging')).data.error, 'not_admin');
  const session = await mfa('publisher');
  assert.equal((await http('/auth/v1/logout?scope=local', { method: 'POST', token: session })).status, 204);
  const afterLogout = await publish(session, 'staging');
  assert.equal(afterLogout.status, 401, JSON.stringify(afterLogout.data));
});

test('gear-publish: the publisher role alone is not enough; the pinned publisher ID must match too', async () => {
  sql(`delete from public.gear_admins where user_id = '${USERS.publisher.id}'; insert into public.gear_admins (user_id, role) values ('${USERS.spare.id}', 'publisher');`);
  try {
    assert.equal((await publish(await mfa('spare'), 'staging')).data.error, 'publisher_not_pinned');
    assert.equal((await publish(publisher, 'staging')).data.error, 'not_admin');
  } finally {
    sql(`delete from public.gear_admins where user_id = '${USERS.spare.id}'; insert into public.gear_admins (user_id, role) values ('${USERS.publisher.id}', 'publisher');`);
  }
});

// ---------------------------------------------------------------- publishing
