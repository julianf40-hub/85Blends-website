// Hosted checks against an explicitly configured NON-production Supabase project.
//
//   node --test tests/hosted/run-hosted-checks.mjs
//
// Opt-in only: this file is not matched by tests/*.test.mjs, and it refuses to start (before any network
// request) unless backend/tools/hosted-target.mjs accepts the target. That guard requires the explicit
// project ref and URL, the production project ref(s) to refuse, a typed confirmation and a publishable
// key, and refuses if a privileged key is in the environment.
//
// It does NOT reset, seed, run SQL, use Docker or a service key; it never imports the local test
// helpers. The project must already be set up (deploy/README.md, ROLLOUT.md path A) with fictional
// accounts created by its owner.
//
// Read-only by default. GEAR_HOSTED_TEST_WRITES=staging additionally saves a fictional draft change and
// publishes to STAGING (public; fictional content only, D11). Nothing here ever publishes to Production.
//
// Environment (besides the guard's variables):
//   GEAR_HOSTED_TEST_ADMIN_ORIGIN      an origin listed in the project's GEAR_ALLOWED_ORIGINS secret
//   GEAR_HOSTED_TEST_PUBLISHER_EMAIL / _PASSWORD / _TOTP_SECRET   the FICTIONAL publisher account
//   GEAR_HOSTED_TEST_WRITES            unset (read-only) or "staging"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { hostedTestTarget } from '../../tools/hosted-target.mjs';

const target = hostedTestTarget(process.env); // throws HostedTargetRefused before anything else happens
const WRITES = process.env.GEAR_HOSTED_TEST_WRITES ?? '';
if (!['', 'staging'].includes(WRITES)) throw new Error('GEAR_HOSTED_TEST_WRITES must be unset or "staging" (Production is never written)');
const ORIGIN = process.env.GEAR_HOSTED_TEST_ADMIN_ORIGIN ?? '';
const account = { email: process.env.GEAR_HOSTED_TEST_PUBLISHER_EMAIL, password: process.env.GEAR_HOSTED_TEST_PUBLISHER_PASSWORD, totpSecret: process.env.GEAR_HOSTED_TEST_PUBLISHER_TOTP_SECRET };
const haveAccount = !!(account.email && account.password && account.totpSecret);

const sha = (b) => createHash('sha256').update(b).digest('hex');
function totp(secret, at = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
async function call(path, { method = 'GET', token, body, headers = {} } = {}) {
  const res = await fetch(`${target.url}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { apikey: target.publishableKey, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers } });
  const text = await res.text();
  let data = text; try { data = text ? JSON.parse(text) : null; } catch { /* text */ }
  return { status: res.status, data, headers: res.headers };
}
let session = null;
async function publisherSession() {
  if (session) return session;
  const pw = await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: account.email, password: account.password } });
  assert.equal(pw.status, 200, JSON.stringify(pw.data));
  const factors = await call('/auth/v1/user', { token: pw.data.access_token });
  const factor = (factors.data.factors ?? []).find((f) => f.factor_type === 'totp' && f.status === 'verified');
  assert.ok(factor, 'the fictional publisher must already have a verified TOTP factor');
  const challenge = await call(`/auth/v1/factors/${factor.id}/challenge`, { method: 'POST', token: pw.data.access_token, body: {} });
  const verify = await call(`/auth/v1/factors/${factor.id}/verify`, { method: 'POST', token: pw.data.access_token, body: { challenge_id: challenge.data.id, code: totp(account.totpSecret) } });
  assert.equal(verify.status, 200, JSON.stringify(verify.data));
  session = verify.data.access_token;
  return session;
}
const publish = (token, body) => call('/functions/v1/gear-publish', { method: 'POST', token, body, headers: ORIGIN ? { Origin: ORIGIN } : {} });

console.log(`hosted checks against NON-production project ${target.ref} (${WRITES ? 'writes: staging only' : 'read-only'})`);

// ---------------------------------------------------------------- read endpoint (guests)
for (const env of ['production', 'staging']) {
  test(`gear-catalog/${env}: a guest with no headers at all gets the exact current bytes or 404, with ETag/304`, async () => {
    const res = await fetch(`${target.url}/functions/v1/gear-catalog/${env}`); // deliberately no apikey, no Authorization
    assert.ok([200, 404].includes(res.status), `HTTP ${res.status} (401/403 means the gateway requires a key: verify_jwt or apikey)`);
    const body = Buffer.from(await res.arrayBuffer());
    console.log(`EVIDENCE catalog-${env} ${JSON.stringify({ status: res.status, etag: res.headers.get('etag'), cache: res.headers.get('cache-control'), encoding: res.headers.get('content-encoding'), bytes: body.length })}`);
    if (res.status === 404) return;
    assert.equal((res.headers.get('etag') ?? '').replace(/^W\//, ''), `"${sha(body)}"`, 'ETag is the SHA-256 of the bytes received');
    assert.equal(res.headers.get('cache-control'), env === 'production' ? 'public, max-age=60' : 'no-cache');
    const again = await fetch(`${target.url}/functions/v1/gear-catalog/${env}`, { headers: { 'If-None-Match': res.headers.get('etag') } });
    assert.equal(again.status, 304);
  });
}

test('gear-catalog answers a browser preflight itself (any origin; If-None-Match)', async () => {
  const r = await fetch(`${target.url}/functions/v1/gear-catalog/production`, { method: 'OPTIONS',
    headers: { Origin: 'https://example.org', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'if-none-match' } });
  console.log(`EVIDENCE catalog-preflight ${JSON.stringify({ status: r.status, acao: r.headers.get('access-control-allow-origin') })}`);
  assert.ok([200, 204].includes(r.status)); assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

test('gear-publish preflight: the admin origin is allowed exactly; another origin is not', { skip: !ORIGIN && 'GEAR_HOSTED_TEST_ADMIN_ORIGIN not set' }, async () => {
  const pre = (origin) => fetch(`${target.url}/functions/v1/gear-publish`, { method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, apikey, content-type, x-client-info' } });
  const ok = await pre(ORIGIN);
  const bad = await pre('https://evil.example');
  console.log(`EVIDENCE publish-preflight ${JSON.stringify({ allowed: [ok.status, ok.headers.get('access-control-allow-origin')], other: [bad.status, bad.headers.get('access-control-allow-origin')] })}`);
  assert.ok([200, 204].includes(ok.status)); assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
  assert.notEqual(bad.headers.get('access-control-allow-origin'), 'https://evil.example');
  assert.notEqual(bad.headers.get('access-control-allow-origin'), '*');
});

test('anon cannot read the admin tables or call service-only RPCs', async () => {
  const tables = await call('/rest/v1/gear_catalog_publications?select=id');
  assert.ok(tables.status >= 400 || (Array.isArray(tables.data) && tables.data.length === 0), JSON.stringify(tables.data));
  for (const rpc of ['gear_prepare_intent', 'gear_find_operation', 'gear_cleanup_operations']) {
    assert.ok((await call(`/rest/v1/rpc/${rpc}`, { method: 'POST', body: {} })).status >= 400, rpc);
  }
});

// ---------------------------------------------------------------- the fictional publisher (read-only calls)
test('the fictional publisher signs in with TOTP (aal2) and can run the read-only verifier', { skip: !haveAccount && 'publisher test account not configured' }, async () => {
  const token = await publisherSession();
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  console.log(`EVIDENCE publisher-token ${JSON.stringify({ aal: claims.aal, amr: claims.amr, alg: JSON.parse(Buffer.from(token.split('.')[0], 'base64url')).alg, lifetime: claims.exp - claims.iat })}`);
  assert.equal(claims.aal, 'aal2');
  const v = await publish(token, { action: 'verify' });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  console.log(`EVIDENCE verifier ${JSON.stringify({ alerts: v.data.alerts, info: v.data.info.map((i) => i.kind) })}`);
});

// ---------------------------------------------------------------- staging writes (opt-in)
test('staging publish with an operation ID; retry replays; the same ID for Production is refused', { skip: (WRITES !== 'staging' || !haveAccount) && 'set GEAR_HOSTED_TEST_WRITES=staging and the publisher account' }, async () => {
  const token = await publisherSession();
  const [draft] = (await call('/rest/v1/gear_catalog_drafts?id=eq.main&select=catalog,meta,version', { token })).data;
  const catalog = structuredClone(draft.catalog);
  assert.ok(catalog.brands.length > 0, 'the test project draft must contain fictional brands');
  catalog.brands[0].tagline = `Hosted check ${new Date().toISOString().slice(0, 19)}`;
  const saved = await call('/rest/v1/rpc/save_gear_draft', { method: 'POST', token, body: { expected_version: draft.version, new_catalog: catalog, new_meta: draft.meta } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const review = await publish(token, { action: 'review', target: 'staging' });
  assert.equal(review.status, 200, JSON.stringify(review.data));
  assert.deepEqual(review.data.errors, [], 'the fictional draft must pass Staging checks');
  const body = { action: 'publish', target: 'staging', draftVersion: review.data.draftVersion, expectedLiveRevision: review.data.live?.revision ?? null,
    reviewDigest: review.data.reviewDigest, operationId: randomUUID() };
  const first = await publish(token, body);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const retry = await publish(token, body);
  assert.equal(retry.status, 200); assert.equal(retry.data.replayed, true); assert.equal(retry.data.revision, first.data.revision);
  const cross = await publish(token, { ...body, target: 'production', confirmation: 'PUBLISH PRODUCTION' });
  console.log(`EVIDENCE staging-write ${JSON.stringify({ revision: first.data.revision, replayed: retry.data.replayed, crossEnvironment: [cross.status, cross.data.error] })}`);
  assert.equal(cross.data.error, 'operation_conflict', JSON.stringify(cross.data)); // refused before any step-up or write
  const served = await fetch(`${target.url}/functions/v1/gear-catalog/staging`);
  assert.equal(served.headers.get('x-gear-revision'), first.data.revision);
});
