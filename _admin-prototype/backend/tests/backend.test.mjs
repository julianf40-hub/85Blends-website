// Integration tests against the LOCAL Supabase stack (fictional data only).
//
//   cd _admin-prototype/backend && supabase start && node --test tests/
//
// Resets the local database first. Uses real Auth (password sign-in + TOTP enrollment and
// verification), PostgREST/RLS, Storage and the gear-publish Edge Function.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { USERS, LOCAL_TEST_PASSWORD, LOCAL_STEP_UP_SECONDS } from '../tools/make-seed.mjs';

const DIR = new URL('..', import.meta.url).pathname;
let ENV;
const sh = (cmd) => execSync(cmd, { cwd: DIR, encoding: 'utf8', env: { ...process.env, SUPABASE_INTERNAL_IMAGE_REGISTRY: 'docker.io' } });
const sql = (q) => execSync(`psql "${ENV.DB_URL}" -v ON_ERROR_STOP=1 -At`, { input: q, encoding: 'utf8' }).trim();
const sqlError = (q) => { try { sql(q); return null; } catch (e) { return String(e.stderr || e.message); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- TOTP (RFC 6238) for the fictional test users ------------------------------------------------
function base32(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  return Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
}
function totp(secret, at = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac('sha1', base32(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

// ---- HTTP helpers ------------------------------------------------------------------------------------
async function http(path, { method = 'GET', token, key = ENV.ANON_KEY, body, headers = {}, raw = false } = {}) {
  const res = await fetch(`${ENV.API_URL}${path}`, {
    method, body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    headers: { apikey: key, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers },
  });
  const text = await res.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { status: res.status, data };
}
const sessions = {};
const factors = {};
async function signIn(who) {
  const r = await http('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: USERS[who].email, password: LOCAL_TEST_PASSWORD } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.access_token;
}
async function mfa(who) {
  const aal1 = await signIn(who);
  if (!factors[who]) {
    const enrolled = await http('/auth/v1/factors', { method: 'POST', token: aal1, body: { factor_type: 'totp', friendly_name: `${who}-local` } });
    assert.equal(enrolled.status, 200, JSON.stringify(enrolled.data));
    factors[who] = { id: enrolled.data.id, secret: enrolled.data.totp.secret };
  }
  const { id, secret } = factors[who];
  const challenge = await http(`/auth/v1/factors/${id}/challenge`, { method: 'POST', token: aal1, body: {} });
  assert.equal(challenge.status, 200, JSON.stringify(challenge.data));
  const verify = await http(`/auth/v1/factors/${id}/verify`, { method: 'POST', token: aal1, body: { challenge_id: challenge.data.id, code: totp(secret) } });
  assert.equal(verify.status, 200, JSON.stringify(verify.data));
  return verify.data.access_token;
}
const claims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
const fn = (token, body, headers = {}) => http('/functions/v1/gear-publish', { method: 'POST', token, body, headers });
const draftRow = () => JSON.parse(sql(`select row_to_json(d) from public.gear_catalog_drafts d`));
const head = (target) => JSON.parse(sql(`select row_to_json(h) from public.gear_publication_head h where target = '${target}'`));
const objectPath = (t) => (t === 'staging' ? 'staging/catalog-v1.json' : 'catalog-v1.json');
const publicRead = (t) => http(`/storage/v1/object/public/recommended-gear/${objectPath(t)}?t=${Date.now()}`);
const serviceWrite = (t, text) => http(`/storage/v1/object/recommended-gear/${objectPath(t)}`, { method: 'POST', key: ENV.SERVICE_ROLE_KEY, token: ENV.SERVICE_ROLE_KEY, body: text, raw: true, headers: { 'Content-Type': 'application/json', 'x-upsert': 'true' } });
async function publish(token, target, extra = {}, headers = {}) {
  return fn(token, { action: 'publish', target, draftVersion: draftRow().version, expectedLiveRevision: head(target).revision, confirmation: target === 'production' ? 'PUBLISH PRODUCTION' : undefined, ...extra }, headers);
}
async function saveDraft(token, mutate) {
  const d = draftRow();
  const catalog = structuredClone(d.catalog);
  const meta = structuredClone(d.meta);
  mutate?.(catalog, meta);
  return http('/rest/v1/rpc/save_gear_draft', { method: 'POST', token, body: { expected_version: d.version, new_catalog: catalog, new_meta: meta } });
}

let publisher; // aal2 session of the pinned publisher

before(async () => {
  ENV = JSON.parse(sh('supabase status -o json'));
  sh('supabase db reset');
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
test('DB: one publisher only; publications require the publisher, aal2, a matching digest, increasing publishedAt; append-only', () => {
  assert.match(sqlError(`insert into public.gear_admins (user_id, role) values ('${USERS.spare.id}', 'publisher')`), /gear_admins_single_publisher/);
  const row = (by, aal, digestExpr, at) => `insert into public.gear_catalog_publications (target, revision, published_at, document, digest, summary, validator_version, published_by, auth_aal)
    values ('staging', gen_random_uuid(), ${at}, '{}', ${digestExpr}, 't', 't', '${by}', '${aal}')`;
  const good = `encode(sha256(convert_to('{}', 'UTF8')), 'hex')`;
  assert.match(sqlError(row(USERS.editor.id, 'aal2', good, 1)), /authored by the publisher/);
  assert.match(sqlError(row(USERS.publisher.id, 'aal1', good, 1)), /aal2/);
  assert.match(sqlError(row(USERS.publisher.id, 'aal2', `'00'`, 1)), /digest/);
  sql(row(USERS.publisher.id, 'aal2', good, 1000));
  assert.match(sqlError(row(USERS.publisher.id, 'aal2', good, 1000)), /strictly increase/);
  assert.match(sqlError(`update public.gear_catalog_publications set summary = 'x'`), /append-only/);
  assert.match(sqlError(`delete from public.gear_catalog_publications`), /append-only/);
  // remove the probe row for the rest of the suite (superuser maintenance path, trigger disabled explicitly)
  sql(`alter table public.gear_catalog_publications disable trigger gear_publications_append_only;
       delete from public.gear_catalog_publications; alter table public.gear_catalog_publications enable trigger gear_publications_append_only;`);
});

// ---------------------------------------------------------------- Storage writes
const svc = (fnName, body) => http(`/rest/v1/rpc/${fnName}`, { method: 'POST', key: ENV.SERVICE_ROLE_KEY, token: ENV.SERVICE_ROLE_KEY, body });
const directWrite = (target, token, leaseToken, text) => http(`/storage/v1/object/recommended-gear/${objectPath(target)}`, {
  method: 'POST', token, body: text, raw: true,
  headers: { 'Content-Type': 'application/json', 'x-upsert': 'true', ...(leaseToken ? { 'x-metadata': Buffer.from(JSON.stringify({ gear_lease: leaseToken })).toString('base64') } : {}) },
});

test('Storage RLS: catalog writes need the aal2 publisher JWT, the live lease token and an unchanged object version', async () => {
  const body = JSON.stringify({ schemaVersion: 1, revision: 'direct', publishedAt: 1, brands: [] });
  assert.ok((await directWrite('staging', undefined, null, body)).status >= 400, 'anon');
  assert.ok((await directWrite('staging', publisher, null, body)).status >= 400, 'publisher without a lease token');
  assert.ok((await directWrite('staging', publisher, '00000000-0000-4000-8000-000000000000', body)).status >= 400, 'forged token');
  const lease = (await svc('gear_acquire_lease', { p_target: 'staging', p_ttl_seconds: 30 })).data;
  try {
    assert.ok((await directWrite('staging', publisher, lease, body)).status >= 400, 'no prepared expectation yet');
    await svc('gear_prepare_write', { p_token: lease, p_target: 'staging' });
    assert.ok((await directWrite('staging', await signIn('publisher'), lease, body)).status >= 400, 'aal1 session with a valid token');
    assert.ok((await directWrite('staging', await mfa('editor'), lease, body)).status >= 400, 'aal2 editor with a valid token');
    assert.equal((await directWrite('staging', publisher, lease, body)).status, 200, 'aal2 publisher + live token + prepared version');
    // compare-and-swap: the version changed, so a second write without re-preparing is refused
    assert.ok((await directWrite('staging', publisher, lease, body.replace('direct', 'direct-2'))).status >= 400, 'CAS');
    assert.equal((await publicRead('staging')).data.revision, 'direct');
  } finally {
    await svc('gear_release_lease', { p_target: 'staging', p_token: lease });
  }
  // a released (stale) token is refused even with a prepared expectation
  assert.ok((await directWrite('staging', publisher, lease, body)).status >= 400, 'released token');
  // clean slate for the publishing tests: delete the direct object through the Storage API (direct SQL deletes are blocked)
  const del = await http('/storage/v1/object/recommended-gear/staging/catalog-v1.json', { method: 'DELETE', key: ENV.SERVICE_ROLE_KEY, token: ENV.SERVICE_ROLE_KEY });
  assert.equal(del.status, 200, JSON.stringify(del.data));
});

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
test('staging publish: recorded, uploaded, verified, publicly readable; MFA evidence stored', async () => {
  const r = await publish(publisher, 'staging');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.storage, 'verified');
  const doc = sql(`select document from public.gear_catalog_publications where id = '${r.data.publicationId}'`);
  const pub = await publicRead('staging');
  assert.equal(pub.status, 200);
  assert.deepEqual(pub.data, JSON.parse(doc));
  const row = JSON.parse(sql(`select json_build_object('aal', auth_aal, 'amr', auth_amr, 'by', published_by) from public.gear_catalog_publications where id = '${r.data.publicationId}'`));
  assert.equal(row.aal, 'aal2');
  assert.equal(row.by, USERS.publisher.id);
  assert.ok(row.amr.some((m) => m.method === 'totp'));
});

test('production: typed confirmation and partner approvals required', async () => {
  publisher = await mfa('publisher');
  const noConfirm = await fn(publisher, { action: 'publish', target: 'production', draftVersion: draftRow().version, expectedLiveRevision: null });
  assert.equal(noConfirm.data.error, 'confirmation_required');
  const pending = await publish(publisher, 'production');
  assert.equal(pending.status, 422);
  assert.ok(pending.data.errors.some((e) => /approval is pending/.test(e.message)));
  assert.equal((await saveDraft(publisher, (c, m) => { for (const b of c.brands) m.approvals[b.id] = 'approved'; })).status, 200);
  const ok = await publish(publisher, 'production');
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.storage, 'verified');
});

test('stale reviews are refused (live changed, draft changed)', async () => {
  const wrongLive = await fn(publisher, { action: 'publish', target: 'staging', draftVersion: draftRow().version, expectedLiveRevision: '00000000-0000-4000-8000-000000000000' });
  assert.equal(wrongLive.data.error, 'live_changed');
  const wrongDraft = await fn(publisher, { action: 'publish', target: 'staging', draftVersion: 1, expectedLiveRevision: head('staging').revision });
  assert.equal(wrongDraft.data.error, 'draft_changed');
});

test('concurrent publishes: one wins; the other is refused by the lease or the live check; publishedAt strictly increases', async () => {
  const before = head('staging');
  const results = await Promise.all([publish(publisher, 'staging'), publish(publisher, 'staging')]);
  const ok = results.filter((r) => r.status === 200);
  assert.equal(ok.length, 1, JSON.stringify(results.map((r) => r.data)));
  assert.ok(['lease_held', 'live_changed'].includes(results.find((r) => r.status !== 200).data.error));
  assert.ok(ok[0].data.publishedAt > before.published_at);
});

test('another holder of the lease blocks publishing (fencing)', async () => {
  const token = (await http('/rest/v1/rpc/gear_acquire_lease', { method: 'POST', key: ENV.SERVICE_ROLE_KEY, token: ENV.SERVICE_ROLE_KEY, body: { p_target: 'staging', p_ttl_seconds: 30 } })).data;
  try {
    assert.equal((await publish(publisher, 'staging')).data.error, 'lease_held');
  } finally {
    await http('/rest/v1/rpc/gear_release_lease', { method: 'POST', key: ENV.SERVICE_ROLE_KEY, token: ENV.SERVICE_ROLE_KEY, body: { p_target: 'staging', p_token: token } });
  }
});

// ---------------------------------------------------------------- recovery
test('crash after commit: recorded but not uploaded; lease held until expiry; reconcile re-sends identical bytes', async () => {
  await saveDraft(publisher, (c) => { c.brands[0].priceText = 'From $81'; });
  const crashed = await publish(publisher, 'staging', {}, { 'x-gear-test-fault': 'crash_after_commit' });
  assert.equal(crashed.status, 500);
  assert.equal((await fn(publisher, { action: 'inspect', target: 'staging' })).data.state, 'pending');
  assert.equal((await fn(publisher, { action: 'reconcile', target: 'staging' })).data.error, 'lease_held');
  await sleep(5000); // GEAR_LEASE_SECONDS = 4 locally
  const fixed = await fn(publisher, { action: 'reconcile', target: 'staging' });
  assert.equal(fixed.data.state, 'repaired', JSON.stringify(fixed.data));
  const doc = sql(`select document from public.gear_catalog_publications where revision = '${crashed.data.revision}'`);
  assert.deepEqual((await publicRead('staging')).data, JSON.parse(doc));
});

test('uncertain uploads (timeout: not stored; lost response: stored) are reconciled before the next publish', async () => {
  for (const fault of ['upload_timeout', 'response_lost']) {
    await saveDraft(publisher, (c) => { c.brands[0].priceText = `From $${fault.length}`; });
    const r = await publish(publisher, 'staging', {}, { 'x-gear-test-fault': fault });
    assert.equal(r.data.storage, 'uncertain', fault);
    const next = await publish(publisher, 'staging');
    assert.equal(next.status, 200, JSON.stringify(next.data));
    assert.equal(next.data.storage, 'verified');
    assert.ok(next.data.publishedAt > r.data.publishedAt);
  }
});

test('drift from a writer that bypasses gear-publish: blocked, publisher-only acknowledgement, then superseded with a newer publishedAt', async () => {
  const current = JSON.parse((await publicRead('staging')).data ? JSON.stringify((await publicRead('staging')).data) : '{}');
  const foreign = { ...current, revision: `bypass-${Date.now()}`, publishedAt: Math.floor(Date.now() / 1000) + 30, brands: current.brands.slice(1) };
  assert.equal((await serviceWrite('staging', JSON.stringify(foreign, null, 2) + '\n')).status, 200);
  const drift = (await fn(publisher, { action: 'inspect', target: 'staging' })).data;
  assert.equal(drift.state, 'drift');
  assert.equal(drift.passesValidation, true);
  assert.equal((await publish(publisher, 'staging')).data.error, 'storage_drift');
  assert.equal((await fn(await mfa('editor'), { action: 'acknowledge', target: 'staging', digest: drift.originDigest })).data.error, 'publisher_required');
  assert.equal((await fn(publisher, { action: 'acknowledge', target: 'staging', digest: drift.originDigest })).status, 200);
  const next = await publish(publisher, 'staging');
  assert.equal(next.status, 200, JSON.stringify(next.data));
  assert.ok(next.data.publishedAt > foreign.publishedAt);
  assert.match(next.data.summary, /1 added/); // reviewed against the acknowledged Storage document
});

test('a foreign document that fails validation sets no timestamp floor', async () => {
  assert.equal((await serviceWrite('staging', '{"schemaVersion":1,"revision":"","brands":"x"}')).status, 200);
  const drift = (await fn(publisher, { action: 'inspect', target: 'staging' })).data;
  assert.equal(drift.passesValidation, false);
  assert.equal((await fn(publisher, { action: 'acknowledge', target: 'staging', digest: drift.originDigest })).status, 200);
  const before = head('staging').published_at;
  const next = await publish(publisher, 'staging');
  assert.equal(next.status, 200, JSON.stringify(next.data));
  assert.ok(next.data.publishedAt <= Math.max(Math.floor(Date.now() / 1000), before + 1));
});

test('far-future catalog that passes validation: not acknowledgeable, publishing blocked, reported, never overwritten', async () => {
  const current = (await publicRead('staging')).data;
  const future = { ...current, revision: `future-${Date.now()}`, publishedAt: Math.floor(Date.now() / 1000) + 5 * 86400 };
  const text = JSON.stringify(future, null, 2) + '\n';
  assert.equal((await serviceWrite('staging', text)).status, 200);
  const drift = (await fn(publisher, { action: 'inspect', target: 'staging' })).data;
  assert.equal(drift.futureIncident, true);
  assert.equal((await fn(publisher, { action: 'acknowledge', target: 'staging', digest: drift.originDigest })).data.error, 'drift_future_timestamp');
  assert.equal((await publish(publisher, 'staging')).data.error, 'incident_future_timestamp');
  assert.equal((await fn(publisher, { action: 'reconcile', target: 'staging' })).data.state, 'drift');
  assert.deepEqual((await publicRead('staging')).data, future); // nothing overwritten
  assert.match(sql(`select string_agg(event, ',') from public.gear_audit_log`), /drift_future_timestamp_refused.*incident_future_timestamp_blocked_publish|incident_future_timestamp_blocked_publish.*drift_future_timestamp_refused/);
  // Incident resolution is a separate, explicit maintainer action (plan §6), simulated here so later
  // tests start clean: restore the latest recorded bytes with the service key, then inspect.
  const recorded = sql(`select document from public.gear_catalog_publications where target = 'staging' order by published_at desc limit 1`);
  assert.equal((await serviceWrite('staging', recorded + '\n')).status, 200);
  assert.equal((await fn(publisher, { action: 'inspect', target: 'staging' })).data.state, 'in_sync');
});

test('rollback (production) is a new publication with a new revision and a newer publishedAt', async () => {
  publisher = await mfa('publisher');
  const [first] = JSON.parse(sql(`select json_agg(row_to_json(p) order by published_at) from (select id, revision, published_at from public.gear_catalog_publications where target = 'production') p`));
  const before = head('production');
  const r = await fn(publisher, { action: 'rollback', target: 'production', publicationId: first.id, expectedLiveRevision: before.revision, confirmation: 'PUBLISH PRODUCTION' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.notEqual(r.data.revision, first.revision);
  assert.ok(r.data.publishedAt > before.published_at);
  assert.equal(sql(`select rollback_of from public.gear_catalog_publications where revision = '${r.data.revision}'`), first.id);
});

test('a global sign-out revokes every session of the publisher (e.g. after losing a device)', async () => {
  const a = await mfa('publisher');
  const b = await mfa('publisher');
  assert.equal((await http('/auth/v1/logout?scope=global', { method: 'POST', token: a })).status, 204);
  assert.equal((await fn(b, { action: 'inspect', target: 'staging' })).status, 401);
  publisher = await mfa('publisher'); // fresh session for anything that runs later
});

// ---------------------------------------------------------------- round 2: step-up, keys, stale writers, reconcile
test('the function uses the new-style secret key, and the platform accepts it in the apikey header alone', async () => {
  const inspect = await fn(publisher, { action: 'inspect', target: 'staging' });
  assert.equal(inspect.data.diagnostics.serviceCredential, 'secret_key');
  assert.match(ENV.SECRET_KEY, /^sb_secret_/);
  const rest = await fetch(`${ENV.API_URL}/rest/v1/gear_publication_head?select=target`, { headers: { apikey: ENV.SECRET_KEY } });
  assert.equal(rest.status, 200);
  assert.equal((await rest.json()).length, 2);
  const rpcCall = await fetch(`${ENV.API_URL}/rest/v1/rpc/gear_acquire_lease`, { method: 'POST', headers: { apikey: ENV.SECRET_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_target: 'production', p_ttl_seconds: 5 }) });
  assert.equal(rpcCall.status, 200);
  const token = await rpcCall.json();
  await fetch(`${ENV.API_URL}/rest/v1/rpc/gear_release_lease`, { method: 'POST', headers: { apikey: ENV.SECRET_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_target: 'production', p_token: token }) });
  // the secret key is refused as a Bearer token in Authorization: it is not a JWT
  const asBearer = await fetch(`${ENV.API_URL}/rest/v1/gear_publication_head?select=target`, { headers: { apikey: ENV.PUBLISHABLE_KEY, Authorization: `Bearer ${ENV.SECRET_KEY}` } });
  assert.notEqual(asBearer.status, 200);
});

test('Production step-up: rejected after the TOTP window expires, also by Storage RLS; a token refresh does not renew it; a new TOTP does', async () => {
  const signedIn = await http('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: USERS.publisher.email, password: LOCAL_TEST_PASSWORD } });
  const { id, secret } = factors.publisher;
  const challenge = await http(`/auth/v1/factors/${id}/challenge`, { method: 'POST', token: signedIn.data.access_token, body: {} });
  const verified = await http(`/auth/v1/factors/${id}/verify`, { method: 'POST', token: signedIn.data.access_token, body: { challenge_id: challenge.data.id, code: totp(secret) } });
  const session = verified.data;
  await sleep((LOCAL_STEP_UP_SECONDS + 3) * 1000);
  // 1. the function refuses
  const viaFunction = await publish(session.access_token, 'production');
  assert.equal(viaFunction.data.error, 'mfa_step_up_required', JSON.stringify(viaFunction.data));
  // 2. Storage RLS refuses independently, even with a live lease token and a prepared version
  const lease = (await svc('gear_acquire_lease', { p_target: 'production', p_ttl_seconds: 30 })).data;
  try {
    await svc('gear_prepare_write', { p_token: lease, p_target: 'production' });
    const direct = await directWrite('production', session.access_token, lease, '{}');
    assert.ok(direct.status >= 400, `stale TOTP direct write: ${direct.status}`);
  } finally {
    await svc('gear_release_lease', { p_target: 'production', p_token: lease });
  }
  // 3. refreshing the session keeps the old TOTP time
  const refreshed = await http('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: session.refresh_token } });
  assert.equal(refreshed.status, 200);
  assert.equal(claims(refreshed.data.access_token).aal, 'aal2');
  assert.equal((await publish(refreshed.data.access_token, 'production')).data.error, 'mfa_step_up_required');
  await saveDraft(publisher, (c, m) => { for (const b of c.brands) m.approvals[b.id] = 'approved'; });
  // 4. a fresh TOTP verification on that session restores Production access
  const again = await http(`/auth/v1/factors/${id}/challenge`, { method: 'POST', token: refreshed.data.access_token, body: {} });
  const reverified = await http(`/auth/v1/factors/${id}/verify`, { method: 'POST', token: refreshed.data.access_token, body: { challenge_id: again.data.id, code: totp(secret) } });
  assert.equal(reverified.status, 200, JSON.stringify(reverified.data));
  const ok = await publish(reverified.data.access_token, 'production');
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  publisher = reverified.data.access_token;
});

test('stale publisher A (paused after its DB commit) cannot overwrite B or finalize state after its lease expired', async () => {
  publisher = await mfa('publisher');
  await saveDraft(publisher, (c) => { c.brands[0].priceText = 'From $101'; });
  const startHead = head('staging');
  // A records its publication, then stalls for 8 s before uploading (lease is 4 s locally)
  const aPromise = publish(publisher, 'staging', {}, { 'x-gear-test-fault': 'pause_after_commit:8000' });
  const committedBy = Date.now() + 3000;
  while (head('staging').revision === startHead.revision && Date.now() < committedBy) await sleep(100);
  const aRevision = head('staging').revision;
  assert.notEqual(aRevision, startHead.revision, 'A has committed');
  await sleep(4500); // A's lease (4 s) has expired; A is still paused
  const b = await fn(publisher, { action: 'publish', target: 'staging', draftVersion: draftRow().version, expectedLiveRevision: aRevision });
  assert.equal(b.status, 200, JSON.stringify(b.data));
  assert.equal(b.data.storage, 'verified');
  const a = await aPromise;
  assert.equal(a.status, 409, JSON.stringify(a.data));
  assert.equal(a.data.error, 'storage_write_rejected');
  // Storage still serves B; the database head is B; A's row was finalized by B's reconcile, not by A
  assert.equal((await publicRead('staging')).data.revision, b.data.revision);
  assert.equal(head('staging').revision, b.data.revision);
  const aStatuses = sql(`select string_agg(s.status || ':' || coalesce(s.note, ''), ' | ' order by s.id) from public.gear_publication_status s
    join public.gear_catalog_publications p on p.id = s.publication_id where p.revision = '${aRevision}'`);
  assert.match(aStatuses, /^recorded:.* \| verified:re-sent identical recorded bytes during reconcile$/);
  assert.equal((await fn(publisher, { action: 'inspect', target: 'staging' })).data.state, 'in_sync');
});

test('stale publisher A (paused before recording) cannot record after B took the lease', async () => {
  const startHead = head('staging');
  await saveDraft(publisher, (c) => { c.brands[0].priceText = 'From $102'; });
  const aPromise = publish(publisher, 'staging', {}, { 'x-gear-test-fault': 'pause_before_record:7000' });
  await sleep(5500); // A holds a lease it has not used; it expires
  const b = await publish(publisher, 'staging');
  assert.equal(b.status, 200, JSON.stringify(b.data));
  const a = await aPromise;
  assert.equal(a.status, 409, JSON.stringify(a.data));
  assert.equal(a.data.error, 'lease_lost');
  assert.equal(sql(`select count(*) from public.gear_catalog_publications where target = 'staging' and published_at > ${startHead.published_at}`), '1');
  assert.equal((await publicRead('staging')).data.revision, b.data.revision);
});

test('reconcile reads first and never overwrites content that changed after it read (CAS), even mid-repair', async () => {
  await saveDraft(publisher, (c) => { c.brands[0].priceText = 'From $103'; });
  const r = await publish(publisher, 'staging', {}, { 'x-gear-test-fault': 'upload_timeout' }); // recorded, not stored
  assert.equal(r.data.storage, 'uncertain');
  // reconcile decides to re-send, then pauses; meanwhile a bypass writer replaces the object
  const recon = fn(publisher, { action: 'reconcile', target: 'staging' }, { 'x-gear-test-fault': 'pause_before_resend:2500' });
  await sleep(800);
  const current = (await publicRead('staging')).data;
  const intruder = { ...current, revision: `intruder-${Date.now()}` };
  assert.equal((await serviceWrite('staging', JSON.stringify(intruder, null, 2) + '\n')).status, 200);
  const result = (await recon).data;
  assert.equal(result.state, 'pending', JSON.stringify(result));
  assert.match(result.reason, /nothing was overwritten/);
  assert.equal((await publicRead('staging')).data.revision, intruder.revision); // not overwritten
  assert.equal((await fn(publisher, { action: 'inspect', target: 'staging' })).data.state, 'drift');
  // resolve for the next test: acknowledge, then supersede
  const drift = (await fn(publisher, { action: 'inspect', target: 'staging' })).data;
  assert.equal((await fn(publisher, { action: 'acknowledge', target: 'staging', digest: drift.originDigest })).status, 200);
  assert.equal((await publish(publisher, 'staging')).status, 200);
});

test('reconcile after a lost response reads back and does not write when Storage already holds the bytes', async () => {
  await saveDraft(publisher, (c) => { c.brands[0].priceText = 'From $104'; });
  const r = await publish(publisher, 'staging', {}, { 'x-gear-test-fault': 'response_lost' }); // stored, response lost
  assert.equal(r.data.storage, 'uncertain');
  const versionBefore = sql(`select version from storage.objects where bucket_id = 'recommended-gear' and name = 'staging/catalog-v1.json'`);
  const result = (await fn(publisher, { action: 'reconcile', target: 'staging' })).data;
  assert.equal(result.state, 'repaired');
  assert.equal(sql(`select version from storage.objects where bucket_id = 'recommended-gear' and name = 'staging/catalog-v1.json'`), versionBefore, 'no new write');
  assert.equal(sql(`select status from public.gear_publication_status s join public.gear_catalog_publications p on p.id = s.publication_id where p.revision = '${r.data.revision}' order by s.id desc limit 1`), 'verified');
});
