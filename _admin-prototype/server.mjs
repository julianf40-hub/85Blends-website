#!/usr/bin/env node
// 85Blends Admin — Recommended Gear: LOCAL PROTOTYPE SERVER.
//
//   node _admin-prototype/server.mjs            → http://127.0.0.1:4174
//
// This process stands in for the planned server side (Supabase Auth + RLS tables + Edge Functions
// gear-draft, gear-upload-url, gear-publish; see IMPLEMENTATION_PLAN.md). Every rule that must be
// enforced server-side is enforced HERE, not in the browser: roles, MFA level, the draft's
// optimistic lock, the publish lock, publishedAt/revision stamping, validation, approval gate,
// append-only history and upload checks.
//
// SIMULATION BOUNDARIES — by construction:
//   - No network client is imported. Nothing is sent to Supabase, a CDN or any other host.
//   - "Publishing" writes .local-state/objects/<target>/catalog-v1.json on this machine only.
//   - Users are fictional. Identity comes from X-Prototype-User / X-Prototype-AAL headers that
//     stand in for verified JWT claims (sub, aal). A real deployment never trusts such headers.
//   - No keys or credentials exist anywhere in this prototype.

import { createServer } from 'node:http';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { readFile, writeFile, appendFile, mkdir, rm, stat, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectIssues, parseBytes, checkSuccessor, encodeCatalog, CatalogRejected } from './lib/validator.mjs';
import { diffCatalogs, summarize } from './lib/diff.mjs';
import { appBehaviourNotes } from './lib/capabilities.mjs';
import { imageReferences, STORAGE_IMAGE_PREFIX, storageImageKey } from './lib/images.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const VALIDATOR_VERSION = 'js-port-of-validate_catalog.py@e6c42ed';
export const TARGETS = ['staging', 'production'];
export const PRODUCTION_CONFIRMATION = 'PUBLISH PRODUCTION';

// Simulated `gear_admins` table. Not a credential store: fictional identities only.
export const ADMINS = {
// Initial operating model: Julian is the only publisher. The editor account models an optional
// future role (draft editing and image uploads only; no publishing, not even to Staging).
  'publisher@example.test': { id: '00000000-0000-4000-8000-000000000002', role: 'publisher', name: 'Julian (simulated)' },
  'editor@example.test': { id: '00000000-0000-4000-8000-000000000001', role: 'editor', name: 'Example editor (simulated, optional)' },
};
export const NON_ADMIN = 'viewer@example.test';

const MAX_JSON_BODY = 2_000_000;
const MAX_IMAGE_BYTES = 5_000_000;
const MAX_IMAGE_SIDE = 8192;
const MAX_IMAGE_PIXELS = 40_000_000;
const UPLOAD_TOKEN_TTL_MS = 5 * 60 * 1000;
const MAX_FUTURE_SKEW_SECONDS = 300;
// HEIF/HEIC is deliberately disabled: neither the browser nor this server can decode it to check
// pixel dimensions. Re-enable only with server-side decoding and dimension validation.
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg' };

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// backend: null (simulated, the default) or { mode: 'local-supabase', supabaseUrl, publishableKey }.
// In local-supabase mode this server only serves static files and public config: the page talks to the
// LOCAL Supabase stack directly with the signed-in user's session, and every /api route is disabled.
export function createAdminServer({ stateDir = join(ROOT, '.local-state'), clock = () => Date.now(), backend = null } = {}) {
  const csp = cspFor(backend);
  const paths = {
    draft: join(stateDir, 'draft.json'),
    heads: join(stateDir, 'heads.json'),
    history: join(stateDir, 'history.jsonl'),
    audit: join(stateDir, 'audit.jsonl'),
    status: join(stateDir, 'publication-status.jsonl'),
    driftAcks: join(stateDir, 'drift-acknowledgements.jsonl'),
    uploads: join(stateDir, 'uploads'),
    object: (target) => join(stateDir, 'objects', target, 'catalog-v1.json'),
  };
  const uploadTokens = new Map();

  // ---- persistence -------------------------------------------------------------------------
  async function writeAtomic(file, data) {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file);
  }
  const readJSON = async (file, fallback) => (existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : fallback);

  async function initialize({ force = false } = {}) {
    if (force) await rm(stateDir, { recursive: true, force: true });
    if (existsSync(paths.draft)) return;
    await mkdir(paths.uploads, { recursive: true });
    const seedDraft = JSON.parse(await readFile(join(ROOT, 'data', 'fictional-draft.json'), 'utf8'));
    const liveBytes = await readFile(join(ROOT, 'data', 'fictional-live-production.json'));
    const live = JSON.parse(liveBytes);
    const encoded = encodeCatalog(live);
    await writeAtomic(paths.object('production'), encoded);
    await appendFile(paths.history, JSON.stringify({
      id: randomUUID(), target: 'production', revision: live.revision, publishedAt: live.publishedAt,
      publishedBy: 'seed (fictional)', digest: sha256(encoded), document: new TextDecoder().decode(encoded),
      summary: 'Fictional seed publication', rollbackOf: null, draftVersion: null,
      validatorVersion: VALIDATOR_VERSION, createdAt: new Date(live.publishedAt * 1000).toISOString(),
    }) + '\n');
    await writeAtomic(paths.heads, JSON.stringify({
      production: { revision: live.revision, publishedAt: live.publishedAt, digest: sha256(encoded) },
      staging: null,
    }, null, 2));
    await writeAtomic(paths.draft, JSON.stringify({
      ...seedDraft, version: 1, updatedBy: 'seed (fictional)', updatedAt: new Date(clock()).toISOString(),
    }, null, 2));
  }

  async function history(target) {
    if (!existsSync(paths.history)) return [];
    const lines = (await readFile(paths.history, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return target ? lines.filter((h) => h.target === target) : lines;
  }

  // "Live" = the latest RECORDED publication (database view). Storage may lag or drift from it;
  // inspectStorage() reports that separately.
  async function live(target) {
    const heads = await readJSON(paths.heads, {});
    const head = heads[target] ?? null;
    const latest = (await history(target)).at(-1);
    if (!head || !latest) return { head: null, document: null, bytes: null };
    return { head, document: JSON.parse(latest.document), bytes: new TextEncoder().encode(latest.document) };
  }

  const audit = (event) => appendFile(paths.audit, JSON.stringify({ at: new Date(clock()).toISOString(), ...event }) + '\n');

  // ---- the publish lock (stands in for SELECT … FOR UPDATE on gear_publication_head) -----------
  let lockChain = Promise.resolve();
  function withPublishLock(fn) {
    const run = lockChain.then(fn, fn);
    lockChain = run.catch(() => {});
    return run;
  }
  let draftChain = Promise.resolve();
  function withDraftLock(fn) {
    const run = draftChain.then(fn, fn);
    draftChain = run.catch(() => {});
    return run;
  }

  // ---- auth (stands in for verifying the Supabase JWT and reading gear_admins) -----------------
  function authenticate(req) {
    const email = String(req.headers['x-prototype-user'] ?? '');
    if (!email) throw new HttpError(401, 'unauthenticated', 'Simulated sign-in required');
    const admin = ADMINS[email];
    if (!admin) throw new HttpError(403, 'not_admin', 'Simulated account is not in the simulated gear_admins table');
    const aal = req.headers['x-prototype-aal'] === 'aal2' ? 'aal2' : 'aal1';
    return { email, ...admin, aal };
  }
  function requireWrite(user, { role } = {}) {
    if (user.aal !== 'aal2') throw new HttpError(403, 'mfa_required', 'Simulated MFA: tick "Simulated MFA (aal2)" before making changes');
    if (role === 'publisher' && user.role !== 'publisher') throw new HttpError(403, 'publisher_required', 'Simulated role check: only the publisher can publish (Staging or Production) or roll back');
  }
  function requireSameOrigin(req) {
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!origin || !host || new URL(origin).host !== host) throw new HttpError(403, 'bad_origin', 'Cross-origin request refused');
  }

  // ---- checks shared by validate and publish --------------------------------------------------
  async function imageFindings(catalog, target) {
    const findings = [];
    for (const ref of imageReferences(catalog)) {
      const key = storageImageKey(ref.url);
      if (key) {
        if (!(await imageExists(key.file))) findings.push({ level: 'error', path: ref.path, message: `${ref.label}: image not found in gear storage (${key.file})` });
      } else {
        findings.push({ level: target === 'production' ? 'error' : 'warning', path: ref.path,
          message: `${ref.label}: image is not on the gear storage host; upload it so it is immutable and checked (${ref.url})` });
      }
    }
    return findings;
  }
  async function imageExists(file) {
    return existsSync(join(paths.uploads, file)) || existsSync(join(ROOT, 'data', 'images', file));
  }

  function approvalFindings(brands, meta) {
    const approvals = meta?.approvals ?? {};
    return brands.filter((b) => b.hidden !== true).flatMap((b) => {
      const state = approvals[b.id];
      return state === 'approved' ? [] : [{ level: 'error', path: `approval.${b.id}`,
        message: `${b.name || b.id}: partner approval is ${state ?? 'not recorded'}; Production is blocked while a visible brand is not approved` }];
    });
  }

  // What the next publication is compared with. Normally the latest recorded publication; after
  // acknowledged drift with a foreign document that PASSES catalog validation, that document.
  // Passing validation means a conforming client could have accepted it; whether any device or
  // cache actually holds it is unknown (device and CDN state are not observable from here).
  async function reviewBaseline(target) {
    const storage = await inspectStorage(target);
    if (storage.state === 'drift' && storage.acknowledged && storage.passesValidation) {
      const origin = await readOrigin(target);
      return { source: 'acknowledged_storage', document: JSON.parse(new TextDecoder().decode(origin)), bytes: origin };
    }
    const recorded = await live(target);
    return { source: 'recorded', document: recorded.document, bytes: recorded.bytes };
  }

  async function review(target, catalog, meta, { applyApprovalGate }) {
    const { head } = await live(target);
    const { document: liveDoc, source: baselineSource } = await reviewBaseline(target);
    const candidate = { schemaVersion: 1, revision: 'pending-stamp', publishedAt: Math.max(Math.floor(clock() / 1000), (head?.publishedAt ?? 0) + 1), brands: catalog.brands };
    const { errors, warnings } = collectIssues(candidate);
    const images = await imageFindings(catalog, target);
    const approvals = applyApprovalGate ? approvalFindings(catalog.brands ?? [], meta) : [];
    const diff = diffCatalogs(liveDoc, candidate);
    return {
      target, live: head, errors: [...errors, ...images.filter((f) => f.level === 'error'), ...approvals],
      warnings: [...warnings, ...images.filter((f) => f.level === 'warning')],
      appNotes: appBehaviourNotes(candidate), diff, summary: summarize(diff), bytes: encodeCatalog(candidate).length,
      baseline: baselineSource,
    };
  }

  // ---- simulated Storage (no compare-and-swap, like Supabase Storage) ---------------------------
  // The object is written separately from the "database" (history/heads/status files). Faults can
  // be injected to exercise crashes, uncertain uploads and writers that bypass the lock.
  const faults = { staging: null, production: null };
  class UploadUncertain extends Error {}
  async function readOrigin(target) {
    return existsSync(paths.object(target)) ? new Uint8Array(await readFile(paths.object(target))) : null;
  }
  async function storageWrite(target, bytes, fault) {
    if (fault === 'upload_timeout') throw new UploadUncertain('the upload timed out before Storage answered (simulated: it was NOT stored)');
    await writeAtomic(paths.object(target), bytes);
    if (fault === 'response_lost') throw new UploadUncertain('the connection dropped after the body was sent (simulated: it WAS stored)');
  }
  // Publication status is a separate append-only log, so history rows are never rewritten.
  async function statuses() {
    if (!existsSync(paths.status)) return new Map();
    const map = new Map();
    for (const line of (await readFile(paths.status, 'utf8')).split('\n').filter(Boolean)) {
      const s = JSON.parse(line);
      map.set(s.id, s);
    }
    return map;
  }
  const recordStatus = (id, status, note) => appendFile(paths.status, JSON.stringify({ id, status, note, at: new Date(clock()).toISOString() }) + '\n');
  async function driftAcks(target) {
    if (!existsSync(paths.driftAcks)) return [];
    return (await readFile(paths.driftAcks, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a.target === target);
  }

  /**
   * Compares the Storage origin with the latest RECORDED publication. Never trusts the CDN.
   * repair=true (only under the publish lock) re-sends the recorded bytes of a publication whose
   * upload never landed. Anything else that does not match is drift and blocks publishing until a
   * publisher acknowledges it.
   */
  async function inspectStorage(target, { repair = false } = {}) {
    const rows = await history(target);
    const latest = rows.at(-1) ?? null;
    const origin = await readOrigin(target);
    const originDigest = origin ? sha256(origin) : null;
    const status = latest ? (await statuses()).get(latest.id)?.status ?? 'verified' : null;
    const base = { latestRevision: latest?.revision ?? null, latestStatus: status, originDigest };
    if (!latest) return origin ? { ...base, state: 'drift', reason: 'Storage holds a catalog but no publication is recorded' } : { ...base, state: 'empty' };
    if (originDigest === latest.digest) {
      if (status !== 'verified' && repair) await recordStatus(latest.id, 'verified', 'reconciled: origin holds the recorded bytes');
      return { ...base, state: status === 'verified' ? 'in_sync' : repair ? 'repaired' : 'pending', latestStatus: repair ? 'verified' : status };
    }
    const previous = rows.at(-2) ?? null;
    // The latest publication's upload never landed if Storage still holds what was there before it:
    // nothing, the previous recorded publication, or a foreign document that was acknowledged
    // before the latest publication was committed.
    const acknowledgedDigests = new Set((await driftAcks(target)).map((a) => a.digest));
    const neverLanded = ['recorded', 'uncertain'].includes(status)
      && (originDigest === null || originDigest === previous?.digest || acknowledgedDigests.has(originDigest));
    if (neverLanded) {
      if (!repair) return { ...base, state: 'pending', reason: 'the latest recorded publication has not reached Storage yet' };
      await storageWrite(target, new TextEncoder().encode(latest.document), null); // identical recorded bytes
      const readBack = await readOrigin(target);
      const ok = readBack && sha256(readBack) === latest.digest;
      await recordStatus(latest.id, ok ? 'verified' : 'uncertain', 're-sent identical recorded bytes during reconcile');
      return { ...base, state: ok ? 'repaired' : 'pending', latestStatus: ok ? 'verified' : 'uncertain' };
    }
    const known = rows.find((r) => r.digest === originDigest);
    let foreign = null;
    try { foreign = JSON.parse(new TextDecoder().decode(origin)); } catch { /* not JSON */ }
    const ack = (await driftAcks(target)).find((a) => a.digest === originDigest) ?? null;
    let validationError = null;
    try { parseBytes(origin); } catch (error) { validationError = error.message; }
    const passesValidation = validationError === null;
    const foreignPublishedAt = typeof foreign?.publishedAt === 'number' ? foreign.publishedAt : null;
    // A valid catalog stamped far in the future is an incident: conforming clients that accepted it
    // would reject every normally stamped publication until then. Default: block and report.
    const futureIncident = passesValidation && foreignPublishedAt !== null && foreignPublishedAt > Math.floor(clock() / 1000) + MAX_FUTURE_SKEW_SECONDS;
    return {
      ...base, state: 'drift', acknowledged: !!ack, passesValidation, validationError, futureIncident,
      reason: known ? `Storage holds an OLDER recorded publication (${known.revision}): a late upload or a manual re-upload overwrote the latest`
        : 'Storage holds bytes no publication recorded: a writer bypassed the publish lock (CLI, dashboard upload or another tool)',
      originRevision: foreign?.revision ?? null, originPublishedAt: typeof foreign?.publishedAt === 'number' ? foreign.publishedAt : null,
    };
  }

  async function publish({ user, target, brands, meta, expectedLiveRevision, confirmation, draftVersion = null, rollbackOf = null }) {
    if (!TARGETS.includes(target)) throw new HttpError(400, 'bad_target', 'target must be staging or production');
    // Initial operating model: publishers only, for Staging AND Production.
    requireWrite(user, { role: 'publisher' });
    if (target === 'production' && confirmation !== PRODUCTION_CONFIRMATION) {
      throw new HttpError(400, 'confirmation_required', `Type ${PRODUCTION_CONFIRMATION} to publish to Production`);
    }
    return withPublishLock(async () => {
      // 1. Reconcile Storage with the database BEFORE anything else (repairs a crashed or uncertain upload).
      const storage = await inspectStorage(target, { repair: true });
      // Far-future incident: block and report. No automatic overwrite, no timestamp leap.
      if (storage.state === 'drift' && storage.futureIncident) {
        await audit({ event: 'incident_future_timestamp_blocked_publish', target, user: user.email, digest: storage.originDigest, publishedAt: storage.originPublishedAt });
        throw new HttpError(409, 'incident_future_timestamp', `${target}: Storage holds a valid catalog stamped ${storage.originPublishedAt} (more than ${MAX_FUTURE_SKEW_SECONDS} s ahead). Publishing is blocked and the incident is reported; it is not resolved automatically.`, { storage });
      }
      if (storage.state === 'drift' && !storage.acknowledged) {
        throw new HttpError(409, 'storage_drift', `${target}: ${storage.reason}. A publisher must review and acknowledge it before publishing.`, { storage });
      }
      if (storage.state === 'pending') throw new HttpError(409, 'storage_uncertain', `${target}: the previous upload is still unconfirmed; reconcile again`, { storage });
      const heads = await readJSON(paths.heads, {});
      const head = heads[target] ?? null;
      if ((expectedLiveRevision ?? null) !== (head?.revision ?? null)) {
        throw new HttpError(409, 'live_changed', `${target} changed since you reviewed it (now ${head?.revision ?? 'nothing published'}). Review the new changes, then publish again.`, { live: head });
      }
      const now = Math.floor(clock() / 1000);
      // An acknowledged foreign document that passes validation could have been accepted by a
      // conforming client (device/cache state unknown): everything after it must be newer.
      const foreignMayBeAccepted = storage.state === 'drift' && storage.acknowledged && storage.passesValidation;
      const foreignFloor = foreignMayBeAccepted ? storage.originPublishedAt ?? 0 : 0;
      const highest = Math.max(head?.publishedAt ?? 0, foreignFloor);
      if (highest > now + MAX_FUTURE_SKEW_SECONDS) {
        throw new HttpError(409, 'live_in_future', `The ${target} publishedAt (${highest}) is more than ${MAX_FUTURE_SKEW_SECONDS} s in the future; resolve the clock problem first`);
      }
      const reviewResult = await review(target, { brands }, meta, { applyApprovalGate: target === 'production' });
      if (reviewResult.errors.length) throw new HttpError(422, 'invalid', 'The catalog cannot be published', { errors: reviewResult.errors });

      const publishedAt = Math.max(now, highest + 1);
      const document = { schemaVersion: 1, revision: randomUUID(), publishedAt, brands };
      const bytes = encodeCatalog(document);
      const rows = await history(target);
      const used = [...rows.map((h) => h.revision), ...(foreignMayBeAccepted && storage.originRevision ? [storage.originRevision] : [])];
      try {
        parseBytes(bytes);
        const live = foreignMayBeAccepted ? await readOrigin(target) : head ? new TextEncoder().encode(rows.at(-1).document) : null;
        if (live) {
          const liveDoc = JSON.parse(new TextDecoder().decode(live));
          if (checkSuccessor(liveDoc, live, document, bytes, used) !== 'newer') throw new CatalogRejected('identical to the live publication');
        }
      } catch (error) {
        if (error instanceof CatalogRejected) throw new HttpError(422, 'invalid', error.message, { errors: [{ path: '', message: error.message }] });
        throw error;
      }
      const digest = sha256(bytes);
      // Summarize against the same baseline the publisher reviewed (the acknowledged Storage
      // document after drift, otherwise the latest recorded publication).
      const baselineDoc = foreignMayBeAccepted ? JSON.parse(new TextDecoder().decode(await readOrigin(target)))
        : rows.at(-1) ? JSON.parse(rows.at(-1).document) : null;
      const diff = diffCatalogs(baselineDoc, document);
      const entry = {
        id: randomUUID(), target, revision: document.revision, publishedAt, publishedBy: user.email,
        digest, document: new TextDecoder().decode(bytes), summary: summarize(diff), rollbackOf, draftVersion,
        validatorVersion: VALIDATOR_VERSION, createdAt: new Date(clock()).toISOString(),
      };
      // 2. "Commit": history row (append-only), status 'recorded', head. The head is the monotonic
      //    stamping floor; it may run ahead of Storage until the upload is verified.
      await appendFile(paths.history, JSON.stringify(entry) + '\n');
      await recordStatus(entry.id, 'recorded', 'committed; upload not yet attempted');
      heads[target] = { revision: document.revision, publishedAt, digest };
      await writeAtomic(paths.heads, JSON.stringify(heads, null, 2));
      await audit({ event: rollbackOf ? 'rollback' : 'publish', target, user: user.email, revision: document.revision, publishedAt, summary: entry.summary });
      const fault = faults[target];
      faults[target] = null;
      if (fault === 'crash_after_commit') {
        throw new HttpError(500, 'simulated_crash', 'Simulated crash after the database commit and before the Storage upload. The next publish or Reconcile re-sends the recorded bytes.', { revision: document.revision });
      }
      // 3. Upload while still holding the lock, then read the ORIGIN back (never the CDN).
      const result = {
        simulated: true, target, publicationId: entry.id, revision: document.revision, publishedAt, digest,
        bytes: bytes.length, summary: entry.summary, warnings: reviewResult.warnings,
        objectPath: `recommended-gear/${target === 'staging' ? 'staging/' : ''}catalog-v1.json (simulated, local file only)`,
      };
      try {
        await storageWrite(target, bytes, fault);
      } catch (error) {
        if (!(error instanceof UploadUncertain)) throw error;
        await recordStatus(entry.id, 'uncertain', error.message);
        return { ...result, storage: 'uncertain', readBack: `UNCERTAIN: ${error.message}. Recorded; Reconcile will check the origin and re-send the identical bytes if needed.` };
      }
      const readBack = await readOrigin(target);
      const verified = readBack && sha256(readBack) === digest;
      await recordStatus(entry.id, verified ? 'verified' : 'conflict', verified ? 'origin read-back matches' : 'origin holds different bytes after upload');
      return { ...result, storage: verified ? 'verified' : 'conflict', readBack: verified ? 'verified: origin holds exactly the recorded bytes (simulated)' : 'CONFLICT: origin holds different bytes' };
    });
  }

  // ---- HTTP routing ---------------------------------------------------------------------------
  async function api(req, res, url) {
    const method = req.method;
    const route = url.pathname;
    if (method !== 'GET' && method !== 'HEAD') requireSameOrigin(req);

    if (method === 'GET' && route === '/api/session') {
      const email = String(req.headers['x-prototype-user'] ?? '');
      return send(res, 200, {
        simulated: true, user: ADMINS[email] ? { email, ...ADMINS[email], aal: req.headers['x-prototype-aal'] === 'aal2' ? 'aal2' : 'aal1' } : null,
        accounts: [...Object.entries(ADMINS).map(([e, a]) => ({ email: e, role: a.role, name: a.name })), { email: NON_ADMIN, role: 'none', name: 'Not an admin' }],
        productionConfirmation: PRODUCTION_CONFIRMATION,
      });
    }
    const user = authenticate(req);

    if (method === 'GET' && route === '/api/state') {
      const draft = await readJSON(paths.draft, null);
      const [staging, production] = await Promise.all(TARGETS.map(live));
      const all = await history();
      return send(res, 200, {
        draft, live: { staging: { head: staging.head, document: staging.document }, production: { head: production.head, document: production.document } },
        publishedDraftVersions: Object.fromEntries(TARGETS.map((t) => [t, all.filter((h) => h.target === t).at(-1)?.draftVersion ?? null])),
        storage: Object.fromEntries(await Promise.all(TARGETS.map(async (t) => [t, await inspectStorage(t)]))),
        baselines: Object.fromEntries(await Promise.all(TARGETS.map(async (t) => { const b = await reviewBaseline(t); return [t, { source: b.source, document: b.document }]; }))),
        faults: { ...faults },
      });
    }

    if (method === 'PUT' && route === '/api/draft') {
      requireWrite(user);
      const ifMatch = req.headers['if-match'];
      if (!ifMatch) throw new HttpError(428, 'precondition_required', 'If-Match with the draft version is required');
      const body = await readJSONBody(req);
      if (!body || typeof body.catalog !== 'object' || !Array.isArray(body.catalog?.brands)) throw new HttpError(400, 'bad_draft', 'catalog.brands must be an array');
      return withDraftLock(async () => {
        const current = await readJSON(paths.draft, null);
        if (ifMatch !== `"v${current.version}"`) {
          throw new HttpError(409, 'draft_conflict', `${current.updatedBy} saved version ${current.version} while you were editing`, { current });
        }
        // Server-stamped fields are never accepted from the browser.
        const catalog = { schemaVersion: 1, brands: body.catalog.brands };
        const meta = sanitizeMeta(body.meta);
        const next = { catalog, meta, version: current.version + 1, updatedBy: user.email, updatedAt: new Date(clock()).toISOString() };
        await writeAtomic(paths.draft, JSON.stringify(next, null, 2));
        await audit({ event: 'draft_save', user: user.email, version: next.version, summary: summarize(diffCatalogs(current.catalog, catalog)) });
        res.setHeader('ETag', `"v${next.version}"`);
        return send(res, 200, { draft: next });
      });
    }

    if (method === 'POST' && route === '/api/review') {
      const { target } = await readJSONBody(req);
      if (!TARGETS.includes(target)) throw new HttpError(400, 'bad_target', 'target must be staging or production');
      const draft = await readJSON(paths.draft, null);
      return send(res, 200, { draftVersion: draft.version, ...(await review(target, draft.catalog, draft.meta, { applyApprovalGate: target === 'production' })) });
    }

    if (method === 'POST' && route === '/api/publish') {
      const body = await readJSONBody(req);
      const draft = await readJSON(paths.draft, null);
      if (body.draftVersion !== draft.version) {
        throw new HttpError(409, 'draft_changed', `The draft is now version ${draft.version} (saved by ${draft.updatedBy}); you reviewed version ${body.draftVersion}. Review again.`);
      }
      return send(res, 200, await publish({ user, target: body.target, brands: draft.catalog.brands, meta: draft.meta,
        expectedLiveRevision: body.expectedLiveRevision, confirmation: body.confirmation, draftVersion: draft.version }));
    }

    if (method === 'POST' && route === '/api/rollback') {
      const body = await readJSONBody(req);
      requireWrite(user, { role: 'publisher' });
      const entry = (await history(body.target)).find((h) => h.id === body.publicationId);
      if (!entry) throw new HttpError(404, 'not_found', 'No such publication for this target');
      const source = JSON.parse(entry.document);
      const draft = await readJSON(paths.draft, null);
      return send(res, 200, await publish({ user, target: body.target, brands: source.brands, meta: draft.meta,
        expectedLiveRevision: body.expectedLiveRevision, confirmation: body.confirmation, rollbackOf: entry.id }));
    }

    if (method === 'POST' && route === '/api/reconcile') {
      const { target } = await readJSONBody(req);
      if (!TARGETS.includes(target)) throw new HttpError(400, 'bad_target', 'target must be staging or production');
      requireWrite(user, { role: 'publisher' });
      return send(res, 200, await withPublishLock(() => inspectStorage(target, { repair: true })));
    }

    if (method === 'POST' && route === '/api/drift/acknowledge') {
      const body = await readJSONBody(req);
      if (!TARGETS.includes(body.target)) throw new HttpError(400, 'bad_target', 'target must be staging or production');
      requireWrite(user, { role: 'publisher' });
      return send(res, 200, await withPublishLock(async () => {
        const storage = await inspectStorage(body.target);
        if (storage.state !== 'drift' || storage.originDigest !== body.digest) throw new HttpError(409, 'drift_changed', 'Storage changed since you reviewed it; reload');
        // The foreign document goes through the same validator the apps use. A document that FAILS
        // validation is rejected by conforming clients, so its publishedAt sets no floor. One that
        // PASSES could have been accepted by a conforming client (actual device/cache state is
        // unknown), so its publishedAt becomes the floor. A far-future one is an incident.
        if (storage.futureIncident) {
          await audit({ event: 'drift_future_timestamp_refused', target: body.target, user: user.email, digest: body.digest, publishedAt: storage.originPublishedAt });
          throw new HttpError(409, 'drift_future_timestamp', `The Storage document passes catalog validation and is stamped ${storage.originPublishedAt}, more than ${MAX_FUTURE_SKEW_SECONDS} s in the future. A conforming client that accepted it would reject every normally stamped publication until then. This is an incident: publishing stays blocked, nothing is overwritten and no timestamp leap is made. See IMPLEMENTATION_PLAN.md §6.`, { storage });
        }
        await appendFile(paths.driftAcks, JSON.stringify({ target: body.target, digest: body.digest, revision: storage.originRevision,
          publishedAt: storage.originPublishedAt, passesValidation: storage.passesValidation, validationError: storage.validationError,
          by: user.email, at: new Date(clock()).toISOString() }) + '\n');
        await audit({ event: 'drift_acknowledged', target: body.target, user: user.email, digest: body.digest, revision: storage.originRevision, passesValidation: storage.passesValidation });
        return { acknowledged: true, storage: await inspectStorage(body.target) };
      }));
    }

    if (method === 'GET' && route === '/api/history') {
      const target = url.searchParams.get('target');
      const status = await statuses();
      const list = (await history(TARGETS.includes(target) ? target : null)).reverse().map((h) => ({ ...h, storageStatus: status.get(h.id)?.status ?? 'verified' }));
      return send(res, 200, { history: list });
    }

    if (method === 'POST' && route === '/api/uploads/sign') {
      requireWrite(user);
      const body = await readJSONBody(req);
      const ext = IMAGE_TYPES[body.contentType];
      if (!ext) throw new HttpError(415, 'bad_type', 'Images must be PNG or JPEG. HEIF/HEIC is disabled until server-side decoding and dimension checks exist');
      if (!Number.isInteger(body.byteLength) || body.byteLength < 1 || body.byteLength > MAX_IMAGE_BYTES) throw new HttpError(413, 'too_large', 'Images must be at most 5 MB (aim for 400 KB)');
      if (!/^[a-f0-9]{64}$/.test(String(body.sha256))) throw new HttpError(400, 'bad_digest', 'sha256 required');
      if (!/^[a-z0-9-]{1,64}$/.test(String(body.brandId))) throw new HttpError(400, 'bad_brand', 'brandId required');
      const file = `${body.sha256}.${ext}`;
      const publicURL = `${STORAGE_IMAGE_PREFIX}${body.brandId}/${file}`;
      if (await imageExists(file)) return send(res, 200, { alreadyStored: true, publicURL });
      const token = randomBytes(18).toString('base64url');
      uploadTokens.set(token, { ...body, file, expires: clock() + UPLOAD_TOKEN_TTL_MS, user: user.email });
      return send(res, 200, { uploadURL: `/api/uploads/put/${token}`, publicURL, expiresInSeconds: UPLOAD_TOKEN_TTL_MS / 1000 });
    }

    const put = /^\/api\/uploads\/put\/([A-Za-z0-9_-]+)$/.exec(route);
    if (method === 'PUT' && put) {
      const grant = uploadTokens.get(put[1]);
      uploadTokens.delete(put[1]); // single use
      if (!grant || grant.expires < clock() || grant.user !== user.email) throw new HttpError(403, 'bad_token', 'Upload URL expired or not yours; request a new one');
      const bytes = await readBody(req, MAX_IMAGE_BYTES);
      if (bytes.length !== grant.byteLength || sha256(bytes) !== grant.sha256) throw new HttpError(400, 'digest_mismatch', 'Uploaded bytes do not match the signed size and SHA-256');
      const info = inspectImage(bytes);
      if (!info || info.type !== grant.contentType) throw new HttpError(415, 'bad_type', 'File content is not the declared image type');
      if (!info.width || !info.height) throw new HttpError(422, 'unknown_dimensions', 'Could not read the image dimensions; upload refused');
      if ((info.width > MAX_IMAGE_SIDE || info.height > MAX_IMAGE_SIDE || info.width * info.height > MAX_IMAGE_PIXELS)) {
        throw new HttpError(422, 'too_many_pixels', `Image is ${info.width}×${info.height}; each side must be ≤ ${MAX_IMAGE_SIDE} px and ≤ 40 MP in total`);
      }
      const target = join(paths.uploads, grant.file);
      if (existsSync(target)) throw new HttpError(409, 'exists', 'Image already stored (content-addressed paths are never overwritten)');
      await mkdir(paths.uploads, { recursive: true });
      await writeFile(target, bytes, { flag: 'wx' });
      await audit({ event: 'image_upload', user: user.email, file: grant.file, bytes: bytes.length, width: info.width, height: info.height });
      return send(res, 201, { stored: true, width: info.width ?? null, height: info.height ?? null });
    }

    // Prototype-only helpers. Not part of the real API.
    if (method === 'POST' && route === '/api/dev/simulate-other-editor') {
      return withDraftLock(async () => {
        const current = await readJSON(paths.draft, null);
        const catalog = structuredClone(current.catalog);
        const first = catalog.brands.find((b) => b.kind === 'brand');
        if (first) first.tagline = `${first.tagline.replace(/ \(edited elsewhere\)$/, '')} (edited elsewhere)`.slice(0, 120);
        const next = { ...current, catalog, version: current.version + 1, updatedBy: 'publisher@example.test (another tab or device, simulated)', updatedAt: new Date(clock()).toISOString() };
        await writeAtomic(paths.draft, JSON.stringify(next, null, 2));
        await audit({ event: 'draft_save', user: 'publisher@example.test (another session)', version: next.version, summary: 'simulated concurrent edit' });
        return send(res, 200, { draft: next });
      });
    }
    if (method === 'POST' && route === '/api/dev/fault') {
      const { target, fault } = await readJSONBody(req);
      if (!TARGETS.includes(target) || ![null, 'crash_after_commit', 'response_lost', 'upload_timeout'].includes(fault)) throw new HttpError(400, 'bad_fault', 'unknown fault');
      faults[target] = fault;
      return send(res, 200, { faults });
    }
    if (method === 'POST' && route === '/api/dev/external-write') {
      // Simulates a writer that bypasses the publish lock: the staging CLI (publish_catalog.py --upload),
      // a manual dashboard upload, or a late "zombie" upload from a timed-out publisher.
      const { target, kind } = await readJSONBody(req);
      const rows = await history(target);
      let bytes;
      if (kind === 'older' && rows.length >= 2) bytes = new TextEncoder().encode(rows.at(-2).document);
      else if (kind === 'cli') {
        const base = rows.at(-1) ? JSON.parse(rows.at(-1).document) : { schemaVersion: 1, brands: [] };
        const now = Math.floor(clock() / 1000);
        bytes = encodeCatalog({ ...base, revision: `staging-${now}-cli-${randomBytes(4).toString('hex')}`, publishedAt: Math.max(now, (base.publishedAt ?? 0) + 1),
          brands: base.brands.filter((b) => b.kind !== 'brand' || b.id !== base.brands.find((x) => x.kind === 'brand')?.id) });
      } else if (kind === 'invalid') {
        bytes = new TextEncoder().encode('{"schemaVersion": 1, "revision": "", "brands": "not-a-list"}\n');
      } else if (kind === 'future') {
        const base = rows.at(-1) ? JSON.parse(rows.at(-1).document) : { schemaVersion: 1, brands: [] };
        bytes = encodeCatalog({ ...base, revision: `manual-future-${randomBytes(4).toString('hex')}`, publishedAt: Math.floor(clock() / 1000) + 5 * 86400 });
      } else throw new HttpError(400, 'bad_kind', 'kind must be "older" (needs two publications), "cli", "invalid" or "future"');
      await writeAtomic(paths.object(target), bytes);
      await audit({ event: 'simulated_external_write', target, kind });
      return send(res, 200, { written: true, digest: sha256(bytes) });
    }
    if (method === 'POST' && route === '/api/dev/reset') {
      requireWrite(user);
      faults.staging = null;
      faults.production = null;
      await initialize({ force: true });
      return send(res, 200, { reset: true });
    }
    throw new HttpError(404, 'not_found', 'No such endpoint');
  }

  async function serveStatic(req, res, url) {
    let pathname = decodeURIComponent(url.pathname);
    const image = /^\/images\/([a-f0-9]{64}\.(png|jpg))$/.exec(pathname);
    if (image) {
      const file = existsSync(join(paths.uploads, image[1])) ? join(paths.uploads, image[1]) : join(ROOT, 'data', 'images', image[1]);
      return sendFile(res, file, { immutable: true });
    }
    if (pathname === '/') pathname = '/index.html';
    const base = pathname.startsWith('/lib/') ? ROOT : join(ROOT, 'public');
    const file = normalize(join(base, pathname));
    const allowedRoot = pathname.startsWith('/lib/') ? join(ROOT, 'lib') + sep : join(ROOT, 'public') + sep;
    if (!file.startsWith(allowedRoot)) return send(res, 404, { error: 'not_found' });
    return sendFile(res, file);
  }

  async function handle(req, res) {
    setSecurityHeaders(res, csp);
    // The server binds to 127.0.0.1 only. A DNS-rebinding page would still reach it under its own
    // hostname, with matching Origin and Host headers, so accept loopback Host names only.
    if (!/^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(String(req.headers.host ?? ''))) {
      return send(res, 403, { error: 'bad_host', message: 'This local prototype only answers on 127.0.0.1 or localhost' });
    }
    const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
    try {
      if (url.pathname === '/config.json') {
        return send(res, 200, backend
          ? { mode: 'local-supabase', supabaseUrl: backend.supabaseUrl, publishableKey: backend.publishableKey, productionConfirmation: PRODUCTION_CONFIRMATION }
          : { mode: 'simulated', productionConfirmation: PRODUCTION_CONFIRMATION });
      }
      if (url.pathname.startsWith('/api/')) {
        if (backend) throw new HttpError(404, 'simulation_disabled', 'The simulated API is disabled in local-supabase mode');
        return await api(req, res, url);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method', 'Method not allowed');
      return await serveStatic(req, res, url);
    } catch (error) {
      if (error instanceof HttpError) return send(res, error.status, { error: error.code, message: error.message, ...error.extra });
      console.error(error);
      return send(res, 500, { error: 'internal', message: 'Internal error' });
    }
  }

  const server = createServer(handle);
  return { server, initialize, paths };
}

// ---- helpers --------------------------------------------------------------------------------
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function sanitizeMeta(meta) {
  const approvals = {};
  for (const [id, state] of Object.entries(meta?.approvals ?? {})) {
    if (/^[a-z0-9-]{1,64}$/.test(id) && ['pending', 'approved', 'not_required'].includes(state)) approvals[id] = state === 'not_required' ? 'approved' : state;
  }
  const notes = {};
  for (const [id, note] of Object.entries(meta?.notes ?? {})) {
    if (/^[a-z0-9-]{1,64}$/.test(id) && typeof note === 'string') notes[id] = note.slice(0, 1000);
  }
  return { approvals, notes };
}

/** Validates the local-supabase backend config: loopback URL and a publishable (never secret) key. */
export function localSupabaseBackend({ supabaseUrl, publishableKey }) {
  const url = new URL(String(supabaseUrl ?? ''));
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/') {
    throw new Error('local-supabase mode accepts only a loopback http://127.0.0.1:<port> Supabase URL');
  }
  const key = String(publishableKey ?? '');
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) throw new Error('GEAR_SUPABASE_PUBLISHABLE_KEY must be a publishable key (sb_publishable_…); secret keys never go to the browser');
  return { mode: 'local-supabase', supabaseUrl: url.origin, publishableKey: key };
}

function cspFor(backend) {
  const extra = backend ? ` ${backend.supabaseUrl}` : '';
  return `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:${extra}; connect-src 'self'${extra}; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

function setSecurityHeaders(res, csp = cspFor(null)) {
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};

async function sendFile(res, file, { immutable = false } = {}) {
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-store' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'not_found' });
  }
}

async function readBody(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new HttpError(413, 'too_large', 'Request body too large');
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function readJSONBody(req) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'json_required', 'Content-Type must be application/json');
  const raw = await readBody(req, MAX_JSON_BODY);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    throw new HttpError(400, 'bad_json', 'Body is not valid JSON');
  }
}

/** Sniffs PNG/JPEG and reads the pixel size from the header (no decoding). HEIF is not accepted. */
export function inspectImage(bytes) {
  const b = bytes;
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { type: 'image/png', width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i += 1; continue; }
      const marker = b[i + 1];
      const length = (b[i + 2] << 8) | b[i + 3];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { type: 'image/jpeg', height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
      }
      i += 2 + length;
    }
    return { type: 'image/jpeg' };
  }
  return null;
}

// ---- entry point ----------------------------------------------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const port = Number(process.env.PORT ?? 4174);
  const backend = process.argv.includes('--backend=local-supabase')
    ? localSupabaseBackend({ supabaseUrl: process.env.GEAR_SUPABASE_URL, publishableKey: process.env.GEAR_SUPABASE_PUBLISHABLE_KEY })
    : null;
  const { server, initialize } = createAdminServer({ backend });
  if (!backend) await initialize({ force: process.argv.includes('--reset') });
  server.listen(port, '127.0.0.1', () => {
    console.log(`85Blends Admin prototype (Recommended Gear): http://127.0.0.1:${port}`);
    console.log(backend
      ? `LOCAL SUPABASE mode: real local sign-in and TOTP against ${backend.supabaseUrl} (local stack, fictional data). Simulated API disabled.`
      : 'Local simulation only: fictional data, no network calls, publishing writes _admin-prototype/.local-state/.');
  });
}
