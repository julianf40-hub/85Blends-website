// Publication-safety review (local stack, fictional data). These tests assert the SAFE outcome; a
// failure is the reproduction. Each test prints its evidence as JSON (lines starting "EVIDENCE").
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { ENV, sql, sleep, mfa, fn, publish, saveDraft, publicRead, grantFor, latestDocument, objectPath, resetLocalDatabase } from '../helpers.mjs';

let publisher;
before(async () => {
  resetLocalDatabase({ legacyStoragePath: true });
  publisher = await mfa('publisher');
});

// Local only: toggle the candidate commit guard as the container's superuser (postgres cannot).
const guard = (on) => execFileSync('docker', ['exec', 'supabase_db_gear-admin-local', 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c',
  `alter table storage.objects ${on ? 'enable' : 'disable'} trigger gear_catalog_commit_guard`], { encoding: 'utf8' });
const evidence = (name, data) => console.log(`EVIDENCE ${name} ${JSON.stringify(data)}`);
const head = (t) => JSON.parse(sql(`select json_build_object('revision', revision, 'publishedAt', published_at, 'leaseSet', lease_token is not null, 'leaseExpired', lease_expires_at < clock_timestamp()) from public.gear_publication_head where target = '${t}'`));
const objectRow = (t) => JSON.parse(sql(`select json_build_object('version', version, 'updated_at', updated_at, 'user_metadata', user_metadata, 'size', metadata->>'size') from storage.objects where bucket_id = 'recommended-gear' and name = '${objectPath(t)}'`) || 'null');
const statuses = (t) => JSON.parse(sql(`select coalesce(json_agg(json_build_object('revision', p.revision, 'status', s.status, 'note', s.note) order by s.id), '[]') from public.gear_publication_status s join public.gear_catalog_publications p on p.id = s.publication_id where p.target = '${t}'`));
const grants = () => Number(sql(`select count(*) from private.gear_write_grants`));

/** Raw HTTP/1.1 upload that sends headers + part of the body now and the rest on demand. */
const storageDirect = () => `http://${execFileSync('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', 'supabase_storage_gear-admin-local'], { encoding: 'utf8' }).trim()}:5000`;
function stalledDirectUpload(target, token, nonce, text, direct = false) {
  const body = Buffer.from(text);
  const url = new URL(direct ? `${storageDirect()}/object/recommended-gear/${objectPath(target)}` : `${ENV.API_URL}/storage/v1/object/recommended-gear/${objectPath(target)}`);
  const req = http.request(url, { method: 'POST', headers: { apikey: ENV.ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': body.length, 'x-upsert': 'true', 'x-metadata': Buffer.from(JSON.stringify({ gear_write: nonce })).toString('base64') } });
  const done = new Promise((resolve, reject) => {
    req.on('response', (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    req.on('error', reject);
  });
  req.write(body.subarray(0, Math.floor(body.length / 2)));
  return { finish: () => { req.end(body.subarray(Math.floor(body.length / 2))); return done; }, done };
}

async function pausedMidBody(label, fault, { expectHazard = false } = {}) {
  // A previous reproduction leaves drift, which (correctly) blocks publishing: acknowledge it first.
  const pre = (await fn(publisher, { action: 'inspect', target: 'staging' })).data;
  if (pre.state === 'drift') assert.equal((await fn(publisher, { action: 'acknowledge', target: 'staging', digest: pre.originDigest })).status, 200);
  await saveDraft(publisher, (c) => { c.brands[0].tagline = `${label}: v1`; });
  assert.equal((await publish(publisher, 'staging')).status, 200, 'v1');
  const v1 = head('staging').revision;
  await saveDraft(publisher, (c) => { c.brands[0].tagline = 'A: paused mid-upload'; });

  // 1–2. A: through gear-publish. Storage authorizes on the headers; A stalls after half the body.
  const startedAt = Date.now();
  const aPromise = publish(publisher, 'staging', {}, { 'x-gear-test-fault': fault });
  let aRevision = null;
  while (!aRevision && Date.now() - startedAt < 8000) {
    aRevision = sql(`select revision from public.gear_catalog_publications where target = 'staging' and published_at > (select published_at from public.gear_catalog_publications where revision = '${v1}') order by published_at desc limit 1`) || null;
    await sleep(100);
  }
  assert.ok(aRevision, 'A recorded its publication and started the upload');
  await sleep(1000); // A's request headers and first half are with Storage now

  // 3. A's lease expires (6 s locally); nothing renews it.
  while (!head('staging').leaseExpired) await sleep(200);
  const atExpiry = { head: head('staging'), grantsLive: grants(), object: objectRow('staging') };

  // 4. B: reconcile (A's recorded bytes had not landed), then publish a newer draft and verify it.
  const bReconcile = await fn(publisher, { action: 'reconcile', target: 'staging' });
  await saveDraft(publisher, (c) => { c.brands[0].tagline = 'B: newer, verified'; });
  const b = await publish(publisher, 'staging');
  assert.equal(b.status, 200, JSON.stringify(b.data));
  assert.equal(b.data.storage, 'verified');
  const afterB = { head: head('staging'), object: objectRow('staging'), served: (await publicRead('staging')).data?.revision, msSinceAStarted: Date.now() - startedAt };
  assert.ok(afterB.msSinceAStarted < 20000, 'B finished while A was still stalled');

  // 5. Resume A (the stall ends by itself; A's client never timed out) and inspect actual state.
  const a = await aPromise;
  await sleep(500);
  const served = (await publicRead('staging')).data;
  const inspect = (await fn(publisher, { action: 'inspect', target: 'staging' })).data;
  const final = {
    aResponse: { status: a.status, body: a.data },
    servedRevision: served?.revision, servedTagline: served?.brands?.[0]?.tagline,
    head: head('staging'), object: objectRow('staging'), statuses: statuses('staging'),
    inspect: { state: inspect.state, reason: inspect.reason, latestStatus: inspect.latestStatus },
  };
  evidence(label, { fault, v1, aRevision, bRevision: b.data.revision, atExpiry, bReconcile: bReconcile.data?.state, afterB, final });
  assert.equal(final.head.revision, b.data.revision, 'database head is B');
  if (expectHazard) {
    // Reproduction without the commit guard: A's older bytes replace B's verified object.
    assert.equal(final.servedRevision, aRevision, 'hazard reproduced: Storage serves A');
    assert.equal(final.inspect.state, 'drift', 'and it is detected as drift');
    return;
  }
  assert.equal(final.servedRevision, b.data.revision, `Storage must still serve B; it serves ${final.servedRevision} (A=${aRevision})`);
  assert.equal(final.inspect.state, 'in_sync');
}

test('PS1a: paused mid-body past its lease, through the local gateway (Kong buffers the body; authorization waits for it)', () => pausedMidBody('PS1a', 'stall_body:20000'));
test('PS1b-unguarded: REPRODUCTION without the commit guard: Storage authorizes on the headers, A resumes and overwrites B', async () => {
  guard(false);
  try { await pausedMidBody('PS1b-unguarded', 'stall_body_direct:20000', { expectHazard: true }); } finally { guard(true); }
});
test('PS1b: with the commit guard, the paused publisher cannot overwrite the newer verified publication', () => pausedMidBody('PS1b', 'stall_body_direct:20000'));

async function concurrentGrant(label, { expectHazard = false, direct = false } = {}) {
  // Grant issued exactly as gear-publish issues it (service role, under a lease, for the latest publication).
  const grant = await grantFor('staging', 30);
  const original = latestDocument('staging');
  const before = { object: objectRow('staging'), grantRow: JSON.parse(sql(`select coalesce(json_agg(json_build_object('nonce', nonce, 'expires_at', expires_at)), '[]') from private.gear_write_grants`)) };

  // Both requests are authorized (headers sent) before either body completes.
  const r1 = stalledDirectUpload('staging', publisher, grant.nonce, original, direct);
  const r2 = stalledDirectUpload('staging', publisher, grant.nonce, original, direct); // the same valid bytes: only consumption can stop it
  await sleep(1500);
  const duringBoth = { grantsLive: grants() };
  const [a, b] = await Promise.all([r1.finish(), r2.finish()]);
  const after = { grantsLive: grants(), object: objectRow('staging') };
  // A third, sequential use after both finished.
  const third = await new Promise((resolve) => { const r = stalledDirectUpload('staging', publisher, grant.nonce, original, direct); r.finish().then(resolve, (e) => resolve({ status: 0, body: String(e) })); });
  await grant.release();
  evidence(label, { direct, before, duringBoth, r1: { status: a.status, body: a.body.slice(0, 160) }, r2: { status: b.status, body: b.body.slice(0, 160) }, after, third: { status: third.status, body: third.body.slice(0, 160) } });
  const succeeded = [a, b].filter((r) => r.status === 200).length;
  if (expectHazard) { assert.equal(succeeded, 2, 'hazard reproduced: both simultaneous requests used one grant'); return; }
  assert.equal(succeeded, 1, `${succeeded} simultaneous requests used one grant`);
  assert.notEqual(third.status, 200, 'a third use after both finished');
  assert.equal(after.grantsLive, 0, 'the grant was consumed in the committing transaction');
  assert.equal(after.object.size, String(Buffer.byteLength(original)));
}

test('PS2-unguarded: REPRODUCTION without the commit guard: two simultaneous requests both use one grant', async () => {
  guard(false);
  try { await concurrentGrant('PS2-unguarded', { expectHazard: true }); } finally { guard(true); }
});
test('PS2: with the commit guard, exactly one of two simultaneous requests (via the gateway) uses the grant', () => concurrentGrant('PS2'));
test('PS2-direct: same, both requests streamed straight to Storage (authorized on the headers)', () => concurrentGrant('PS2-direct', { direct: true }));

test('PS2-repeat: 10 rounds of the race (gateway and direct alternating): never more than one success per grant', async () => {
  for (let round = 0; round < 10; round++) await concurrentGrant(`PS2-repeat-${round}`, { direct: round % 2 === 1 });
});
