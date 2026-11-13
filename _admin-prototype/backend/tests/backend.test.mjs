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
import { USERS, LOCAL_TEST_PASSWORD } from '../tools/make-seed.mjs';

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
test('Storage: public read; anon and signed-in clients (even the aal2 publisher) cannot write', async () => {
  for (const token of [undefined, publisher]) {
    const r = await http('/storage/v1/object/recommended-gear/staging/catalog-v1.json', { method: 'POST', token, body: '{}', raw: true, headers: { 'Content-Type': 'application/json' } });
    assert.ok(r.status >= 400, `token=${!!token}: ${r.status} ${JSON.stringify(r.data)}`);
  }
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
});

test('rollback (production) is a new publication with a new revision and a newer publishedAt', async () => {
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
