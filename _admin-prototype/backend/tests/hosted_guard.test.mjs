// Local, static checks of the hosted-test guard, the hosted harness's isolation from local behavior,
// and the admin server's hosted-test mode. No network, no hosted project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hostedTestTarget, HostedTargetRefused } from '../tools/hosted-target.mjs';

const TEST_REF = 'abcdefghijklmnopqrst';            // fictional refs (20 lowercase letters)
const PROD_REF = 'zyxwvutsrqponmlkjihg';
const KEY = ['sb', 'publishable', 'fictionalkey123'].join('_');
const good = { GEAR_HOSTED_TEST_PROJECT_REF: TEST_REF, GEAR_HOSTED_TEST_URL: `https://${TEST_REF}.supabase.co`, GEAR_HOSTED_TEST_CONFIRM: TEST_REF,
  GEAR_PRODUCTION_PROJECT_REFS: PROD_REF, GEAR_HOSTED_TEST_PUBLISHABLE_KEY: KEY };
const refused = (env, why) => assert.throws(() => hostedTestTarget(env), (e) => e instanceof HostedTargetRefused && why.test(e.message));

test('the guard accepts only a fully specified, confirmed, non-production target with a publishable key', () => {
  assert.deepEqual({ ...hostedTestTarget(good) }, { ref: TEST_REF, url: `https://${TEST_REF}.supabase.co`, publishableKey: KEY });
});

test('the guard refuses production, missing production refs, URL tricks, missing confirmation and privileged keys', () => {
  refused({ ...good, GEAR_PRODUCTION_PROJECT_REFS: '' }, /must list the production/);
  refused({ ...good, GEAR_PRODUCTION_PROJECT_REFS: `${PROD_REF},${TEST_REF}` }, /is a production project/);
  refused({ ...good, GEAR_HOSTED_TEST_PROJECT_REF: PROD_REF, GEAR_HOSTED_TEST_URL: `https://${PROD_REF}.supabase.co`, GEAR_HOSTED_TEST_CONFIRM: PROD_REF }, /is a production project/);
  refused({ ...good, GEAR_HOSTED_TEST_URL: `https://${PROD_REF}.supabase.co` }, /must be exactly/);
  refused({ ...good, GEAR_HOSTED_TEST_URL: `http://${TEST_REF}.supabase.co` }, /must be exactly/);
  refused({ ...good, GEAR_HOSTED_TEST_URL: `https://${TEST_REF}.supabase.co/rest/v1` }, /must be exactly/);
  refused({ ...good, GEAR_HOSTED_TEST_URL: `https://${TEST_REF}.supabase.co.evil.example` }, /must be exactly/);
  refused({ ...good, GEAR_HOSTED_TEST_CONFIRM: '' }, /must repeat/);
  refused({ ...good, GEAR_HOSTED_TEST_PROJECT_REF: 'NOT-A-REF' }, /must be a project ref/);
  refused({ ...good, GEAR_HOSTED_TEST_PUBLISHABLE_KEY: ['sb', 'secret', 'x'].join('_') }, /publishable key/);
  refused({ ...good, SUPABASE_SERVICE_ROLE_KEY: 'x' }, /SUPABASE_SERVICE_ROLE_KEY is set/);
  refused({ ...good, GEAR_PUBLISHER_SECRET_KEY: 'x' }, /GEAR_PUBLISHER_SECRET_KEY is set/);
});

test('the hosted harness refuses to start without a valid target, before any request', () => {
  const harness = fileURLToPath(new URL('./hosted/run-hosted-checks.mjs', import.meta.url));
  // A proxy that does not exist: if the harness tried the network, it would fail differently.
  const r = spawnSync(process.execPath, ['--test', harness], { encoding: 'utf8', env: { PATH: process.env.PATH, HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9' } });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /hosted test target refused/);
  assert.doesNotMatch(r.stdout + r.stderr, /EVIDENCE|ECONNREFUSED/);
});

test('the hosted harness cannot inherit local reset, seed, SQL, Docker or service-key behavior', () => {
  // Code only: the header comment deliberately names what the harness does NOT do.
  const src = readFileSync(new URL('./hosted/run-hosted-checks.mjs', import.meta.url), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(src, /from '\.\.\/helpers\.mjs'|resetLocalDatabase|db reset|seed|psql|docker|execSync|SERVICE_ROLE|svc\(/);
  assert.match(src, /const target = hostedTestTarget\(process\.env\);/);
  assert.doesNotMatch(src, /target: 'production'(?![^\n]*operation_conflict|[^\n]*confirmation)/, 'no production publish except the refused cross-environment attempt');
  // Not picked up by the default local run (tests/*.test.mjs).
  assert.doesNotMatch('hosted/run-hosted-checks.mjs', /^[^/]*\.test\.mjs$/);
});

test('admin server hosted-test mode: refuses production, serves only public config, CSP limited to that project', async () => {
  const { hostedTestBackend, createAdminServer } = await import('../../server.mjs');
  assert.throws(() => hostedTestBackend({ ...good, GEAR_PRODUCTION_PROJECT_REFS: TEST_REF }), /production project/);
  const backend = hostedTestBackend(good);
  const { server } = createAdminServer({ backend });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/config.json`);
    const config = await res.json();
    assert.deepEqual(Object.keys(config).sort(), ['mode', 'productionConfirmation', 'projectRef', 'publishableKey', 'supabaseUrl']);
    assert.equal(config.mode, 'hosted-test'); assert.equal(config.projectRef, TEST_REF);
    assert.match(res.headers.get('content-security-policy'), new RegExp(`connect-src 'self' https://${TEST_REF}\\.supabase\\.co;`));
    assert.equal((await fetch(`${base}/api/state`)).status, 404, 'simulated API disabled');
  } finally { server.close(); }
});
