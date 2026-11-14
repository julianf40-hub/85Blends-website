// Browser verification of the admin UI in LOCAL SUPABASE mode (fictional data, local stack only).
//   tools/start-local.sh            # once: local stack with the local sb_secret_ key for gear-publish
//   node tools/ui-local-supabase.mjs [screenshot-dir]
// Resets the LOCAL database, starts server.mjs --backend=local-supabase on 127.0.0.1:4174 (an origin
// gear-publish allows), and drives real local sign-in + TOTP through Chromium. Nothing here can reach
// a hosted project: server.mjs refuses non-loopback Supabase URLs.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { deflateSync, crc32 } from 'node:zlib';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { ENV, resetLocalDatabase, totp, sleep, fn, sql, serviceWrite, publicRead } from '../tests/helpers.mjs';
import { USERS, LOCAL_TEST_PASSWORD } from './make-seed.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = 'http://127.0.0.1:4174';
const SHOTS = process.argv[2] ?? null;
const STEP_UP_SECONDS = 40; // GEAR_PRODUCTION_STEP_UP_SECONDS in supabase/config.toml
const results = [];
let phase = ''; // the wait currently in progress (named in failure output)
const fnLog = []; // every gear-publish response seen by session A
const at = (name) => { phase = name; };
const step = async (name, run) => {
  const started = Date.now();
  try { await run(); results.push({ name, ok: true, ms: Date.now() - started }); console.log(`ok   ${name}`); }
  catch (error) {
    results.push({ name, ok: false, error: error.message });
    console.log(`FAIL ${name}\n     ${error.message.split('\n')[0]}\n     phase: ${phase}\n     last gear-publish responses (A): ${JSON.stringify(fnLog.slice(-8))}`);
    for (const [who, p] of [['A', A], ['B', Bp]]) {
      const state = await p.evaluate(() => ({ toasts: [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent), dialog: document.querySelector('#dialog[open]')?.textContent?.replace(/\s+/g, ' ').slice(0, 600) ?? null })).catch(() => null);
      console.log(`     ${who}:`, JSON.stringify(state));
    }
    throw error;
  }
};

// ---- fixtures ------------------------------------------------------------------------------------
function png(seed) { // a valid, unique 4x4 RGB PNG
  const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4); data.copy(b, 8); b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])), 8 + data.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(4 * (1 + 12)); for (let y = 0; y < 4; y++) for (let i = 0; i < 12; i++) raw[y * 13 + 1 + i] = (seed * 37 + y * 11 + i * 5) & 0xff;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const heif = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(16)]);

// ---- page helpers -----------------------------------------------------------------------------------
const toastText = async (page, re, timeout = 15000) => {
  await page.waitForFunction((src) => [...document.querySelectorAll('#toasts .toast')].some((t) => new RegExp(src).test(t.textContent)), re.source, { timeout });
  return page.$$eval('#toasts .toast', (ts) => ts.map((t) => t.textContent).join(' | '));
};
const sideText = async (page) => (await page.textContent('#side')).replace(/\s+/g, ' ');
const tab = (page, name) => page.click(`[data-action=tab][data-tab=${name}]`);
const sessionOf = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('gear-admin-local-session')));
async function shot(page, name) { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); }

const lastCode = {};
async function freshCode(secret) { // never reuse a TOTP code: wait for the next 30 s window if needed
  while (lastCode[secret] === Math.floor(Date.now() / 30000)) await sleep(500);
  lastCode[secret] = Math.floor(Date.now() / 30000);
  return totp(secret);
}
async function signIn(page, who, knownSecret = null) {
  await page.goto(BASE);
  await page.fill('input[name=email]', USERS[who].email);
  await page.fill('input[name=password]', LOCAL_TEST_PASSWORD);
  await page.click('form[data-form=sign-in] button[type=submit]');
  await page.waitForSelector('form[data-form=totp]', { timeout: 15000 });
  const secret = knownSecret ?? (await page.textContent('[data-testid=totp-secret]', { timeout: 15000 })).trim();
  await page.fill('form[data-form=totp] input[name=code]', await freshCode(secret));
  const verifiedAt = Date.now();
  await page.click('form[data-form=totp] button[type=submit]');
  return { secret, verifiedAt };
}
async function editField(page, rel, value) {
  await page.fill(`#editor [data-bind="${rel}"]`, value);
  await page.click('[data-action=save]');
  return toastText(page, /Draft saved · version \d+/);
}
// D11: Staging is public; the publisher confirms the draft is fictional or approved for public viewing.
async function confirmPublic(page) {
  if (!(await page.isChecked('[data-action=staging-public-ok]'))) await page.check('[data-action=staging-public-ok]');
}
async function runChecks(page, target) {
  await tab(page, 'publish');
  await page.click(`[data-action=review][data-target=${target}]`);
  await page.waitForFunction((t) => /Server checks pass|class="error"/.test(document.querySelector(`section.target.${t}`)?.innerHTML ?? '') && !!document.querySelector(`section.target.${t} .review`), target, { timeout: 15000 });
}

// ---- run --------------------------------------------------------------------------------------------
resetLocalDatabase();
const server = spawn(process.execPath, [new URL('../../server.mjs', import.meta.url).pathname, '--backend=local-supabase'], {
  env: { ...process.env, PORT: '4174', GEAR_SUPABASE_URL: ENV.API_URL, GEAR_SUPABASE_PUBLISHABLE_KEY: ENV.PUBLISHABLE_KEY }, stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => { server.stdout.on('data', (d) => /LOCAL SUPABASE mode/.test(d) && resolve()); server.on('exit', (c) => reject(new Error(`server exited ${c}`))); });
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch();
const ctxA = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const ctxB = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const A = await ctxA.newPage(); // publisher
const Bp = await ctxB.newPage(); // editor
for (const p of [A, Bp]) p.on('pageerror', (e) => console.log('pageerror:', e.message));
A.on('response', async (res) => {
  // gear-publish calls and draft saves (PostgREST RPC); both appear in failure output.
  if (res.url().includes('/rest/v1/rpc/save_gear_draft')) {
    fnLog.push({ t: new Date().toISOString().slice(11, 23), action: 'save_gear_draft', status: res.status(), error: res.status() >= 400 ? (await res.text().catch(() => '')).slice(0, 120) : null });
    return;
  }
  if (!res.url().includes('/functions/v1/gear-publish')) return;
  let action = null; try { action = JSON.parse(res.request().postData() ?? '{}').action ?? new URL(res.url()).searchParams.get('action'); } catch { /* binary */ }
  let error = null; try { error = res.status() >= 400 ? (await res.json()).error : null; } catch { /* no body */ }
  fnLog.push({ t: new Date().toISOString().slice(11, 23), action, status: res.status(), error });
});
const lifetimeOf = (s) => { const c = JSON.parse(Buffer.from(s.access_token.split('.')[1], 'base64url')); return c.exp - c.iat; };
let aTotp;

try {
  await step('sign-in + TOTP enrollment (publisher, editor) reaches aal2; outsider is refused', async () => {
    aTotp = await signIn(A, 'publisher');
    await A.waitForSelector('#brand-list li', { timeout: 15000 });
    assert.match(await A.textContent('#mode-banner'), /LOCAL SUPABASE MODE/);
    assert.equal(await A.textContent('[data-testid=aal]'), 'aal2');
    assert.equal(await A.locator('details.devtools').count(), 0, 'simulated prototype tools are not offered');
    await signIn(Bp, 'editor');
    await Bp.waitForSelector('#brand-list li', { timeout: 15000 });
    const C = await (await browser.newContext()).newPage();
    await signIn(C, 'outsider');
    await C.waitForSelector('.error-block', { timeout: 15000 });
    assert.match(await C.textContent('.error-block'), /not a Recommended Gear administrator/);
    await shot(A, '01-signed-in-local');
  });

  await step('wrong TOTP code is refused (stays at aal1)', async () => {
    const C = await (await browser.newContext()).newPage();
    await C.goto(BASE);
    await C.fill('input[name=email]', USERS.spare.email);
    await C.fill('input[name=password]', LOCAL_TEST_PASSWORD);
    await C.click('form[data-form=sign-in] button[type=submit]');
    await C.waitForSelector('[data-testid=totp-secret]');
    await C.fill('form[data-form=totp] input[name=code]', '000000');
    await C.click('form[data-form=totp] button[type=submit]');
    await C.waitForSelector('.error-block', { timeout: 15000 });
    assert.ok((await sessionOf(C)) && JSON.parse(Buffer.from((await sessionOf(C)).access_token.split('.')[1], 'base64url')).aal === 'aal1');
  });

  await step('simulated API is disabled in this mode', async () => {
    assert.equal(await A.evaluate(async () => (await fetch('/api/state')).status), 404);
  });

  await step('draft conflict: second session is stopped and shown both changes', async () => {
    await editField(A, 'tagline', 'Publisher edit from session A');
    await Bp.fill('#editor [data-bind="description"]', 'Editor edit from session B, based on the old version');
    await Bp.click('[data-action=save]');
    await Bp.waitForSelector('#dialog[open] >> text=Someone else saved the draft', { timeout: 15000 });
    const dialog = await Bp.textContent('#dialog');
    assert.match(dialog, /Their changes/); assert.match(dialog, /Your unsaved changes/);
    await shot(Bp, '02-draft-conflict');
    await Bp.click('[data-action=conflict-theirs]');
    assert.match(await Bp.textContent('#draft-status'), /Draft v2/);
    assert.equal(sql(`select version from public.gear_catalog_drafts`), '2');
  });

  await step('reviewed-change binding: a draft saved after the review is refused', async () => {
    await runChecks(A, 'staging');
    await editField(Bp, 'tagline', 'Editor change after the publisher reviewed');
    await confirmPublic(A); await A.click('[data-action=publish][data-target=staging]');
    assert.match(await toastText(A, /draft is now version 3/), /you reviewed version 2/);
    assert.equal(sql(`select count(*) from public.gear_catalog_publications`), '0');
  });

  await step('reviewed-change binding: a review digest that differs from the server computation is refused', async () => {
    await runChecks(A, 'staging');
    await A.route('**/functions/v1/gear-publish', async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}');
      if (body.action !== 'publish') return route.continue();
      return route.continue({ postData: JSON.stringify({ ...body, reviewDigest: '0'.repeat(64) }) });
    });
    await confirmPublic(A); await A.click('[data-action=publish][data-target=staging]');
    await toastText(A, /differs from what you reviewed/);
    await A.unroute('**/functions/v1/gear-publish');
    assert.equal(sql(`select count(*) from public.gear_catalog_publications`), '0');
  });

  await step('staging publish: one database commit; the endpoint serves it', async () => {
    await A.reload(); await A.waitForSelector('#brand-list li');
    await runChecks(A, 'staging');
    assert.equal(await A.isDisabled('[data-action=publish][data-target=staging]'), true, 'disabled until the public-content confirmation');
    await confirmPublic(A); await A.click('[data-action=publish][data-target=staging]');
    await A.waitForSelector('[data-testid=result-staging]', { timeout: 20000 });
    assert.match(await A.textContent('[data-testid=result-staging]'), /committed/);
    assert.match(await A.textContent('[data-testid=staging-public]'), /PUBLIC/);
    assert.match(await A.textContent('[data-testid=staging-public-note]'), /Staging is public/);
    assert.equal(sql(`select status from public.gear_publication_status order by id desc limit 1`), 'committed');
    const served = await fetch(`${ENV.API_URL}/functions/v1/gear-catalog/staging`);
    assert.equal(served.headers.get('x-gear-revision'), sql(`select revision from public.gear_publication_head where target = 'staging'`));
    await shot(A, '03-staging-published');
  });

  await step(`production: step-up required after ${STEP_UP_SECONDS} s, fresh TOTP then publish`, async () => {
    // Production gates partner approval (dashboard-only meta): record it through the editor first.
    await A.click('#brand-list button.brand-select >> text=Northwind Sensors');
    await A.selectOption('#editor [data-action=approval]', 'approved');
    await A.click('[data-action=save]');
    await toastText(A, /Draft saved · version \d+/);
    const wait = aTotp.verifiedAt + (STEP_UP_SECONDS + 2) * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    await runChecks(A, 'production');
    const review = await A.textContent('section.target.production .review');
    assert.match(review, /Server checks pass/, `production checks: ${review}`);
    await A.check('[data-action=ack]');
    await A.fill('[data-action=confirm-text]', 'PUBLISH PRODUCTION');
    await A.click('[data-action=publish][data-target=production]');
    await A.waitForSelector('#dialog[open] >> text=Verify again for Production', { timeout: 15000 });
    assert.match(await A.textContent('#dialog'), /TOTP verification within the last 40 s/);
    assert.equal(sql(`select count(*) from public.gear_catalog_publications where target = 'production'`), '0', 'nothing recorded before step-up');
    await shot(A, '04-production-step-up');
    await A.fill('#dialog input[name=code]', await freshCode(aTotp.secret));
    await A.click('#dialog button[type=submit]');
    await A.waitForSelector('[data-testid=result-production]', { timeout: 20000 });
    assert.match(await A.textContent('[data-testid=result-production]'), /committed/);
  });

  await step('lost response: the commit succeeds but the browser gets a 502; the UI retries the same operation and gets the original', async () => {
    at('lost response: publish, server commits, response replaced by 502');
    await editField(A, 'tagline', 'Committed, but the response was lost');
    await runChecks(A, 'staging');
    const before = Number(sql(`select count(*) from public.gear_catalog_publications where target = 'staging'`));
    let opId = null;
    await A.route('**/functions/v1/gear-publish', async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}');
      if (body.action !== 'publish' || opId) return route.continue();
      opId = body.operationId;
      await route.fetch();                                    // the server really processes and commits it
      return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"bad_gateway","message":"upstream response lost"}' });
    });
    await confirmPublic(A); await A.click('[data-action=publish][data-target=staging]');
    await A.waitForSelector('[data-testid=unknown-staging]', { timeout: 20000 });
    await A.unroute('**/functions/v1/gear-publish');
    assert.equal(Number(sql(`select count(*) from public.gear_catalog_publications where target = 'staging'`)), before + 1, 'it was committed');
    await shot(A, '05-outcome-unknown');
    at('lost response: retry with the same operation');
    const retried = A.waitForRequest((r) => r.url().includes('/functions/v1/gear-publish') && /"action":"publish"/.test(r.postData() ?? ''));
    await A.click('[data-action=retry-publish][data-target=staging]');
    assert.equal(JSON.parse((await retried).postData()).operationId, opId, 'the retry reuses the operation ID');
    await A.waitForSelector('[data-testid=result-staging] >> text=replayed', { timeout: 20000 });
    assert.equal(Number(sql(`select count(*) from public.gear_catalog_publications where target = 'staging'`)), before + 1, 'no second publication');
  });

  await step('rollback (staging) from History: reviewed by the server, recorded as a new publication', async () => {
    at('rollback: open History (staging)');
    await tab(A, 'history');
    await A.selectOption('[data-action=history-target]', 'staging');
    await A.waitForSelector('[data-action=history-rollback]', { timeout: 15000 });
    const before = Number(sql(`select count(*) from public.gear_catalog_publications where target = 'staging'`));
    at('rollback: open dialog (server review of the rollback)');
    await A.click('[data-action=history-rollback] >> nth=-1'); // the oldest staging publication
    await A.waitForSelector('#dialog[open] [data-action=rollback-go]:not([disabled])', { timeout: 15000 });
    await shot(A, '06-rollback-dialog');
    at('rollback: publish rollback and wait for the success toast');
    await A.click('#dialog [data-action=rollback-go]');
    await toastText(A, /Rollback recorded as revision/, 20000);
    at('rollback: History shows the rollback chip');
    assert.equal(Number(sql(`select count(*) from public.gear_catalog_publications where target = 'staging'`)), before + 1);
    assert.ok(sql(`select rollback_of from public.gear_catalog_publications where target = 'staging' order by published_at desc limit 1`));
    await A.waitForSelector('#side .chip >> text=rollback');
  });

  await step('no second channel: a key-holder write to the old Storage object changes nothing apps receive; the verifier reports it', async () => {
    at('legacy object: key-holder write');
    const served = await (await fetch(`${ENV.API_URL}/functions/v1/gear-catalog/staging`)).text();
    const foreign = JSON.parse(served); foreign.revision = crypto.randomUUID(); foreign.publishedAt += 9999; foreign.brands = [];
    assert.equal((await serviceWrite('staging', JSON.stringify(foreign))).status, 200, 'the legacy bucket is unchanged, so a key holder can still write it');
    assert.equal(await (await fetch(`${ENV.API_URL}/functions/v1/gear-catalog/staging`)).text(), served, 'apps still receive the database publication');
    await A.reload(); await A.waitForSelector('#brand-list li');
    await tab(A, 'publish');
    assert.match(await A.textContent('section.target.staging'), /database pointer/);
    at('legacy object: verifier');
    await A.click('[data-action=verify]');
    await A.waitForSelector('#dialog[open] >> text=Verifier report', { timeout: 20000 });
    assert.match(await A.textContent('#dialog'), /is NOT the publication channel/);
    await shot(A, '09-legacy-object-reported');
    await A.click('#dialog [data-action=dialog-close]');
  });

  await step('guests: a browser with no session reads Production from the public endpoint', async () => {
    const guest = await (await browser.newContext()).newPage();
    await guest.goto(`${ENV.API_URL}/functions/v1/gear-catalog/production`);
    const body = JSON.parse(await guest.textContent('body'));
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.revision, sql(`select revision from public.gear_publication_head where target = 'production'`));
  });

  await step('image upload: validated PNG stored content-addressed; HEIF refused', async () => {
    await tab(A, 'preview');
    const images = () => Number(sql(`select count(*) from storage.objects where name like 'images/%'`));
    const stored = images();
    const upload = A.locator('#editor [data-action=upload]').first();
    let chooser = A.waitForEvent('filechooser'); await upload.click();
    await (await chooser).setFiles({ name: 'gear.png', mimeType: 'image/png', buffer: png(Date.now() % 251) });
    await toastText(A, /validated and read back by the server/);
    assert.equal(images(), stored + 1);
    chooser = A.waitForEvent('filechooser'); await upload.click();
    await (await chooser).setFiles({ name: 'photo.heic', mimeType: 'image/heic', buffer: heif });
    await toastText(A, /HEIF\/HEIC is disabled/);
    chooser = A.waitForEvent('filechooser'); await upload.click();
    await (await chooser).setFiles({ name: 'disguised.png', mimeType: 'image/png', buffer: heif }); // HEIF bytes labelled PNG
    await A.waitForFunction(() => document.querySelectorAll('#toasts .toast.error').length >= 2, null, { timeout: 15000 });
    // The browser refuses those bytes before sending (it cannot decode them). Send the same request the
    // adapter would, from the page with the user's own session, to show the server refuses it too.
    const server = await A.evaluate(async ({ url, key, bytes }) => {
      const { access_token } = JSON.parse(sessionStorage.getItem('gear-admin-local-session'));
      const res = await fetch(`${url}/functions/v1/gear-publish?action=upload_image&brand=northwind-sensors`, { method: 'POST', body: new Uint8Array(bytes),
        headers: { apikey: key, Authorization: `Bearer ${access_token}`, 'Content-Type': 'image/png' } });
      return { status: res.status, body: await res.json() };
    }, { url: ENV.API_URL, key: ENV.PUBLISHABLE_KEY, bytes: [...heif] });
    assert.equal(server.status, 415); assert.equal(server.body.error, 'heif_disabled');
    assert.equal(images(), stored + 1, 'no HEIF bytes stored');
  });

  await step('verifier runs on demand: read-only report, unreferenced image reported but not deleted', async () => {
    const audit = Number(sql(`select count(*) from public.gear_audit_log where event = 'verify_run'`));
    await A.click('[data-action=verify]');
    await A.waitForSelector('#dialog[open] >> text=Verifier report', { timeout: 20000 });
    const text = await A.textContent('#dialog');
    assert.match(text, /unreferenced \(reported only; not deleted\)/);
    assert.match(text, /deleted: false/);
    assert.match(text, /Alert delivery is an open decision \(D1\)/);
    assert.equal(Number(sql(`select count(*) from public.gear_audit_log where event = 'verify_run'`)), audit + 1);
    await shot(A, '07-verifier');
    await A.click('#dialog [data-action=dialog-close]');
  });

  await step('session refresh: a session close to expiry is refreshed without signing out', async () => {
    const before = await sessionOf(A);
    await A.evaluate(() => { const s = JSON.parse(sessionStorage.getItem('gear-admin-local-session')); s.expires_at = Math.floor(Date.now() / 1000) + 3; sessionStorage.setItem('gear-admin-local-session', JSON.stringify(s)); });
    await A.reload(); await A.waitForSelector('#brand-list li', { timeout: 15000 });
    const after = await sessionOf(A);
    assert.notEqual(after.refresh_token, before.refresh_token, 'refresh token rotated');
    assert.ok(after.expires_at > Math.floor(Date.now() / 1000) + lifetimeOf(after) / 2);
  });

  await step('session ended elsewhere (global sign-out): next server action returns to sign-in', async () => {
    await Bp.reload(); await Bp.waitForSelector('#brand-list li'); // B was idle: let the adapter refresh first
    const { access_token: token } = await sessionOf(Bp);
    const res = await fetch(`${ENV.API_URL}/auth/v1/logout?scope=global`, { method: 'POST', headers: { apikey: ENV.PUBLISHABLE_KEY, Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 204);
    await tab(Bp, 'publish');
    await Bp.click('[data-action=review][data-target=staging]');
    await Bp.waitForSelector('form[data-form=sign-in]', { timeout: 15000 });
    assert.match(await Bp.textContent('.error-block'), /session ended/i);
    assert.equal(await sessionOf(Bp), null, 'local session cleared');
    await shot(Bp, '08-session-ended');
  });

  await step('sign-out clears the session (reload stays signed out)', async () => {
    await A.click('#account [data-action=sign-out]');
    await A.waitForSelector('form[data-form=sign-in]');
    await A.reload();
    await A.waitForSelector('form[data-form=sign-in]');
  });

  // ---- real access-token expiry (needs a short local lifetime: GEAR_LOCAL_JWT_EXPIRY=60 tools/start-local.sh)
  // Raw calls with one specific access token (not whatever the page holds now).
  const rawCalls = (page, access_token) => page.evaluate(async ({ url, key, access_token }) => {
    const h = { apikey: key, Authorization: `Bearer ${access_token}` };
    const rest = await fetch(`${url}/rest/v1/gear_catalog_drafts?select=version`, { headers: h });
    const fnr = await fetch(`${url}/functions/v1/gear-publish`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'inspect', target: 'staging' }) });
    const st = await fetch(`${url}/storage/v1/object/authenticated/recommended-gear/staging/catalog-v1.json`, { headers: h });
    return { rest: rest.status, restBody: (await rest.text()).slice(0, 120), fn: fnr.status, fnBody: (await fnr.text()).slice(0, 120), storage: st.status, storageBody: st.status === 200 ? '(object)' : (await st.text()).slice(0, 120) };
  }, { url: ENV.API_URL, key: ENV.PUBLISHABLE_KEY, access_token });
  const expOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).exp;
  // The page polls every 10 s while visible, which would refresh the token. Report the page as hidden
  // (its poll skips hidden pages) so the stored token really expires, then make it visible again.
  const setHidden = (page, hidden) => page.evaluate((h) => Object.defineProperty(document, 'hidden', { configurable: true, get: () => h }), hidden);
  // Idle past exp, then measure how long after exp each server still accepts the token (PostgREST
  // may allow clock skew). Returns { restAcceptedUntil, fnAcceptedUntil } in seconds after exp.
  const idleUntilExpired = async (page, token) => {
    await setHidden(page, true);
    while (Date.now() / 1000 < expOf(token) + 1) await sleep(250);
    const seen = { restAcceptedUntil: null, fnAcceptedUntil: null, storageAcceptedUntil: null, firstRestRefusalAfterExp: null };
    for (;;) {
      const r = await rawCalls(page, token);
      const after = Math.round(Date.now() / 1000 - expOf(token));
      if (r.rest === 200) seen.restAcceptedUntil = after;
      if (r.fn === 200) seen.fnAcceptedUntil = after;
      if (r.storage === 200) seen.storageAcceptedUntil = after;
      if (r.rest === 401) { seen.firstRestRefusalAfterExp = after; break; }
      if (after > 120) break;
      await sleep(1000);
    }
    await setHidden(page, false);
    return seen;
  };

  await step('real expiry: an expired access token is refused by PostgREST and the function; the UI refreshes and continues', async () => {
    await signIn(A, 'publisher', aTotp.secret);
    await A.waitForSelector('#brand-list li', { timeout: 15000 });
    const lifetime = lifetimeOf(await sessionOf(A));
    if (lifetime > 120) throw new Error(`access tokens last ${lifetime} s; restart with GEAR_LOCAL_JWT_EXPIRY=60 tools/start-local.sh for this check`);
    const before = await sessionOf(A);
    at(`real expiry: idle (no polling) until the ${lifetime} s token expires`);
    const window = await idleUntilExpired(A, before.access_token);
    assert.equal((await sessionOf(A)).access_token, before.access_token, 'the page still holds the same, now expired, token');
    const raw = await rawCalls(A, before.access_token);
    console.log(`EVIDENCE expired-token ${JSON.stringify({ lifetime, exp: expOf(before.access_token), now: Math.floor(Date.now() / 1000), ...window, ...raw })}`);
    assert.ok(window.firstRestRefusalAfterExp !== null, 'PostgREST eventually refuses the expired token');
    assert.equal(raw.rest, 401, 'PostgREST refuses the expired JWT');
    assert.equal(raw.fn, 401, 'gear-publish refuses the expired JWT');
    at('real expiry: a UI action refreshes and succeeds');
    await runChecks(A, 'staging');
    const after = await sessionOf(A);
    assert.notEqual(after.access_token, before.access_token);
    assert.ok(JSON.parse(Buffer.from(after.access_token.split('.')[1], 'base64url')).exp > Date.now() / 1000);
    assert.equal(await A.locator('form[data-form=sign-in]').count(), 0, 'still signed in');
  });

  await step('real expiry after revocation: the token keeps working at the database until it expires; then the UI returns to sign-in', async () => {
    await A.reload(); await A.waitForSelector('#brand-list li');
    const { access_token } = await sessionOf(A);
    await setHidden(A, true); // no polling from here: the page keeps exactly this token
    assert.equal((await fetch(`${ENV.API_URL}/auth/v1/logout?scope=global`, { method: 'POST', headers: { apikey: ENV.PUBLISHABLE_KEY, Authorization: `Bearer ${access_token}` } })).status, 204);
    const revoked = await rawCalls(A, access_token);
    console.log(`EVIDENCE revoked-not-expired ${JSON.stringify(revoked)}`);
    assert.equal(revoked.rest, 200, 'PostgREST still accepts a revoked but unexpired JWT (revocation is function-only, D5)');
    assert.equal(revoked.fn, 401, 'gear-publish checks the session with Auth and refuses');
    at('revoked: idle until the token expires');
    const window = await idleUntilExpired(A, access_token);
    const expired = await rawCalls(A, access_token);
    console.log(`EVIDENCE revoked-and-expired ${JSON.stringify({ ...window, ...expired })}`);
    assert.equal(expired.rest, 401);
    at('revoked: a UI action cannot refresh and returns to sign-in');
    await tab(A, 'publish');
    await A.click('[data-action=review][data-target=staging]');
    await A.waitForSelector('form[data-form=sign-in]', { timeout: 15000 });
    assert.match(await A.textContent('.error-block'), /session ended/i);
  });
} finally {
  await browser.close();
  server.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
  process.exitCode = failed.length ? 1 : 0;
}
