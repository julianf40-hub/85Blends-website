#!/usr/bin/env node
// Browser regression checks for review findings on PR #7 (Playwright; not a repository dependency).
//
//   node _admin-prototype/server.mjs --reset &      # http://127.0.0.1:4174
//   node _admin-prototype/tools/ui-regression.cjs [http://127.0.0.1:4174]
//
// 1. Edits typed while a draft save is in flight survive the save response.
// 2. Retained unsaved edits keep their original base version, so a later save shows the conflict
//    dialog instead of overwriting another session's save.
// 3. After drift is acknowledged, server checks and the Changes view compare against the
//    acknowledged Storage document (it passes catalog validation, so a conforming client could have
//    accepted it; actual device/cache state is unknown), not the latest recorded publication.
// 4. HEIF/HEIC uploads are refused by the browser and the server.
// 5. A far-future valid catalog in Storage is reported as an incident and blocks publishing.
// Each check resets the prototype data first. Exit status 1 on any failure.

const { chromium } = require('playwright');
const base = process.argv[2] ?? 'http://127.0.0.1:4174';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

async function session(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('dialog', (d) => d.accept());
  await page.goto(base);
  await page.evaluate(() => { sessionStorage.setItem('prototype-user', 'publisher@example.test'); sessionStorage.setItem('prototype-aal', 'aal2'); });
  await page.reload();
  await page.waitForSelector('.brand-item');
  return page;
}
const api = (page, path, body) => page.evaluate(async ([p, b]) => {
  const r = await fetch(p, { method: 'POST', headers: { 'X-Prototype-User': 'publisher@example.test', 'X-Prototype-AAL': 'aal2', 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  return { status: r.status, data: await r.json() };
}, [path, body]);
async function reset(page) { await api(page, '/api/dev/reset', {}); await page.reload(); await page.waitForSelector('.brand-item'); }
async function publishStaging(page) {
  await page.click('[data-action="tab"][data-tab="publish"]');
  await page.click('[data-action="review"][data-target="staging"]');
  await page.waitForSelector('.target.staging .review');
  await page.click('[data-action="publish"][data-target="staging"]');
  await page.waitForTimeout(700);
}

(async () => {
  const browser = await chromium.launch();

  // 1. Save in flight -------------------------------------------------------------------------
  {
    const page = await session(browser);
    await reset(page);
    await page.fill('[data-bind="priceText"]', 'From $1');
    await page.route('**/api/draft', async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue(); });
    await page.click('[data-action="save"]');
    await page.waitForTimeout(200);
    await page.fill('[data-bind="tagline"]', 'Typed while saving');
    await page.waitForTimeout(2000);
    await page.unroute('**/api/draft');
    const tagline = await page.inputValue('[data-bind="tagline"]');
    const status = await page.textContent('#draft-status .pill');
    check('1. edits typed during an in-flight save are kept', tagline === 'Typed while saving' && /Unsaved/.test(status), `tagline="${tagline}", status="${status}"`);
    await page.close();
  }

  // 2. Retained edits keep their base ---------------------------------------------------------
  {
    const page = await session(browser);
    await reset(page);
    await api(page, '/api/dev/fault', { target: 'staging', fault: 'crash_after_commit' });
    await publishStaging(page); // simulated crash: Storage pending -> "Reconcile now" appears
    await page.click('[data-action="tab"][data-tab="publish"]');
    await page.fill('[data-bind="priceText"]', 'From $2 (mine)');
    await api(page, '/api/dev/simulate-other-editor', {}); // another session saves a newer draft
    await page.click('[data-action="reconcile"][data-target="staging"]'); // reloads state, keeping my edits
    await page.waitForTimeout(600);
    await page.click('[data-action="save"]');
    await page.waitForTimeout(600);
    const conflict = await page.isVisible('dialog[open] #dialog-title');
    const state = await page.evaluate(async () => (await (await fetch('/api/state', { headers: { 'X-Prototype-User': 'publisher@example.test', 'X-Prototype-AAL': 'aal2' } })).json()).draft);
    const overwritten = !state.catalog.brands[0].tagline.includes('(edited elsewhere)');
    check('2. a retained working copy keeps its base; saving shows the conflict instead of overwriting', conflict && !overwritten, `conflict dialog=${conflict}, other session's edit overwritten=${overwritten}`);
    await page.close();
  }

  // 3. Baseline after acknowledged drift ------------------------------------------------------
  {
    const page = await session(browser);
    await reset(page);
    await publishStaging(page);
    const cli = await api(page, '/api/dev/external-write', { target: 'staging', kind: 'cli' }); // removes the first card
    const state = await page.evaluate(async () => (await (await fetch('/api/state', { headers: { 'X-Prototype-User': 'publisher@example.test', 'X-Prototype-AAL': 'aal2' } })).json()).storage.staging);
    const ack = await api(page, '/api/drift/acknowledge', { target: 'staging', digest: state.originDigest });
    await page.reload(); await page.waitForSelector('.brand-item');
    await page.click('[data-action="tab"][data-tab="publish"]');
    await page.click('[data-action="review"][data-target="staging"]');
    await page.waitForSelector('.target.staging .review');
    const summary = await page.textContent('.target.staging .review strong');
    await page.click('[data-action="tab"][data-tab="changes"]');
    await page.selectOption('[data-action="changes-target"]', 'staging');
    await page.waitForTimeout(300);
    const changes = await page.textContent('#side');
    check('3. after acknowledged drift, server checks and Changes compare with the Storage document', cli.status === 200 && ack.status === 200 && /added/.test(summary) && /1 added/.test(changes) && /acknowledged Storage/i.test(changes),
      `cli=${cli.status} ack=${ack.status} review="${summary}"`);
    await page.close();
  }

  // 4. HEIF disabled --------------------------------------------------------------------------
  {
    const page = await session(browser);
    const accept = await page.evaluate(() => {
      const button = document.querySelector('[data-action="upload"]');
      return button ? 'present' : 'none';
    });
    const sign = await api(page, '/api/uploads/sign', { brandId: 'northwind-sensors', contentType: 'image/heic', byteLength: 10, sha256: 'a'.repeat(64) });
    const help = await page.textContent('#editor');
    check('4. HEIF/HEIC uploads are refused (server 415; UI says PNG/JPEG only)', sign.status === 415 && /PNG or JPEG/.test(help) && accept === 'present', `server=${sign.status}`);
    await page.close();
  }

  // 5. Far-future valid catalog in Storage: incident banner, no acknowledge, publishing blocked ----
  {
    const page = await session(browser);
    await reset(page);
    await publishStaging(page);
    await api(page, '/api/dev/external-write', { target: 'staging', kind: 'future' });
    await page.reload(); await page.waitForSelector('.brand-item');
    await page.click('[data-action="tab"][data-tab="publish"]');
    const panel = await page.textContent('.target.staging');
    const ackButton = await page.$('.target.staging [data-action="ack-drift"]');
    const publish = await api(page, '/api/publish', { target: 'staging', draftVersion: 1, expectedLiveRevision: null });
    check('5. far-future valid catalog: incident shown, cannot be acknowledged, publishing blocked',
      /INCIDENT/.test(panel) && !ackButton && publish.status === 409, `ack button=${!!ackButton}, publish=${publish.status} ${publish.data.error}`);
    await page.close();
  }

  await browser.close();
  process.exit(results.every((r) => r.ok) ? 0 : 1);
})();
