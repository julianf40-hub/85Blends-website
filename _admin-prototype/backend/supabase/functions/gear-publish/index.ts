// gear-publish: the only routine writer of the Recommended Gear catalog (LOCAL implementation).
//
// No external dependencies: it talks to Auth, PostgREST and Storage over HTTP, so it runs in the
// local Edge Runtime without network access and ports to a hosted project unchanged.
//
// Authorization is checked here independently of the UI and again by the database:
//   1. the gateway verifies the JWT (verify_jwt = true);
//   2. Auth confirms the session is still valid (GET /auth/v1/user: revoked or signed-out sessions fail);
//   3. aal2 is required; Production also needs a TOTP verification within the step-up window;
//   4. the caller must hold the publisher role in gear_admins AND match the pinned publisher ID;
//   5. the database trigger re-checks publisher identity, aal2, digest and publishedAt ordering.
//
// Publishing runs under a lease with a fencing token (gear_acquire_lease): reconcile Storage with
// the database, validate, record, upload, read back. A crash leaves the lease to expire; the next
// run re-sends recorded bytes that never landed. Anything else in Storage is drift.
//
// Storage writes use the CALLER's verified JWT, not a service key, and carry the lease token in the
// object's user metadata. Storage RLS (migration 20261113190000) then enforces, when the object row
// is committed: publisher + aal2 from that JWT, the live lease token, a compare-and-swap on the object
// version captured before it was read, and (Production) a recent TOTP. A stale writer whose lease
// expired, or a reconcile racing another writer, is rejected by Storage itself.

import { parseBytes, checkSuccessor, encodeCatalog, collectIssues, CatalogRejected } from '../_shared/validator.mjs';
import { diffCatalogs, summarize } from '../_shared/diff.mjs';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
// Production: a dedicated publisher secret key. NOTE: any secret key acts as service_role across
// the whole project (plan §5); "dedicated" means separately rotatable, not restricted.
const SERVICE_KEY = Deno.env.get('GEAR_PUBLISHER_SECRET_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const PINNED_PUBLISHER = Deno.env.get('GEAR_PUBLISHER_USER_ID') ?? '';
const STEP_UP_SECONDS = Number(Deno.env.get('GEAR_PRODUCTION_STEP_UP_SECONDS') ?? 900);
const LEASE_SECONDS = Number(Deno.env.get('GEAR_LEASE_SECONDS') ?? 60);
// An upload must be able to finish inside the lease: Storage checks RLS when an upload STARTS and
// completes it as superuser, so the function itself refuses to start one it cannot finish in time.
const UPLOAD_TIMEOUT_SECONDS = Number(Deno.env.get('GEAR_UPLOAD_TIMEOUT_SECONDS') ?? 20);
const TEST_FAULTS = Deno.env.get('GEAR_ALLOW_TEST_FAULTS') === 'local-only'
  && /^http:\/\/(kong|127\.0\.0\.1|localhost)(:\d+)?$/.test(SUPABASE_URL);
const MAX_FUTURE_SKEW = 300;
const BUCKET = 'recommended-gear';
const CONFIRMATION = 'PUBLISH PRODUCTION';
const VALIDATOR_VERSION = 'js-port-of-validate_catalog.py@e6c42ed';
const TARGETS = ['staging', 'production'];
// Canonical https prefix that catalogs use for gear images (hosted: the project's public bucket URL).
const IMAGE_PUBLIC_BASE = Deno.env.get('GEAR_IMAGE_PUBLIC_BASE') ?? '';
const IMAGE_PATH = /^images\/[a-z0-9-]{1,64}\/[a-f0-9]{64}\.(png|jpg)$/;
// Browser origins allowed to call this function (the admin page). Others are refused.
const ALLOWED_ORIGINS = (Deno.env.get('GEAR_ALLOWED_ORIGINS') ?? '').split(',').map((o) => o.trim()).filter(Boolean);
const objectPath = (target: string) => (target === 'staging' ? 'staging/catalog-v1.json' : 'catalog-v1.json');

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}

// ---------------------------------------------------------------- service calls
const serviceHeaders = (extra: Record<string, string> = {}) => (SERVICE_KEY.startsWith('sb_secret_')
  ? { apikey: SERVICE_KEY, ...extra }
  : { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, ...extra });

async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init, headers: serviceHeaders({ 'Content-Type': 'application/json', ...(init.headers as Record<string, string> ?? {}) }),
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const message = String(body?.message ?? body ?? res.statusText);
    const code = /^([a-z_]+):/.exec(message)?.[1] ?? 'db_error';
    throw new HttpError(res.status, code, message);
  }
  return body;
}
const rpc = (fn: string, args: Record<string, unknown>) => rest(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function readOrigin(target: string): Promise<Uint8Array | null> {
  // The authenticated origin endpoint, never the public CDN URL.
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/authenticated/${BUCKET}/${objectPath(target)}`, { headers: serviceHeaders({ 'Cache-Control': 'no-cache' }) });
  if (res.status === 200) return new Uint8Array(await res.arrayBuffer());
  const text = await res.text();
  if ((res.status === 400 || res.status === 404) && /not.?found/i.test(text)) return null;
  throw new HttpError(502, 'storage_unavailable', `Storage origin read failed: HTTP ${res.status}`);
}

class UploadUncertain extends Error {}
class StorageRejected extends Error {}
type WriteContext = { jwt: string; userId: string; token: string; target: string; publicationId: string; deadline: number; fault: string | null };
const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

async function upload(target: string, bytes: Uint8Array, fault: string | null, ctx: WriteContext) {
  if (!hasFault(ctx.fault, 'skip_lease_margin_check') && Date.now() + UPLOAD_TIMEOUT_SECONDS * 1000 + 500 > ctx.deadline) {
    throw new HttpError(409, 'lease_expiring', 'Not enough lease time left to finish the upload; nothing was uploaded. Try again.');
  }
  // Single-use write grant: bound to this environment, its object path, this publication and its size.
  const nonce = await rpc('gear_authorize_write', { p_token: ctx.token, p_target: ctx.target, p_publication_id: ctx.publicationId, p_user_id: ctx.userId });
  await pause(ctx.fault, 'before_upload'); // local tests: hold an issued grant across a lease change
  try {
    return await uploadWithGrant(target, bytes, fault, ctx, nonce);
  } finally {
    await rpc('gear_consume_write', { p_token: ctx.token, p_target: ctx.target }).catch(() => {});
  }
}

/**
 * Local test fault `stall_body:N`: sends the request line, headers (which is when Storage runs its
 * permission check) and the first half of the body, waits N ms with the connection open, then sends
 * the rest. Raw HTTP/1.1 with an explicit Content-Length; no client-side timeout at any point, so
 * whatever happens next is the server's own behavior.
 */
async function stalledUpload(base: string, path: string, bytes: Uint8Array, headers: Record<string, string>, stallMs: number): Promise<Response> {
  const url = new URL(`${base}${path}`);
  const conn = await Deno.connect({ hostname: url.hostname, port: Number(url.port || 80) });
  const head = [`POST ${url.pathname} HTTP/1.1`, `Host: ${url.host}`, `Content-Length: ${bytes.length}`, 'Connection: close',
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', ''].join('\r\n');
  const half = Math.floor(bytes.length / 2);
  await conn.write(new TextEncoder().encode(head));
  await conn.write(bytes.slice(0, half));
  console.log(JSON.stringify({ gearTest: 'stall_body', phase: 'stalled', sentBytes: half, totalBytes: bytes.length, at: Date.now() }));
  await new Promise((r) => setTimeout(r, stallMs));
  await conn.write(bytes.slice(half));
  console.log(JSON.stringify({ gearTest: 'stall_body', phase: 'resumed', at: Date.now() }));
  const chunks: Uint8Array[] = [];
  const buf = new Uint8Array(65536);
  for (;;) { const n = await conn.read(buf); if (n === null) break; chunks.push(buf.slice(0, n)); }
  conn.close();
  const text = new TextDecoder().decode(new Uint8Array(chunks.flatMap((c) => [...c])));
  const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0);
  const body = text.split('\r\n\r\n').slice(1).join('\r\n\r\n');
  return new Response(body.replace(/^[0-9a-f]+\r\n|\r\n0\r\n\r\n$/g, ''), { status });
}

async function uploadWithGrant(target: string, bytes: Uint8Array, fault: string | null, ctx: WriteContext, nonce: string) {
  if (hasFault(fault, 'upload_timeout')) throw new UploadUncertain('upload timed out before Storage answered (test fault: not stored)');
  // stall_body: through the API gateway (local Kong buffers the whole body before forwarding, so
  // Storage authorizes only after the stall). stall_body_direct: straight to the local Storage
  // service, modelling a gateway that streams the body (Storage authorizes on the headers).
  const stall = faultParts(fault).map((f) => /^stall_body(_direct)?:(\d{1,6})$/.exec(f)).find(Boolean);
  let res: Response;
  if (stall) {
    const [base, prefix] = stall[1] ? ['http://storage:5000', ''] : [SUPABASE_URL, '/storage/v1'];
    res = await stalledUpload(base, `${prefix}/object/${BUCKET}/${objectPath(target)}`, bytes, {
      apikey: ANON_KEY, Authorization: `Bearer ${ctx.jwt}`, 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60',
      'x-upsert': 'true', 'x-metadata': b64(JSON.stringify({ gear_write: nonce })),
    }, Number(stall[2]));
  } else try {
    res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectPath(target)}`, {
      method: 'POST', body: bytes,
      headers: {
        apikey: ANON_KEY, Authorization: `Bearer ${ctx.jwt}`, // the caller's verified session, subject to Storage RLS
        'Content-Type': 'application/json', 'Cache-Control': 'max-age=60', 'x-upsert': 'true',
        'x-metadata': b64(JSON.stringify({ gear_write: nonce })),
      },
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_SECONDS * 1000),
    });
  } catch (error) {
    throw new UploadUncertain(`upload did not complete (${(error as Error).message}); it may or may not be stored`);
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    // RLS refusal: stale lease token, object changed since it was read (CAS), not the aal2 publisher,
    // or (Production) TOTP step-up expired. Storage kept the previous object version.
    if ((res.status === 400 || res.status === 403) && /row-level security|Unauthorized|policy/i.test(text)) throw new StorageRejected(text);
    // Candidate commit guard (migration 20261113220000): Storage reports the trigger's PT403 as a
    // 500 DatabaseError without its message. The row was not written; the served object is unchanged.
    if (res.status === 500 && /code: PT403/.test(text)) throw new StorageRejected(`refused at commit by the catalog commit guard: ${text}`);
    throw new HttpError(502, 'upload_refused', `Storage refused the upload: HTTP ${res.status} ${text}`);
  }
  if (hasFault(fault, 'response_lost')) throw new UploadUncertain('response lost after the body was sent (test fault: stored)');
}

// Local test faults: a comma-separated list in x-gear-test-fault (honored only in local test mode).
const faultParts = (fault: string | null) => (fault ? fault.split(',').map((f) => f.trim()).filter(Boolean) : []);
const hasFault = (fault: string | null, name: string) => faultParts(fault).includes(name);
const prepareWrite = (target: string, token: string) => rpc('gear_prepare_write', { p_token: token, p_target: target });
const pause = async (fault: string | null, point: string) => {
  const m = faultParts(fault).map((f) => new RegExp(`^pause_${point}:(\\d{1,5})$`).exec(f)).find(Boolean);
  if (m) await new Promise((r) => setTimeout(r, Number(m[1])));
};

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

function requirePublisher(caller: Caller, target: string) {
  requireAdmin(caller);
  if (caller.role !== 'publisher') throw new HttpError(403, 'publisher_required', 'Only the publisher can publish, roll back, reconcile or acknowledge drift');
  if (!PINNED_PUBLISHER || caller.id !== PINNED_PUBLISHER) throw new HttpError(403, 'publisher_not_pinned', 'This account is not the configured publisher');
  if (target === 'production') {
    const totp = caller.amr.filter((m) => m.method === 'totp').map((m) => m.timestamp).sort().at(-1);
    if (!totp || Math.floor(Date.now() / 1000) - totp > STEP_UP_SECONDS) {
      throw new HttpError(403, 'mfa_step_up_required', `Production needs a TOTP verification within the last ${STEP_UP_SECONDS} s`);
    }
  }
}

// ---------------------------------------------------------------- state
async function loadTarget(target: string) {
  const [head] = await rest(`gear_publication_head?target=eq.${target}&select=revision,published_at,digest`);
  const pubs = await rest(`gear_catalog_publications?target=eq.${target}&select=id,revision,published_at,digest,document&order=published_at.desc&limit=2`);
  const latest = pubs[0] ?? null;
  let status: string | null = null;
  if (latest) {
    const s = await rest(`gear_publication_status?publication_id=eq.${latest.id}&select=status&order=id.desc&limit=1`);
    status = s[0]?.status ?? null;
  }
  const acks = await rest(`gear_storage_drift_acks?target=eq.${target}&select=digest,passes_validation,foreign_published_at,foreign_revision`);
  return { head, latest, previous: pubs[1] ?? null, status, acks };
}

async function inspectStorage(target: string, opts: { repair?: boolean; token?: string; jwt?: string; userId?: string; fault?: string | null; deadline?: number } = {}) {
  // Repair mode captures the stored object version FIRST, under the lease. Every write below must
  // replace exactly that version (Storage RLS), so content that changes after this read is never
  // overwritten automatically.
  if (opts.repair) await prepareWrite(target, opts.token!);
  const { latest, previous, status, acks } = await loadTarget(target);
  const origin = await readOrigin(target);
  const originDigest = origin ? await sha256(origin) : null;
  const base = { latestRevision: latest?.revision ?? null, latestStatus: status, originDigest };
  if (!latest) return origin ? { ...base, state: 'drift', reason: 'Storage holds a catalog but no publication is recorded', ...(await describeForeign(origin, acks, originDigest)) } : { ...base, state: 'empty' };
  if (originDigest === latest.digest) {
    if (status !== 'verified' && opts.repair) await rpc('gear_record_status', { p_token: opts.token, p_publication_id: latest.id, p_status: 'verified', p_note: 'reconciled: origin holds the recorded bytes' });
    return { ...base, state: status === 'verified' ? 'in_sync' : opts.repair ? 'repaired' : 'pending' };
  }
  const acknowledged = new Set(acks.map((a: any) => a.digest));
  const neverLanded = ['recorded', 'uncertain', 'refused'].includes(status ?? '')
    && (originDigest === null || originDigest === previous?.digest || acknowledged.has(originDigest));
  if (neverLanded) {
    if (!opts.repair) return { ...base, state: 'pending', reason: 'the latest recorded publication has not reached Storage yet' };
    await pause(opts.fault ?? null, 'before_resend');
    const bytes = new TextEncoder().encode(latest.document); // identical recorded bytes; one attempt, no retry loop
    try {
      await upload(target, bytes, null, { jwt: opts.jwt!, userId: opts.userId!, token: opts.token!, target, publicationId: latest.id, deadline: opts.deadline!, fault: opts.fault ?? null });
    } catch (error) {
      if (error instanceof UploadUncertain) return { ...base, state: 'pending', reason: error.message };
      if (error instanceof StorageRejected) {
        return { ...base, state: 'pending', reason: 'Storage changed after it was read (or the lease expired); nothing was overwritten. Inspect again.' };
      }
      throw error;
    }
    await prepareWrite(target, opts.token!); // our own write is now the expected version
    const readBack = await readOrigin(target);
    const ok = !!readBack && (await sha256(readBack)) === latest.digest;
    await rpc('gear_record_status', { p_token: opts.token, p_publication_id: latest.id, p_status: ok ? 'verified' : 'uncertain', p_note: 're-sent identical recorded bytes during reconcile' });
    return { ...base, state: ok ? 'repaired' : 'pending' };
  }
  return { ...base, state: 'drift', ...(await describeForeign(origin!, acks, originDigest)),
    reason: 'Storage holds bytes that do not match the latest recorded publication (a writer bypassed gear-publish, or an older upload landed late)' };
}

async function describeForeign(origin: Uint8Array, acks: any[], digest: string | null) {
  let validationError: string | null = null;
  try { parseBytes(origin); } catch (error) { validationError = (error as Error).message; }
  let foreign: any = null;
  try { foreign = JSON.parse(new TextDecoder().decode(origin)); } catch { /* not JSON */ }
  const passesValidation = validationError === null;
  const originPublishedAt = typeof foreign?.publishedAt === 'number' ? foreign.publishedAt : null;
  return {
    acknowledged: acks.some((a) => a.digest === digest), passesValidation, validationError,
    originRevision: typeof foreign?.revision === 'string' ? foreign.revision : null, originPublishedAt,
    // A catalog that passes validation and is stamped far ahead: conforming clients that accepted it
    // reject every normally stamped publication until then. Default: block and report.
    futureIncident: passesValidation && originPublishedAt !== null && originPublishedAt > Math.floor(Date.now() / 1000) + MAX_FUTURE_SKEW,
  };
}

function approvalErrors(brands: any[], meta: any) {
  const approvals = meta?.approvals ?? {};
  return brands.filter((b) => b.hidden !== true && approvals[b.id] !== 'approved')
    .map((b) => ({ path: `approval.${b.id}`, message: `${b.name || b.id}: partner approval is ${approvals[b.id] ?? 'not recorded'}` }));
}

async function withLease<T>(target: string, fn: (token: string, keep: () => void, deadline: number) => Promise<T>): Promise<T> {
  const acquiredAt = Date.now();
  const token = await rpc('gear_acquire_lease', { p_target: target, p_ttl_seconds: LEASE_SECONDS });
  const deadline = acquiredAt + LEASE_SECONDS * 1000; // conservative: measured from before the request
  let release = true;
  try {
    return await fn(token, () => { release = false; }, deadline);
  } finally {
    if (release) await rpc('gear_release_lease', { p_target: target, p_token: token }).catch(() => {});
  }
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
async function computeReview(target: string, opts: { rollbackOf?: string | null }) {
  const { head, latest } = await loadTarget(target);
  const storage: any = await inspectStorage(target);
  const [draft] = await rest('gear_catalog_drafts?id=eq.main&select=catalog,meta,version');
  let brands: any[];
  let draftVersion: number | null = null;
  let rollbackOf: string | null = null;
  if (opts.rollbackOf) {
    const [source] = await rest(`gear_catalog_publications?id=eq.${encodeURIComponent(opts.rollbackOf)}&target=eq.${target}&select=id,document`);
    if (!source) throw new HttpError(404, 'not_found', 'No such publication for this target');
    brands = JSON.parse(source.document).brands;
    rollbackOf = source.id;
  } else {
    brands = draft.catalog.brands;
    draftVersion = draft.version;
  }
  const foreignMayBeAccepted = storage.state === 'drift' && storage.acknowledged && storage.passesValidation;
  const baselineBytes = foreignMayBeAccepted ? await readOrigin(target) : latest ? new TextEncoder().encode(latest.document) : null;
  const baselineDoc = baselineBytes ? JSON.parse(new TextDecoder().decode(baselineBytes)) : null;
  const now = Math.floor(Date.now() / 1000);
  const highest = Math.max(head?.published_at ?? 0, foreignMayBeAccepted ? storage.originPublishedAt ?? 0 : 0);
  const candidate = { schemaVersion: 1, revision: 'pending-stamp', publishedAt: Math.max(now, highest + 1), brands };
  const issues = collectIssues(candidate);
  const images = await imageFindings(brands, target);
  const approvals = target === 'production' ? approvalErrors(brands, draft.meta) : [];
  const diff = diffCatalogs(baselineDoc, candidate);
  const visibleApprovals = target === 'production'
    ? Object.fromEntries(brands.filter((b) => b.hidden !== true).map((b) => [b.id, draft.meta?.approvals?.[b.id] ?? null])) : null;
  const reviewDigest = await sha256(new TextEncoder().encode(JSON.stringify({
    target, draftVersion, rollbackOf,
    baseline: baselineBytes ? await sha256(baselineBytes) : null,
    brands: await sha256(new TextEncoder().encode(JSON.stringify(brands))),
    approvals: visibleApprovals,
  })));
  return {
    target, draftVersion, rollbackOf, brands, meta: draft.meta, head, latest, storage, foreignMayBeAccepted, baselineBytes, baselineDoc,
    live: head?.revision ? { revision: head.revision, publishedAt: head.published_at } : null,
    errors: [...issues.errors, ...images.errors, ...approvals], warnings: [...issues.warnings, ...images.warnings],
    diff, summary: summarize(diff), bytes: encodeCatalog(candidate).length,
    baseline: foreignMayBeAccepted ? 'acknowledged_storage' : 'recorded', reviewDigest,
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
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${name}`, {
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
  const back = await fetch(`${SUPABASE_URL}/storage/v1/object/authenticated/${BUCKET}/${name}`, { headers: serviceHeaders() });
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
    const st: any = await inspectStorage(target); // read-only: never repairs
    targets[target] = st;
    if (st.state === 'drift') alerts.push({ target, kind: st.futureIncident ? 'incident_future_timestamp' : 'storage_drift', message: st.reason, acknowledged: !!st.acknowledged });
    if (st.state === 'pending') alerts.push({ target, kind: 'storage_pending', message: st.reason ?? 'latest publication not confirmed in Storage' });
    if (['conflict', 'refused', 'uncertain'].includes(st.latestStatus) && st.state !== 'in_sync') alerts.push({ target, kind: `status_${st.latestStatus}`, message: `latest publication status is ${st.latestStatus}` });
  }
  const leases = await rpc('gear_lease_overview', {});
  for (const l of leases) if (l.lease_expired) info.push({ target: l.target, kind: 'expired_lease', message: 'a lease expired without release (crash or timeout); the next publish or reconcile replaces it' });
  // images referenced by the latest publication of each target and by the current draft
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
async function publish(caller: Caller, body: any, fault: string | null) {
  const target = body.target;
  requirePublisher(caller, target);
  if (target === 'production' && body.confirmation !== CONFIRMATION) throw new HttpError(400, 'confirmation_required', `Type ${CONFIRMATION} to publish to Production`);
  return withLease(target, async (token, keepLease, deadline) => {
    const storage: any = await inspectStorage(target, { repair: true, token, jwt: caller.jwt, userId: caller.id, fault, deadline });
    if (storage.state === 'drift' && storage.futureIncident) {
      await rpc('gear_audit', { p_actor: caller.id, p_event: 'incident_future_timestamp_blocked_publish', p_detail: { target, digest: storage.originDigest, publishedAt: storage.originPublishedAt } });
      throw new HttpError(409, 'incident_future_timestamp', `Storage holds a catalog that passes validation stamped ${storage.originPublishedAt}, more than ${MAX_FUTURE_SKEW} s ahead. Publishing is blocked and reported; nothing is overwritten.`, { storage });
    }
    if (storage.state === 'drift' && !storage.acknowledged) throw new HttpError(409, 'storage_drift', `${target}: ${storage.reason}. Acknowledge it before publishing.`, { storage });
    if (storage.state === 'pending') throw new HttpError(409, 'storage_uncertain', `${target}: the previous upload is still unconfirmed; reconcile again`, { storage });

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
    const { brands, draftVersion, rollbackOf, latest, foreignMayBeAccepted } = r;

    const now = Math.floor(Date.now() / 1000);
    const highest = Math.max(head?.published_at ?? 0, foreignMayBeAccepted ? storage.originPublishedAt ?? 0 : 0);
    if (highest > now + MAX_FUTURE_SKEW) throw new HttpError(409, 'live_in_future', `${target} publishedAt ${highest} is more than ${MAX_FUTURE_SKEW} s ahead; resolve the clock problem first`);

    const publishedAt = Math.max(now, highest + 1);
    const document = { schemaVersion: 1, revision: crypto.randomUUID(), publishedAt, brands };
    const errors = collectIssues(document).errors;
    if (errors.length) throw new HttpError(422, 'invalid', 'The catalog cannot be published', { errors });
    const bytes = encodeCatalog(document);
    const used = (await rest(`gear_catalog_publications?target=eq.${target}&select=revision`)).map((x: any) => x.revision);
    let baselineDoc: any = r.baselineDoc;
    try {
      parseBytes(bytes);
      const liveBytes = r.baselineBytes;
      if (liveBytes) {
        baselineDoc = JSON.parse(new TextDecoder().decode(liveBytes));
        if (foreignMayBeAccepted && storage.originRevision) used.push(storage.originRevision);
        if (checkSuccessor(baselineDoc, liveBytes, document, bytes, used) !== 'newer') throw new CatalogRejected('identical to the live publication');
      }
    } catch (error) {
      if (error instanceof CatalogRejected) throw new HttpError(422, 'invalid', error.message);
      throw error;
    }
    void latest;
    const digest = await sha256(bytes);
    const summary = summarize(diffCatalogs(baselineDoc, document));
    await pause(fault, 'before_record');
    const publicationId = await rpc('gear_record_publication', {
      p_token: token, p_target: target, p_expected_head_revision: head?.revision ?? null, p_revision: document.revision,
      p_published_at: publishedAt, p_document: new TextDecoder().decode(bytes), p_digest: digest, p_summary: summary,
      p_draft_version: draftVersion, p_rollback_of: rollbackOf, p_validator_version: VALIDATOR_VERSION,
      p_published_by: caller.id, p_auth_aal: caller.aal, p_auth_amr: caller.amr,
    });
    const result = { target, publicationId, revision: document.revision, publishedAt, digest, bytes: bytes.length, summary };
    if (hasFault(fault, 'crash_after_commit')) {
      keepLease(); // a crashed process would not release its lease; it expires
      throw new HttpError(500, 'test_crash_after_commit', 'Test fault: stopped after the database commit, before the Storage upload', { revision: document.revision });
    }
    await pause(fault, 'after_commit');
    try {
      await upload(target, bytes, fault, { jwt: caller.jwt, userId: caller.id, token, target, publicationId, deadline, fault });
    } catch (error) {
      if (error instanceof StorageRejected) {
        // Storage refused this write (stale lease, object changed since it was read, or step-up
        // expired). Try to record it; if the lease is gone that fails too, which is correct: a stale
        // process may not finalize database state either.
        await rpc('gear_record_status', { p_token: token, p_publication_id: publicationId, p_status: 'refused', p_note: 'Storage refused the write before the upload (RLS); nothing stored' }).catch(() => {});
        throw new HttpError(409, 'storage_write_rejected', 'Storage rejected the write: the lease expired, the object changed since it was read, or the MFA step-up expired. Nothing was overwritten.', { revision: document.revision });
      }
      if (!(error instanceof UploadUncertain)) throw error;
      await rpc('gear_record_status', { p_token: token, p_publication_id: publicationId, p_status: 'uncertain', p_note: error.message });
      return { ...result, storage: 'uncertain', note: error.message };
    }
    const readBack = await readOrigin(target);
    const verified = !!readBack && (await sha256(readBack)) === digest;
    await rpc('gear_record_status', { p_token: token, p_publication_id: publicationId, p_status: verified ? 'verified' : 'conflict', p_note: verified ? 'origin read-back matches' : 'origin holds different bytes after upload' });
    return { ...result, storage: verified ? 'verified' : 'conflict' };
  });
}

async function reconcile(caller: Caller, body: any, fault: string | null) {
  requirePublisher(caller, body.target);
  return withLease(body.target, (token, _keep, deadline) => inspectStorage(body.target, { repair: true, token, jwt: caller.jwt, userId: caller.id, fault, deadline }));
}

async function acknowledge(caller: Caller, body: any) {
  requirePublisher(caller, body.target);
  return withLease(body.target, async (token) => {
    const storage: any = await inspectStorage(body.target);
    if (storage.state !== 'drift' || storage.originDigest !== body.digest) throw new HttpError(409, 'drift_changed', 'Storage changed since you reviewed it');
    if (storage.futureIncident) {
      await rpc('gear_audit', { p_actor: caller.id, p_event: 'drift_future_timestamp_refused', p_detail: { target: body.target, digest: body.digest, publishedAt: storage.originPublishedAt } });
      throw new HttpError(409, 'drift_future_timestamp', 'A catalog that passes validation with a far-future publishedAt is an incident: not acknowledged, publishing stays blocked', { storage });
    }
    await rpc('gear_record_drift_ack', { p_token: token, p_target: body.target, p_digest: body.digest, p_foreign_revision: storage.originRevision,
      p_foreign_published_at: storage.originPublishedAt, p_passes_validation: storage.passesValidation, p_validation_error: storage.validationError, p_acknowledged_by: caller.id });
    return { acknowledged: true, passesValidation: storage.passesValidation };
  });
}

async function inspect(caller: Caller, body: any) {
  requireAdmin(caller);
  const result: any = await inspectStorage(body.target);
  if (result.state === 'drift' && result.acknowledged && result.passesValidation) {
    const origin = await readOrigin(body.target);
    result.baseline = { source: 'acknowledged_storage', document: origin ? JSON.parse(new TextDecoder().decode(origin)) : null };
  } else {
    const { latest } = await loadTarget(body.target);
    result.baseline = { source: 'recorded', document: latest ? JSON.parse(latest.document) : null };
  }
  if (TEST_FAULTS) result.diagnostics = { serviceCredential: SERVICE_KEY.startsWith('sb_secret_') ? 'secret_key' : 'legacy_service_role_jwt' };
  return result;
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
    const fault = TEST_FAULTS ? req.headers.get('x-gear-test-fault') : null;
    switch (body.action) {
      case 'publish': return json(200, await publish(caller, body, fault));
      case 'rollback': return json(200, await publish(caller, { ...body, rollbackOf: body.publicationId }, fault));
      case 'reconcile': return json(200, await reconcile(caller, body, fault));
      case 'acknowledge': return json(200, await acknowledge(caller, body));
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
