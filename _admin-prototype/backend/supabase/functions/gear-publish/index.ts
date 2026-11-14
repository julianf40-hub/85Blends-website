// gear-publish: validates, reviews and commits Recommended Gear publications.
// Decision D10, option 2: the DATABASE is the publication channel. There is no Storage catalog write.
//
// Authorization is checked here and again, independently, by the database:
//   1. the gateway verifies the JWT (verify_jwt = true);
//   2. Auth confirms the session is still valid (GET /auth/v1/user: revoked or signed-out sessions fail);
//   3. aal2 is required; Production also needs a TOTP verification within the step-up window;
//   4. the caller must hold the publisher role in gear_admins AND match the pinned publisher ID;
//   5. the commit RPC runs with the CALLER's JWT and re-checks publisher, aal2 and the Production step-up
//      in the database, under a row lock on the target's pointer.
//
// Publish = review binding + exact bytes + one transaction:
//   - the client sends the reviewDigest it was shown and an operationId (a UUID it keeps for retries);
//   - this function recomputes the review; any difference is review_stale. It stamps and validates the
//     exact bytes and stores them as a private intent bound to the reviewed draft version (or rollback
//     source) and to the pointer the review saw;
//   - gear_commit_publication(operationId) inserts the publication and advances the pointer only if the
//     pointer and draft are unchanged (compare-and-swap). A stale or concurrent publisher gets
//     live_changed and changes nothing;
//   - a retry with the same operationId returns the original publication (replayed: true), never a
//     second one. Reusing an operationId for a different request is operation_conflict.
// Apps read the current publication from gear-catalog. Images stay immutable Storage objects.

import { parseBytes, checkSuccessor, encodeCatalog, collectIssues, CatalogRejected } from '../_shared/validator.mjs';
import { diffCatalogs, summarize } from '../_shared/diff.mjs';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
// The key sent as `apikey` with user-JWT requests to Auth, PostgREST and Storage. Prefer the
// project's publishable key (GEAR_PUBLIC_API_KEY, a function secret), so nothing here depends on
// the legacy JWT anon key, which credential remediation may disable.
const ANON_KEY = Deno.env.get('GEAR_PUBLIC_API_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY') ?? '';
// Production: a dedicated publisher secret key. NOTE: any secret key acts as service_role across
// the whole project (plan §5); "dedicated" means separately rotatable, not restricted.
const SERVICE_KEY = Deno.env.get('GEAR_PUBLISHER_SECRET_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const PINNED_PUBLISHER = Deno.env.get('GEAR_PUBLISHER_USER_ID') ?? '';
const UPLOAD_TIMEOUT_SECONDS = Number(Deno.env.get('GEAR_UPLOAD_TIMEOUT_SECONDS') ?? 20); // image uploads
// @test-only:start (removed by tools/build-deploy-package.mjs; never in the deployment package)
const TEST_FAULTS = Deno.env.get('GEAR_ALLOW_TEST_FAULTS') === 'local-only'
  && /^http:\/\/(kong|127\.0\.0\.1|localhost)(:\d+)?$/.test(SUPABASE_URL);
// @test-only:end
const MAX_FUTURE_SKEW = 300;
// Gear images live in their own bucket. The legacy recommended-gear bucket (old catalog objects,
// read by installed builds) is only ever READ here, by the verifier.
const IMAGE_BUCKET = Deno.env.get('GEAR_IMAGE_BUCKET') ?? 'recommended-gear-images';
const LEGACY_CATALOG_BUCKET = 'recommended-gear';
const CONFIRMATION = 'PUBLISH PRODUCTION';
const VALIDATOR_VERSION = 'js-port-of-validate_catalog.py@e6c42ed';
const TARGETS = ['staging', 'production'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Canonical https prefix that catalogs use for gear images (hosted: the project's public bucket URL).
const IMAGE_PUBLIC_BASE = Deno.env.get('GEAR_IMAGE_PUBLIC_BASE') ?? '';
const IMAGE_PATH = /^images\/[a-z0-9-]{1,64}\/[a-f0-9]{64}\.(png|jpg)$/;
// Browser origins allowed to call this function (the admin page). Others are refused.
const ALLOWED_ORIGINS = (Deno.env.get('GEAR_ALLOWED_ORIGINS') ?? '').split(',').map((o) => o.trim()).filter(Boolean);
const legacyObjectPath = (target: string) => (target === 'staging' ? 'staging/catalog-v1.json' : 'catalog-v1.json');

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}

// ---------------------------------------------------------------- service calls
const serviceHeaders = (extra: Record<string, string> = {}) => (SERVICE_KEY.startsWith('sb_secret_')
  ? { apikey: SERVICE_KEY, ...extra }
  : { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, ...extra });

function dbError(status: number, body: any, fallback: string) {
  const message = String(body?.message ?? body ?? fallback);
  const code = /^([a-z_]+):/.exec(message)?.[1] ?? 'db_error';
  return new HttpError(status, code, message);
}

async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init, headers: serviceHeaders({ 'Content-Type': 'application/json', ...(init.headers as Record<string, string> ?? {}) }),
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw dbError(res.status, body, res.statusText);
  return body;
}
const rpc = (fn: string, args: Record<string, unknown>) => rest(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

// @test-only:start
// Local test faults: a comma-separated list in x-gear-test-fault (honored only in local test mode).
const faultParts = (fault: string | null) => (fault ? fault.split(',').map((f) => f.trim()).filter(Boolean) : []);
const hasFault = (fault: string | null, name: string) => faultParts(fault).includes(name);
const pause = async (fault: string | null, point: string) => {
  const m = faultParts(fault).map((f) => new RegExp(`^pause_${point}:(\\d{1,5})$`).exec(f)).find(Boolean);
  if (m) await new Promise((r) => setTimeout(r, Number(m[1])));
};
// @test-only:end

// ---------------------------------------------------------------- authorization
type Caller = { id: string; email: string; role: string | null; aal: string; amr: { method: string; timestamp: number }[]; jwt: string };

function base64UrlDecode(part: string) {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function authenticate(req: Request): Promise<Caller> {
  const header = req.headers.get('Authorization') ?? '';
  const jwt = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!jwt || jwt.split('.').length !== 3) throw new HttpError(401, 'unauthenticated', 'Sign-in required');
  // Auth is the authority: an expired, revoked or signed-out session fails here.
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}` } });
  if (res.status !== 200) throw new HttpError(401, 'unauthenticated', 'The session is not valid (expired, revoked or signed out)');
  const user = await res.json();
  const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(jwt.split('.')[1])));
  if (claims.sub !== user.id) throw new HttpError(401, 'unauthenticated', 'Session subject mismatch');
  const rows = await rest(`gear_admins?select=role&user_id=eq.${encodeURIComponent(user.id)}`);
  return { id: user.id, email: user.email, role: rows[0]?.role ?? null, aal: claims.aal, amr: Array.isArray(claims.amr) ? claims.amr : [], jwt };
}

function requireAdmin(caller: Caller) {
  if (!caller.role) throw new HttpError(403, 'not_admin', 'Not a Recommended Gear administrator');
  if (caller.aal !== 'aal2') throw new HttpError(403, 'mfa_required', 'Verify with your authenticator app (aal2) first');
}

/** Publisher identity: role, aal2 and the pinned ID. The Production step-up is checked separately. */
function requirePublisher(caller: Caller) {
  requireAdmin(caller);
  if (caller.role !== 'publisher') throw new HttpError(403, 'publisher_required', 'Only the publisher can publish or roll back');
  if (!PINNED_PUBLISHER || caller.id !== PINNED_PUBLISHER) throw new HttpError(403, 'publisher_not_pinned', 'This account is not the configured publisher');
}

/** Production needs a TOTP verification within the window stored in gear_settings (one source of truth
 *  for this function and the commit RPC, which checks it again in the database). */
async function requireStepUp(caller: Caller, target: string) {
  if (target !== 'production') return;
  const [settings] = await rest('gear_settings?select=production_step_up_seconds');
  const window = Number(settings?.production_step_up_seconds ?? 900);
  const totp = caller.amr.filter((m) => m.method === 'totp').map((m) => m.timestamp).sort().at(-1);
  if (!totp || Math.floor(Date.now() / 1000) - totp > window) {
    throw new HttpError(403, 'mfa_step_up_required', `Production needs a TOTP verification within the last ${window} s`);
  }
}

// ---------------------------------------------------------------- state
async function loadTarget(target: string) {
  const [head] = await rest(`gear_publication_head?target=eq.${target}&select=revision,published_at,digest,current_publication_id`);
  let current: any = null;
  if (head?.current_publication_id) {
    [current] = await rest(`gear_catalog_publications?id=eq.${head.current_publication_id}&select=id,revision,published_at,digest,document`);
  }
  return { head, current };
}

function approvalErrors(brands: any[], meta: any) {
  const approvals = meta?.approvals ?? {};
  return brands.filter((b) => b.hidden !== true && approvals[b.id] !== 'approved')
    .map((b) => ({ path: `approval.${b.id}`, message: `${b.name || b.id}: partner approval is ${approvals[b.id] ?? 'not recorded'}` }));
}

function imageReferences(brands: any[]) {
  const refs: { path: string; label: string; url: string }[] = [];
  brands.forEach((brand, i) => {
    const name = brand.name || brand.id;
    if (brand.logo?.url) refs.push({ path: `brands[${i}].logo.url`, label: `${name} logo`, url: brand.logo.url });
    if (brand.logo?.darkURL) refs.push({ path: `brands[${i}].logo.darkURL`, label: `${name} dark logo`, url: brand.logo.darkURL });
    if (brand.heroImageURL) refs.push({ path: `brands[${i}].heroImageURL`, label: `${name} product image`, url: brand.heroImageURL });
    (brand.wheels ?? []).forEach((w: any, k: number) => { if (w.imageURL) refs.push({ path: `brands[${i}].wheels[${k}].imageURL`, label: `${w.displayName || w.id} image`, url: w.imageURL }); });
  });
  return refs;
}

async function imageFindings(brands: any[], target: string) {
  const refs = imageReferences(brands);
  const gear = refs.filter((r) => IMAGE_PUBLIC_BASE && r.url.startsWith(IMAGE_PUBLIC_BASE)).map((r) => ({ ...r, object: `images/${r.url.slice(IMAGE_PUBLIC_BASE.length)}` }));
  const stored: any[] = gear.length ? await rpc('gear_image_objects', { p_names: gear.map((g) => g.object) }) : [];
  const byName = new Map(stored.map((o: any) => [o.name, o]));
  const errors: any[] = [];
  const warnings: any[] = [];
  for (const ref of refs) {
    const g = gear.find((x) => x.url === ref.url);
    if (!g) {
      (target === 'production' ? errors : warnings).push({ path: ref.path, message: `${ref.label}: not on gear image storage; upload it so it is immutable and checked (${ref.url})` });
    } else if (!IMAGE_PATH.test(g.object)) {
      errors.push({ path: ref.path, message: `${ref.label}: not a content-addressed gear image path` });
    } else if (!byName.has(g.object)) {
      errors.push({ path: ref.path, message: `${ref.label}: image not found in gear storage` });
    }
  }
  return { errors, warnings };
}

// One computation for review and publish. The digest binds a publish to exactly what was reviewed:
// target, draft version or rollback source, baseline bytes, candidate brands and (Production) approvals.
// One computation for review and publish. The digest binds a publish to exactly what was reviewed:
// target, draft version or rollback source, the CURRENT publication (baseline) bytes, the candidate
// brands and (Production) approvals.
async function computeReview(target: string, opts: { rollbackOf?: string | null }) {
  const { head, current } = await loadTarget(target);
  const [draft] = await rest('gear_catalog_drafts?id=eq.main&select=catalog,meta,version');
  let brands: any[];
  let draftVersion: number | null = null;
  let rollbackOf: string | null = null;
  if (opts.rollbackOf) {
    if (!UUID.test(String(opts.rollbackOf))) throw new HttpError(400, 'bad_rollback', 'rollbackOf must be a publication id');
    const [source] = await rest(`gear_catalog_publications?id=eq.${opts.rollbackOf}&target=eq.${target}&select=id,document`);
    if (!source) throw new HttpError(404, 'not_found', 'No such publication for this target');
    brands = JSON.parse(source.document).brands;
    rollbackOf = source.id;
  } else {
    brands = draft.catalog.brands;
    draftVersion = draft.version;
  }
  const baselineBytes = current ? new TextEncoder().encode(current.document) : null;
  const baselineDoc = current ? JSON.parse(current.document) : null;
  const now = Math.floor(Date.now() / 1000);
  const candidate = { schemaVersion: 1, revision: 'pending-stamp', publishedAt: Math.max(now, (head?.published_at ?? 0) + 1), brands };
  const issues = collectIssues(candidate);
  const images = await imageFindings(brands, target);
  const approvals = target === 'production' ? approvalErrors(brands, draft.meta) : [];
  const diff = diffCatalogs(baselineDoc, candidate);
  const visibleApprovals = target === 'production'
    ? Object.fromEntries(brands.filter((b) => b.hidden !== true).map((b) => [b.id, draft.meta?.approvals?.[b.id] ?? null])) : null;
  const reviewDigest = await sha256(new TextEncoder().encode(JSON.stringify({
    target, draftVersion, rollbackOf,
    baseline: current ? { id: current.id, digest: current.digest } : null,
    brands: await sha256(new TextEncoder().encode(JSON.stringify(brands))),
    approvals: visibleApprovals,
  })));
  return {
    target, draftVersion, rollbackOf, brands, meta: draft.meta, head, current, baselineBytes, baselineDoc,
    live: head?.revision ? { revision: head.revision, publishedAt: head.published_at } : null,
    errors: [...issues.errors, ...images.errors, ...approvals], warnings: [...issues.warnings, ...images.warnings],
    diff, summary: summarize(diff), bytes: encodeCatalog(candidate).length, baseline: 'current_publication', reviewDigest,
  };
}

async function review(caller: Caller, body: any) {
  requireAdmin(caller);
  const r = await computeReview(body.target, { rollbackOf: body.rollbackOf ?? null });
  return { target: r.target, draftVersion: r.draftVersion, rollbackOf: r.rollbackOf, live: r.live, errors: r.errors, warnings: r.warnings,
    diff: r.diff, summary: r.summary, bytes: r.bytes, baseline: r.baseline, baselineDocument: r.baselineDoc, reviewDigest: r.reviewDigest, appNotes: [] };
}

// ---------------------------------------------------------------- images
const MAX_IMAGE_BYTES = 5_000_000;
const MAX_IMAGE_SIDE = 8192;
const MAX_IMAGE_PIXELS = 40_000_000;

/** Sniffs the real type from the bytes and reads pixel dimensions from the header (no decoding). */
function inspectImage(b: Uint8Array): { type: string; width?: number; height?: number } | null {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[12] === 0x49 && b[13] === 0x48 && b[14] === 0x44 && b[15] === 0x52) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { type: 'image/png', width: v.getUint32(16), height: v.getUint32(20) };
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
      if (length < 2) break;
      i += 2 + length;
    }
    return { type: 'image/jpeg' };
  }
  if (b.length > 12 && String.fromCharCode(...b.slice(4, 8)) === 'ftyp') return { type: 'image/heif' };
  return null;
}

async function uploadImage(caller: Caller, req: Request, url: URL) {
  requireAdmin(caller); // editor or publisher, aal2
  const brandId = url.searchParams.get('brand') ?? '';
  if (!/^[a-z0-9-]{1,64}$/.test(brandId)) throw new HttpError(400, 'bad_brand', 'brand must be a catalog brand id');
  const declared = (req.headers.get('Content-Type') ?? '').split(';')[0].trim();
  if (['image/heic', 'image/heif'].includes(declared)) throw new HttpError(415, 'heif_disabled', 'HEIF/HEIC uploads are disabled until server-side decoding and dimension checks exist');
  if (!['image/png', 'image/jpeg'].includes(declared)) throw new HttpError(415, 'bad_type', 'Images must be PNG or JPEG');
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length < 1 || bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'too_large', 'Images must be at most 5 MB (aim for 400 KB)');
  const info = inspectImage(bytes);
  if (info?.type === 'image/heif') throw new HttpError(415, 'heif_disabled', 'HEIF/HEIC uploads are disabled until server-side decoding and dimension checks exist');
  if (!info || info.type !== declared) throw new HttpError(415, 'type_mismatch', 'The file content is not the declared image type');
  if (!info.width || !info.height) throw new HttpError(422, 'unknown_dimensions', 'Could not read the image dimensions');
  if (info.width > MAX_IMAGE_SIDE || info.height > MAX_IMAGE_SIDE || info.width * info.height > MAX_IMAGE_PIXELS) {
    throw new HttpError(422, 'too_many_pixels', `Image is ${info.width}×${info.height}; each side must be ≤ ${MAX_IMAGE_SIDE} px and ≤ 40 MP`);
  }
  const digest = await sha256(bytes);
  const name = `images/${brandId}/${digest}.${declared === 'image/png' ? 'png' : 'jpg'}`;
  const publicURL = `${IMAGE_PUBLIC_BASE}${name.slice('images/'.length)}`;
  const existing = await rpc('gear_image_objects', { p_names: [name] });
  if (existing.length) return { publicURL, alreadyStored: true, width: info.width, height: info.height };
  const nonce = await rpc('gear_authorize_image', { p_name: name, p_user_id: caller.id, p_size: bytes.length, p_content_type: declared });
  try {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${IMAGE_BUCKET}/${name}`, {
      method: 'POST', body: bytes,
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${caller.jwt}`, 'Content-Type': declared, 'Cache-Control': 'public, max-age=31536000, immutable',
        'x-upsert': 'false', 'x-metadata': b64(JSON.stringify({ gear_image: nonce })) },
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_SECONDS * 1000),
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      if (/Duplicate|already exists/i.test(text)) return { publicURL, alreadyStored: true, width: info.width, height: info.height };
      throw new HttpError(res.status === 400 || res.status === 403 ? 403 : 502, 'upload_refused', `Storage refused the image: ${text}`);
    }
  } finally {
    await rpc('gear_consume_image', { p_name: name }).catch(() => {});
  }
  // read back: the stored bytes must hash to the name
  const back = await fetch(`${SUPABASE_URL}/storage/v1/object/authenticated/${IMAGE_BUCKET}/${name}`, { headers: serviceHeaders() });
  const ok = back.status === 200 && (await sha256(new Uint8Array(await back.arrayBuffer()))) === digest;
  await rpc('gear_audit', { p_actor: caller.id, p_event: 'image_upload', p_detail: { name, bytes: bytes.length, width: info.width, height: info.height, readBack: ok } });
  if (!ok) throw new HttpError(502, 'image_readback_mismatch', 'Stored image does not match the uploaded bytes; it is reported, not deleted');
  return { publicURL, alreadyStored: false, width: info.width, height: info.height };
}

// ---------------------------------------------------------------- verifier (read-only, on demand)
async function verify(caller: Caller) {
  requireAdmin(caller);
  const alerts: any[] = [];
  const info: any[] = [];
  const nowMs = Date.now();
  const targets: Record<string, unknown> = {};
  for (const target of TARGETS) {
    const { head, current } = await loadTarget(target);
    const [newest] = await rest(`gear_catalog_publications?target=eq.${target}&select=id,revision,published_at&order=published_at.desc&limit=1`);
    const t: any = { pointer: head?.current_publication_id ?? null, revision: head?.revision ?? null, publishedAt: head?.published_at ?? null };
    if (current) {
      const actual = await sha256(new TextEncoder().encode(current.document));
      if (actual !== current.digest) alerts.push({ target, kind: 'integrity', message: 'current publication bytes do not match their digest' });
      if (head.revision !== current.revision || head.digest !== current.digest || Number(head.published_at) !== Number(current.published_at)) {
        alerts.push({ target, kind: 'pointer_mismatch', message: 'head fields do not match the publication the pointer names' });
      }
      if (newest && newest.id !== current.id) alerts.push({ target, kind: 'pointer_not_newest', message: `a newer publication (${newest.revision}) exists than the current pointer` });
      // What the apps actually receive from the read endpoint.
      const served = await fetch(`${SUPABASE_URL}/functions/v1/gear-catalog/${target}`, { headers: { 'Cache-Control': 'no-cache' } });
      t.endpoint = { status: served.status, etag: served.headers.get('ETag') };
      await served.body?.cancel();
      // Gateways may weaken the ETag (W/"…"); the value is still the digest of the bytes.
      if (served.status !== 200 || (served.headers.get('ETag') ?? '').replace(/^W\//, '') !== `"${current.digest}"`) {
        alerts.push({ target, kind: 'endpoint_mismatch', message: `gear-catalog served HTTP ${served.status} ${served.headers.get('ETag') ?? ''}, not the current publication` });
      }
    } else if (newest) {
      alerts.push({ target, kind: 'pointer_missing', message: 'publications exist but no current pointer is set' });
    }
    // The old mutable Storage objects are not authoritative and are never served by gear-catalog.
    const legacy = await fetch(`${SUPABASE_URL}/storage/v1/object/info/authenticated/${LEGACY_CATALOG_BUCKET}/${legacyObjectPath(target)}`, { headers: serviceHeaders() });
    if (legacy.status === 200) info.push({ target, kind: 'legacy_storage_object', message: `recommended-gear/${legacyObjectPath(target)} exists but is NOT the publication channel; only old app builds read it` });
    await legacy.body?.cancel();
    targets[target] = t;
  }
  const intents = await rpc('gear_intent_overview', {});
  if (intents.expired_uncommitted > 0) info.push({ target: 'all', kind: 'expired_intents', message: `${intents.expired_uncommitted} prepared publication(s) expired without being committed (stale or abandoned reviews; harmless)` });
  // images referenced by the current publication of each target and by the current draft
  const [draft] = await rest('gear_catalog_drafts?id=eq.main&select=catalog');
  const pubs = await rest('gear_catalog_publications?select=target,document,published_at&order=published_at.desc');
  const latestByTarget = new Map<string, any>();
  for (const p of pubs) if (!latestByTarget.has(p.target)) latestByTarget.set(p.target, p);
  const checkSets: [string, any[]][] = [['draft', draft.catalog.brands], ...[...latestByTarget].map(([t, p]) => [`live ${t}`, JSON.parse(p.document).brands] as [string, any[]])];
  for (const [where, brands] of checkSets) {
    const found = await imageFindings(brands, where.endsWith('production') ? 'production' : 'staging');
    for (const e of found.errors) alerts.push({ target: where, kind: 'image', message: e.message });
    for (const w of found.warnings) info.push({ target: where, kind: 'image', message: w.message });
  }
  // unreferenced gear images: reported with age, NEVER deleted automatically
  const referenced = new Set<string>();
  const collect = (brands: any[]) => imageReferences(brands).forEach((r) => { if (IMAGE_PUBLIC_BASE && r.url.startsWith(IMAGE_PUBLIC_BASE)) referenced.add(`images/${r.url.slice(IMAGE_PUBLIC_BASE.length)}`); });
  collect(draft.catalog.brands);
  for (const p of pubs) collect(JSON.parse(p.document).brands);
  const images = await rpc('gear_list_images', {});
  const unreferenced = images.filter((o: any) => !referenced.has(o.name))
    .map((o: any) => ({ name: o.name, bytes: o.size, ageDays: Math.floor((nowMs - Date.parse(o.created_at)) / 86_400_000), deleted: false }));
  const report = {
    ranAt: new Date(nowMs).toISOString(), targets, alerts, info, images: { stored: images.length, referenced: referenced.size, unreferenced },
    alertDelivery: { configured: false, note: 'Alert delivery is an open decision (D1); this report and the audit log are the only outputs.' },
  };
  await rpc('gear_audit', { p_actor: caller.id, p_event: 'verify_run', p_detail: { alerts: alerts.length, unreferencedImages: unreferenced.length } });
  return report;
}

// ---------------------------------------------------------------- actions
const COMMIT_ERRORS: Record<string, [number, string]> = {
  head_changed: [409, 'live_changed'], draft_changed: [409, 'draft_changed'], not_newer: [409, 'live_changed'],
  mfa_step_up_required: [403, 'mfa_step_up_required'], publisher_required: [403, 'publisher_required'],
  not_your_operation: [409, 'operation_conflict'], operation_expired: [409, 'operation_expired'], unknown_operation: [404, 'unknown_operation'],
};

/** Commits a prepared operation WITH THE CALLER'S JWT: the database re-checks who and when. */
async function commit(caller: Caller, operationId: string, fault: string | null) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/gear_commit_publication`, {
    method: 'POST', body: JSON.stringify({ p_operation_id: operationId }),
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${caller.jwt}`, 'Content-Type': 'application/json' },
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const error = dbError(res.status, body, res.statusText);
    const mapped = COMMIT_ERRORS[error.code];
    if (mapped) throw new HttpError(mapped[0], mapped[1], error.message.replace(/^[a-z_]+: /, ''));
    throw error;
  }
  // @test-only:start
  if (hasFault(fault, 'response_lost')) {
    throw new HttpError(502, 'test_response_lost', 'Test fault: the commit succeeded, but this response is reported as lost');
  }
  // @test-only:end
  return { ...body, storage: 'committed' };
}

/** What the request asked for, independent of the operation ID. Stored with the intent and the publication. */
async function requestFingerprint(target: string, body: any) {
  return sha256(new TextEncoder().encode(JSON.stringify({
    target, action: body.rollbackOf ? 'rollback' : 'publish', reviewDigest: body.reviewDigest ?? null,
    draftVersion: body.rollbackOf ? null : body.draftVersion ?? null, expectedLiveRevision: body.expectedLiveRevision ?? null,
    rollbackOf: body.rollbackOf ?? null,
  })));
}

async function publish(caller: Caller, body: any, fault: string | null) {
  const target = body.target;
  requirePublisher(caller);
  if (target === 'production' && body.confirmation !== CONFIRMATION) throw new HttpError(400, 'confirmation_required', `Type ${CONFIRMATION} to publish to Production`);
  const operationId = String(body.operationId ?? '');
  if (!UUID.test(operationId)) throw new HttpError(400, 'operation_id_required', 'operationId (a UUID the client keeps for retries) is required');
  // The operation is bound to this publisher, this environment and this exact request.
  const fingerprint = await requestFingerprint(target, body);
  const sameRequest = (i: any) => i.user_id === caller.id && i.target === target && i.request_digest === fingerprint;

  // A retry of a known operation never prepares another publication. Pending: commit that same
  // intent. Committed (still an intent, or recognized from the append-only publication after
  // cleanup): return the original. Any mismatch is a conflict, and nothing is revealed about it.
  const known = await rpc('gear_find_operation', { p_operation_id: operationId });
  if (known) {
    if (!sameRequest(known)) throw new HttpError(409, 'operation_conflict', 'This operation ID belongs to a different request');
    // Already committed: return the original, even if the step-up window has passed since (nothing new is published).
    if (known.state === 'committed') return { ...(await rpc('gear_operation_result', { p_operation_id: operationId })), storage: 'committed' };
    // Retired by cleanup without having committed: the same answer it got before cleanup.
    if (known.state === 'retired') throw new HttpError(409, 'operation_expired', 'This operation expired without being published; review again (a new operation ID)');
    await requireStepUp(caller, target);
    return commit(caller, operationId, fault);
  }
  await requireStepUp(caller, target);

  const { head } = await loadTarget(target);
  if ((body.expectedLiveRevision ?? null) !== (head?.revision ?? null)) {
    throw new HttpError(409, 'live_changed', `${target} changed since you reviewed it (now ${head?.revision ?? 'nothing published'})`);
  }
  const r = await computeReview(target, { rollbackOf: body.rollbackOf ?? null });
  if (!body.rollbackOf && body.draftVersion !== r.draftVersion) {
    throw new HttpError(409, 'draft_changed', `The draft is now version ${r.draftVersion}; you reviewed version ${body.draftVersion}`);
  }
  if (body.reviewDigest !== r.reviewDigest) {
    throw new HttpError(409, 'review_stale', 'What would be published differs from what you reviewed (draft, baseline, approvals or rollback source changed). Run the checks again.');
  }
  if (r.errors.length) throw new HttpError(422, 'invalid', 'The catalog cannot be published', { errors: r.errors });

  const now = Math.floor(Date.now() / 1000);
  const current = r.head?.published_at ?? 0;
  if (current > now + MAX_FUTURE_SKEW) throw new HttpError(409, 'live_in_future', `${target} publishedAt ${current} is more than ${MAX_FUTURE_SKEW} s ahead; resolve the clock problem first`);
  const document = { schemaVersion: 1, revision: crypto.randomUUID(), publishedAt: Math.max(now, current + 1), brands: r.brands };
  const errors = collectIssues(document).errors;
  if (errors.length) throw new HttpError(422, 'invalid', 'The catalog cannot be published', { errors });
  const bytes = encodeCatalog(document);
  try {
    parseBytes(bytes);
    if (r.baselineBytes) {
      const used = (await rest(`gear_catalog_publications?target=eq.${target}&select=revision`)).map((x: any) => x.revision);
      if (checkSuccessor(r.baselineDoc, r.baselineBytes, document, bytes, used) !== 'newer') throw new CatalogRejected('identical to the live publication');
    }
  } catch (error) {
    if (error instanceof CatalogRejected) throw new HttpError(422, 'invalid', error.message);
    throw error;
  }

  // @test-only:start
  await pause(fault, 'after_lookup'); // local tests: a duplicate delayed between its lookup and its prepare
  // @test-only:end
  let intent: any;
  try {
    intent = await rpc('gear_prepare_intent', { p: {
    operation_id: operationId, target, user_id: caller.id, request_digest: fingerprint, revision: document.revision,
    published_at: document.publishedAt, document: new TextDecoder().decode(bytes), digest: await sha256(bytes),
    summary: summarize(diffCatalogs(r.baselineDoc, document)), expected_publication_id: r.current?.id ?? null,
    draft_version: r.draftVersion, rollback_of: r.rollbackOf, validator_version: VALIDATOR_VERSION,
    } });
  } catch (error) {
    // The operation was committed (or retired) after this request's lookup: answer as a retry would.
    if (!(error instanceof HttpError) || error.code !== 'operation_conflict') throw error;
    const now = await rpc('gear_find_operation', { p_operation_id: operationId });
    if (!now || !sameRequest(now)) throw new HttpError(409, 'operation_conflict', 'This operation ID belongs to a different request');
    if (now.state === 'committed') return { ...(await rpc('gear_operation_result', { p_operation_id: operationId })), storage: 'committed' };
    throw new HttpError(409, 'operation_expired', 'This operation expired without being published; review again (a new operation ID)');
  }
  // A concurrent duplicate may have prepared this operation first: use its intent, if it is the same request.
  if (!intent.created && !sameRequest(intent)) throw new HttpError(409, 'operation_conflict', 'This operation ID belongs to a different request');
  // @test-only:start
  await pause(fault, 'before_commit'); // local tests: a publisher delayed between validation and commit
  // @test-only:end
  return commit(caller, operationId, fault);
}

async function inspect(caller: Caller, body: any) {
  requireAdmin(caller);
  const { head, current } = await loadTarget(body.target);
  return {
    target: body.target, state: current ? 'in_sync' : 'empty', channel: 'database',
    endpoint: `/functions/v1/gear-catalog/${body.target}`,
    current: current ? { id: current.id, revision: current.revision, publishedAt: current.published_at, digest: current.digest } : null,
    latestRevision: head?.revision ?? null, latestStatus: current ? 'committed' : null,
    baseline: { source: 'current_publication', document: current ? JSON.parse(current.document) : null },
  };
}

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin');
  const cors: Record<string, string> = origin && ALLOWED_ORIGINS.includes(origin)
    ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Max-Age': '600' }
    : {};
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });
  if (req.method === 'OPTIONS') return new Response(null, { status: origin && cors['Access-Control-Allow-Origin'] ? 204 : 403, headers: cors });
  try {
    // A browser request from any origin other than the admin page is refused (server-side, not only by CORS).
    if (origin && !ALLOWED_ORIGINS.includes(origin)) throw new HttpError(403, 'bad_origin', 'Origin not allowed');
    if (req.method !== 'POST') throw new HttpError(405, 'method', 'POST only');
    const caller = await authenticate(req);
    const url = new URL(req.url);
    if (url.searchParams.get('action') === 'upload_image') return json(200, await uploadImage(caller, req, url));
    const body = await req.json().catch(() => { throw new HttpError(400, 'bad_json', 'Body must be JSON'); });
    if (body.action === 'verify') return json(200, await verify(caller));
    if (!TARGETS.includes(body.target)) throw new HttpError(400, 'bad_target', 'target must be staging or production');
    // @test-only:start
    const fault = TEST_FAULTS ? req.headers.get('x-gear-test-fault') : null;
    // @test-only:end
    // @deploy: const fault: string | null = null;
    switch (body.action) {
      case 'publish': return json(200, await publish(caller, body, fault));
      case 'rollback': return json(200, await publish(caller, { ...body, rollbackOf: body.publicationId }, fault));
      case 'inspect': return json(200, await inspect(caller, body));
      case 'review': return json(200, await review(caller, body));
      default: throw new HttpError(400, 'bad_action', 'Unknown action');
    }
  } catch (error) {
    if (error instanceof HttpError) return json(error.status, { error: error.code, message: error.message, ...error.extra });
    console.error(error);
    return json(500, { error: 'internal', message: 'Internal error' });
  }
});
