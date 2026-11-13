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
  'editor@example.test': { id: '00000000-0000-4000-8000-000000000001', role: 'editor', name: 'Example Editor' },
  'publisher@example.test': { id: '00000000-0000-4000-8000-000000000002', role: 'publisher', name: 'Example Publisher' },
  'publisher2@example.test': { id: '00000000-0000-4000-8000-000000000003', role: 'publisher', name: 'Second Publisher' },
};
export const NON_ADMIN = 'viewer@example.test';

const MAX_JSON_BODY = 2_000_000;
const MAX_IMAGE_BYTES = 5_000_000;
const MAX_IMAGE_SIDE = 8192;
const MAX_IMAGE_PIXELS = 40_000_000;
const UPLOAD_TOKEN_TTL_MS = 5 * 60 * 1000;
const MAX_FUTURE_SKEW_SECONDS = 300;
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/heic': 'heic', 'image/heif': 'heif' };

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function createAdminServer({ stateDir = join(ROOT, '.local-state'), clock = () => Date.now() } = {}) {
  const paths = {
    draft: join(stateDir, 'draft.json'),
    heads: join(stateDir, 'heads.json'),
    history: join(stateDir, 'history.jsonl'),
    audit: join(stateDir, 'audit.jsonl'),
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

  async function live(target) {
    const heads = await readJSON(paths.heads, {});
    const head = heads[target] ?? null;
    if (!head || !existsSync(paths.object(target))) return { head: null, document: null, bytes: null };
    const bytes = new Uint8Array(await readFile(paths.object(target)));
    return { head, document: JSON.parse(new TextDecoder().decode(bytes)), bytes };
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
    if (!email) throw new HttpError(401, 'unauthenticated', 'Sign in required');
    const admin = ADMINS[email];
    if (!admin) throw new HttpError(403, 'not_admin', 'This account is not a Recommended Gear administrator');
    const aal = req.headers['x-prototype-aal'] === 'aal2' ? 'aal2' : 'aal1';
    return { email, ...admin, aal };
  }
  function requireWrite(user, { role } = {}) {
    if (user.aal !== 'aal2') throw new HttpError(403, 'mfa_required', 'Verify with your authenticator app (MFA) before making changes');
    if (role === 'publisher' && user.role !== 'publisher') throw new HttpError(403, 'publisher_required', 'Only publishers can publish to Production or roll back');
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

  async function review(target, catalog, meta, { applyApprovalGate }) {
    const { head, document: liveDoc } = await live(target);
    const candidate = { schemaVersion: 1, revision: 'pending-stamp', publishedAt: Math.max(Math.floor(clock() / 1000), (head?.publishedAt ?? 0) + 1), brands: catalog.brands };
    const { errors, warnings } = collectIssues(candidate);
    const images = await imageFindings(catalog, target);
    const approvals = applyApprovalGate ? approvalFindings(catalog.brands ?? [], meta) : [];
    const diff = diffCatalogs(liveDoc, candidate);
    return {
      target, live: head, errors: [...errors, ...images.filter((f) => f.level === 'error'), ...approvals],
      warnings: [...warnings, ...images.filter((f) => f.level === 'warning')],
      appNotes: appBehaviourNotes(candidate), diff, summary: summarize(diff), bytes: encodeCatalog(candidate).length,
    };
  }

  async function publish({ user, target, brands, meta, expectedLiveRevision, confirmation, draftVersion = null, rollbackOf = null }) {
    if (!TARGETS.includes(target)) throw new HttpError(400, 'bad_target', 'target must be staging or production');
    requireWrite(user, { role: target === 'production' ? 'publisher' : undefined });
    if (target === 'production' && confirmation !== PRODUCTION_CONFIRMATION) {
      throw new HttpError(400, 'confirmation_required', `Type ${PRODUCTION_CONFIRMATION} to publish to Production`);
    }
    return withPublishLock(async () => {
      const { head, document: liveDoc, bytes: liveBytes } = await live(target);
      if ((expectedLiveRevision ?? null) !== (head?.revision ?? null)) {
        throw new HttpError(409, 'live_changed', `${target} changed since you reviewed it (now ${head?.revision ?? 'nothing published'}). Review the new changes, then publish again.`, { live: head });
      }
      const reviewResult = await review(target, { brands }, meta, { applyApprovalGate: target === 'production' });
      if (reviewResult.errors.length) throw new HttpError(422, 'invalid', 'The catalog cannot be published', { errors: reviewResult.errors });

      const now = Math.floor(clock() / 1000);
      if (head && head.publishedAt > now + MAX_FUTURE_SKEW_SECONDS) {
        // Same guard as publish_catalog.py: a live publishedAt far in the future means a clock was
        // wrong. Stamping head + 1 would push every later publication further into the future.
        throw new HttpError(409, 'live_in_future', `The live ${target} publishedAt (${head.publishedAt}) is more than ${MAX_FUTURE_SKEW_SECONDS} s in the future; resolve the clock problem first`);
      }
      const publishedAt = Math.max(now, (head?.publishedAt ?? 0) + 1);
      const document = { schemaVersion: 1, revision: randomUUID(), publishedAt, brands };
      const bytes = encodeCatalog(document);
      try {
        parseBytes(bytes);
        if (liveDoc) {
          const used = (await history(target)).map((h) => h.revision);
          if (checkSuccessor(liveDoc, liveBytes, document, bytes, used) !== 'newer') throw new CatalogRejected('identical to the live publication');
        }
      } catch (error) {
        if (error instanceof CatalogRejected) throw new HttpError(422, 'invalid', error.message, { errors: [{ path: '', message: error.message }] });
        throw error;
      }
      const digest = sha256(bytes);
      const diff = diffCatalogs(liveDoc, document);
      const entry = {
        id: randomUUID(), target, revision: document.revision, publishedAt, publishedBy: user.email,
        digest, document: new TextDecoder().decode(bytes), summary: summarize(diff), rollbackOf, draftVersion,
        validatorVersion: VALIDATOR_VERSION, createdAt: new Date(clock()).toISOString(),
      };
      // History row and head are recorded BEFORE the object upload (see IMPLEMENTATION_PLAN.md).
      await appendFile(paths.history, JSON.stringify(entry) + '\n');
      const heads = await readJSON(paths.heads, {});
      heads[target] = { revision: document.revision, publishedAt, digest };
      await writeAtomic(paths.heads, JSON.stringify(heads, null, 2));
      // Simulated Storage upload (Content-Type application/json, Cache-Control max-age=60).
      await writeAtomic(paths.object(target), bytes);
      const readBack = new Uint8Array(await readFile(paths.object(target)));
      const verified = sha256(readBack) === digest;
      await audit({ event: rollbackOf ? 'rollback' : 'publish', target, user: user.email, revision: document.revision, publishedAt, summary: entry.summary });
      return {
        simulated: true, target, publicationId: entry.id, revision: document.revision, publishedAt, digest,
        bytes: bytes.length, summary: entry.summary, readBack: verified ? 'verified (local simulated object)' : 'MISMATCH',
        objectPath: `recommended-gear/${target === 'staging' ? 'staging/' : ''}catalog-v1.json (simulated, local file only)`,
        warnings: reviewResult.warnings,
      };
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

    if (method === 'GET' && route === '/api/history') {
      const target = url.searchParams.get('target');
      const list = (await history(TARGETS.includes(target) ? target : null)).reverse();
      return send(res, 200, { history: list });
    }

    if (method === 'POST' && route === '/api/uploads/sign') {
      requireWrite(user);
      const body = await readJSONBody(req);
      const ext = IMAGE_TYPES[body.contentType];
      if (!ext) throw new HttpError(415, 'bad_type', 'Images must be PNG, JPEG or HEIF');
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
      if (!info || info.type !== grant.contentType.replace('image/heif', 'image/heic')) throw new HttpError(415, 'bad_type', 'File content is not the declared image type');
      if (info.width && (info.width > MAX_IMAGE_SIDE || info.height > MAX_IMAGE_SIDE || info.width * info.height > MAX_IMAGE_PIXELS)) {
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
        const next = { ...current, catalog, version: current.version + 1, updatedBy: 'publisher2@example.test', updatedAt: new Date(clock()).toISOString() };
        await writeAtomic(paths.draft, JSON.stringify(next, null, 2));
        await audit({ event: 'draft_save', user: 'publisher2@example.test', version: next.version, summary: 'simulated concurrent edit' });
        return send(res, 200, { draft: next });
      });
    }
    if (method === 'POST' && route === '/api/dev/reset') {
      requireWrite(user);
      await initialize({ force: true });
      return send(res, 200, { reset: true });
    }
    throw new HttpError(404, 'not_found', 'No such endpoint');
  }

  async function serveStatic(req, res, url) {
    let pathname = decodeURIComponent(url.pathname);
    const image = /^\/images\/([a-f0-9]{64}\.(png|jpg|heic|heif))$/.exec(pathname);
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
    setSecurityHeaders(res);
    const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
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

function setSecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
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
  '.heic': 'image/heic', '.heif': 'image/heif' };

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

/** Sniffs PNG/JPEG/HEIF and reads PNG/JPEG pixel size from the header (no decoding). */
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
  if (b.length > 12 && String.fromCharCode(...b.slice(4, 8)) === 'ftyp' && ['heic', 'heix', 'mif1', 'msf1', 'heif'].includes(String.fromCharCode(...b.slice(8, 12)))) {
    return { type: 'image/heic' }; // pixel size checked server-side with a real decoder in production
  }
  return null;
}

// ---- entry point ----------------------------------------------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const port = Number(process.env.PORT ?? 4174);
  const { server, initialize } = createAdminServer();
  await initialize({ force: process.argv.includes('--reset') });
  server.listen(port, '127.0.0.1', () => {
    console.log(`85Blends Admin prototype (Recommended Gear): http://127.0.0.1:${port}`);
    console.log('Local simulation only: fictional data, no network calls, publishing writes _admin-prototype/.local-state/.');
  });
}
