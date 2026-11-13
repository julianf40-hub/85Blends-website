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
import { ENV, resetLocalDatabase, totp, sleep, fn, sql } from '../tests/helpers.mjs';
import { USERS, LOCAL_TEST_PASSWORD } from './make-seed.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = 'http://127.0.0.1:4174';
const SHOTS = process.argv[2] ?? null;
const STEP_UP_SECONDS = 40; // GEAR_PRODUCTION_STEP_UP_SECONDS in supabase/config.toml
const results = [];
const step = async (name, run) => {
  const started = Date.now();
  try { await run(); results.push({ name, ok: true, ms: Date.now() - started }); console.log(`ok   ${name}`); }
  catch (error) {
    results.push({ name, ok: false, error: error.message });
    console.log(`FAIL ${name}\n     ${error.message.split('\n')[0]}`);
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

async function signIn(page, who) {
  await page.goto(BASE);
  await page.fill('input[name=email]', USERS[who].email);
  await page.fill('input[name=password]', LOCAL_TEST_PASSWORD);
  await page.click('form[data-form=sign-in] button[type=submit]');
  const secret = (await page.textContent('[data-testid=totp-secret]', { timeout: 15000 })).trim();
  await page.fill('form[data-form=totp] input[name=code]', totp(secret));
  const verifiedAt = Date.now();
  await page.click('form[data-form=totp] button[type=submit]');
  return { secret, verifiedAt };
}
async function editField(page, rel, value) {
  await page.fill(`#editor [data-bind="${rel}"]`, value);
  await page.click('[data-action=save]');
  return toastText(page, /Draft saved · version \d+/);
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
    await A.click('[data-action=publish][data-target=staging]');
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
    await A.click('[data-action=publish][data-target=staging]');
    await toastText(A, /differs from what you reviewed/);
    await A.unroute('**/functions/v1/gear-publish');
    assert.equal(sql(`select count(*) from public.gear_catalog_publications`), '0');
  });

  await step('staging publish: recorded, uploaded and read back', async () => {
    await A.reload(); await A.waitForSelector('#brand-list li');
    await runChecks(A, 'staging');
    await A.click('[data-action=publish][data-target=staging]');
    await A.waitForSelector('[data-testid=result-staging]', { timeout: 20000 });
    assert.match(await A.textContent('[data-testid=result-staging]'), /verified/);
    assert.equal(sql(`select status from public.gear_publication_status order by id desc limit 1`), 'verified');
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
    await A.fill('#dialog input[name=code]', totp(aTotp.secret));
    await A.click('#dialog button[type=submit]');
    await A.waitForSelector('[data-testid=result-production]', { timeout: 20000 });
    assert.match(await A.textContent('[data-testid=result-production]'), /verified/);
  });

  await step('reconcile: an uncertain upload is detected and repaired from the browser', async () => {
    await editField(A, 'tagline', 'Change that will hit an upload timeout');
    const { access_token: token } = await sessionOf(A);
    const draftVersion = Number(sql(`select version from public.gear_catalog_drafts`));
    const head = sql(`select revision from public.gear_publication_head where target = 'staging'`);
    const r = await fn(token, { action: 'review', target: 'staging' });
    const p = await fn(token, { action: 'publish', target: 'staging', draftVersion, expectedLiveRevision: head, reviewDigest: r.data.reviewDigest }, { 'x-gear-test-fault': 'upload_timeout' });
    assert.equal(p.data.storage, "uncertain", JSON.stringify(p.data));
    await A.reload(); await A.waitForSelector('#brand-list li');
    await tab(A, 'publish');
    assert.match(await A.textContent('section.target.staging'), /not confirmed in Storage/);
    await shot(A, '05-reconcile-pending');
    await A.click('[data-action=reconcile][data-target=staging]');
    await toastText(A, /Reconcile \(staging\): (repaired|in_sync)/);
    await A.waitForFunction(() => /origin holds the latest recorded publication|repaired/.test(document.querySelector('section.target.staging')?.textContent ?? ''));
  });

  await step('rollback (staging) from History: reviewed by the server, recorded as a new publication', async () => {
    await tab(A, 'history');
    await A.selectOption('[data-action=history-target]', 'staging');
    await A.waitForSelector('[data-action=history-rollback]', { timeout: 15000 });
    const before = Number(sql(`select count(*) from public.gear_catalog_publications where target = 'staging'`));
    await A.click('[data-action=history-rollback] >> nth=-1'); // the oldest staging publication
    await A.waitForSelector('#dialog[open] [data-action=rollback-go]:not([disabled])', { timeout: 15000 });
    await shot(A, '06-rollback-dialog');
    await A.click('#dialog [data-action=rollback-go]');
    await toastText(A, /Rollback recorded as revision/, 20000);
    assert.equal(Number(sql(`select count(*) from public.gear_catalog_publications where target = 'staging'`)), before + 1);
    assert.ok(sql(`select rollback_of from public.gear_catalog_publications where target = 'staging' order by published_at desc limit 1`));
    await A.waitForSelector('#side .chip >> text=rollback');
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
    await A.evaluate(() => { const s = JSON.parse(sessionStorage.getItem('gear-admin-local-session')); s.expires_at = Math.floor(Date.now() / 1000) + 30; sessionStorage.setItem('gear-admin-local-session', JSON.stringify(s)); });
    await A.reload(); await A.waitForSelector('#brand-list li', { timeout: 15000 });
    const after = await sessionOf(A);
    assert.notEqual(after.refresh_token, before.refresh_token, 'refresh token rotated');
    assert.ok(after.expires_at > Math.floor(Date.now() / 1000) + 600);
  });

  await step('session ended elsewhere (global sign-out): next server action returns to sign-in', async () => {
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
} finally {
  await browser.close();
  server.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
  process.exitCode = failed.length ? 1 : 0;
}
