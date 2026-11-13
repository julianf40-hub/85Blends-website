// Shared helpers for the local-backend integration tests (fictional data, local stack only).
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { USERS, LOCAL_TEST_PASSWORD } from '../tools/make-seed.mjs';

export const DIR = new URL('..', import.meta.url).pathname;
export const ENV = {};
export const sh = (cmd) => execSync(cmd, { cwd: DIR, encoding: 'utf8', env: { ...process.env, SUPABASE_INTERNAL_IMAGE_REGISTRY: 'docker.io' } });
export const sql = (q) => execSync(`psql "${ENV.DB_URL}" -v ON_ERROR_STOP=1 -At`, { input: q, encoding: 'utf8' }).trim();
export const sqlError = (q) => { try { sql(q); return null; } catch (e) { return String(e.stderr || e.message); } };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- TOTP (RFC 6238) for the fictional test users ------------------------------------------------
export function base32(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  return Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
}
export function totp(secret, at = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac('sha1', base32(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

// ---- HTTP helpers ------------------------------------------------------------------------------------
export async function http(path, { method = 'GET', token, key = ENV.ANON_KEY, body, headers = {}, raw = false } = {}) {
  const res = await fetch(`${ENV.API_URL}${path}`, {
    method, body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    headers: { apikey: key, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers },
  });
  const text = await res.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { status: res.status, data };
}
export const sessions = {};
export const factors = {};
export async function signIn(who) {
  const r = await http('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: USERS[who].email, password: LOCAL_TEST_PASSWORD } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.access_token;
}
export async function mfa(who) {
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
export const claims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
export const fn = (token, body, headers = {}) => http('/functions/v1/gear-publish', { method: 'POST', token, body, headers });
export const draftRow = () => JSON.parse(sql(`select row_to_json(d) from public.gear_catalog_drafts d`));
export const head = (target) => JSON.parse(sql(`select row_to_json(h) from public.gear_publication_head h where target = '${target}'`));
export const objectPath = (t) => (t === 'staging' ? 'staging/catalog-v1.json' : 'catalog-v1.json');
export const publicRead = (t) => http(`/storage/v1/object/public/recommended-gear/${objectPath(t)}?t=${Date.now()}`);
export const serviceWrite = (t, text) => http(`/storage/v1/object/recommended-gear/${objectPath(t)}`, { method: 'POST', key: ENV.SERVICE_ROLE_KEY, token: ENV.SERVICE_ROLE_KEY, body: text, raw: true, headers: { 'Content-Type': 'application/json', 'x-upsert': 'true' } });
export async function publish(token, target, extra = {}, headers = {}) {
  const reviewed = await review(token, target, extra.rollbackOf ? { rollbackOf: extra.rollbackOf } : {});
  return fn(token, { action: 'publish', target, draftVersion: draftRow().version, expectedLiveRevision: head(target).revision,
    confirmation: target === 'production' ? 'PUBLISH PRODUCTION' : undefined, reviewDigest: reviewed.data?.reviewDigest, ...extra }, headers);
}
export async function saveDraft(token, mutate) {
  const d = draftRow();
  const catalog = structuredClone(d.catalog);
  const meta = structuredClone(d.meta);
  mutate?.(catalog, meta);
  return http('/rest/v1/rpc/save_gear_draft', { method: 'POST', token, body: { expected_version: d.version, new_catalog: catalog, new_meta: meta } });
}

export const svc = (fnName, body) => http(`/rest/v1/rpc/${fnName}`, { method: 'POST', key: ENV.SERVICE_ROLE_KEY, token: ENV.SERVICE_ROLE_KEY, body });
// A direct Storage write, as a caller bypassing gear-publish would make. `nonce` goes in the object's
// user metadata as the single-use write grant (gear_write).
export const directWrite = (target, token, nonce, text) => http(`/storage/v1/object/recommended-gear/${objectPath(target)}`, {
  method: 'POST', token, body: text, raw: true,
  headers: { 'Content-Type': 'application/json', 'x-upsert': 'true', ...(nonce ? { 'x-metadata': Buffer.from(JSON.stringify({ gear_write: nonce })).toString('base64') } : {}) },
});
export const latestDocument = (target) => sql(`select document from public.gear_catalog_publications where target = '${target}' order by published_at desc limit 1`) + '\n';
export const latestPublicationId = (target) => sql(`select id from public.gear_catalog_publications where target = '${target}' order by published_at desc limit 1`);
// Simulates what only gear-publish can do: lease, capture version, authorize a write for a recorded publication.
export async function grantFor(target, ttl = 30, userId = USERS.publisher.id) {
  const lease = (await svc('gear_acquire_lease', { p_target: target, p_ttl_seconds: ttl })).data;
  await svc('gear_prepare_write', { p_token: lease, p_target: target });
  const nonce = (await svc('gear_authorize_write', { p_token: lease, p_target: target, p_publication_id: latestPublicationId(target), p_user_id: userId })).data;
  return { lease, nonce, release: () => svc('gear_release_lease', { p_target: target, p_token: lease }) };
}


export function resetLocalDatabase() {
  Object.assign(ENV, JSON.parse(sh('supabase status -o json')));
  sh('supabase db reset');
  sh('node tools/seed-images.mjs');
}
// The review step the UI performs before publishing; publish must send its digest back.
export const review = (token, target, extra = {}) => fn(token, { action: 'review', target, ...extra });
