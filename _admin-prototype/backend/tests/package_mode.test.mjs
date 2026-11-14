// Runtime checks that only make sense against the DEPLOYMENT package stack (tools/check-deploy-package.sh):
// the fault header does nothing, the superseded functions and RPCs do not exist. Skipped otherwise.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ENV, PACKAGE_MODE, draftRow, fn, head, http, mfa, review, resetLocalDatabase, saveDraft, sleep, sql, svc } from './helpers.mjs';

const skip = !PACKAGE_MODE && 'only against the deployment package stack (tools/check-deploy-package.sh)';
let publisher;
before(async () => { if (skip) return; resetLocalDatabase(); await sleep(3000); publisher = await mfa('publisher'); });

test('fault headers are inert in the package: a "lost response" request is answered normally and a "pause" is not honored', { skip }, async () => {
  await saveDraft(publisher, (c) => { c.brands[0].tagline = 'package fault check'; });
  const r = await review(publisher, 'staging');
  const started = Date.now();
  const p = await fn(publisher, { action: 'publish', target: 'staging', draftVersion: draftRow().version, expectedLiveRevision: head('staging').revision,
    reviewDigest: r.data.reviewDigest, operationId: randomUUID() }, { 'x-gear-test-fault': 'response_lost,pause_before_commit:5000' });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.ok(Date.now() - started < 4000, 'no pause');
});

test('the superseded Storage path does not exist in the package stack', { skip }, async () => {
  const legacy = await fetch(`${ENV.API_URL}/functions/v1/gear-legacy-storage-demo`, { method: 'POST', headers: { Authorization: `Bearer ${publisher}`, apikey: ENV.ANON_KEY } });
  assert.equal(legacy.status, 404, 'legacy function not deployed');
  for (const rpc of ['gear_acquire_lease', 'gear_record_publication', 'gear_authorize_write', 'gear_prepare_write', 'gear_record_drift_ack']) {
    const res = await svc(rpc, {});
    assert.equal(res.status, 404, `${rpc}: ${res.status}`);
  }
  assert.equal(sql(`select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'gear_publication_head' and column_name like 'lease%'`), '0');
  assert.equal(sql(`select count(*) from pg_policies where schemaname = 'storage' and policyname like 'gear catalog%'`), '0');
  assert.equal(sql(`select count(*) from pg_trigger where tgrelid = 'storage.objects'::regclass and tgname like 'gear%'`), '0');
  assert.equal(sql(`select count(*) from information_schema.tables where table_name in ('gear_storage_drift_acks', 'gear_write_grants')`), '0');
});
