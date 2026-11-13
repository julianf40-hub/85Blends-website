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
const TEST_FAULTS = Deno.env.get('GEAR_ALLOW_TEST_FAULTS') === 'local-only'
  && /^http:\/\/(kong|127\.0\.0\.1|localhost)(:\d+)?$/.test(SUPABASE_URL);
const MAX_FUTURE_SKEW = 300;
const BUCKET = 'recommended-gear';
const CONFIRMATION = 'PUBLISH PRODUCTION';
const VALIDATOR_VERSION = 'js-port-of-validate_catalog.py@e6c42ed';
const TARGETS = ['staging', 'production'];
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
type WriteContext = { jwt: string; token: string };
const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

async function upload(target: string, bytes: Uint8Array, fault: string | null, ctx: WriteContext) {
  if (fault === 'upload_timeout') throw new UploadUncertain('upload timed out before Storage answered (test fault: not stored)');
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectPath(target)}`, {
      method: 'POST', body: bytes,
      headers: {
        apikey: ANON_KEY, Authorization: `Bearer ${ctx.jwt}`, // the caller's verified session, subject to Storage RLS
        'Content-Type': 'application/json', 'Cache-Control': 'max-age=60', 'x-upsert': 'true',
        'x-metadata': b64(JSON.stringify({ gear_lease: ctx.token })),
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new UploadUncertain(`upload did not complete (${(error as Error).message}); it may or may not be stored`);
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    // RLS refusal: stale lease token, object changed since it was read (CAS), not the aal2 publisher,
    // or (Production) TOTP step-up expired. Storage kept the previous object version.
    if ((res.status === 400 || res.status === 403) && /row-level security|Unauthorized|policy/i.test(text)) throw new StorageRejected(text);
    throw new HttpError(502, 'upload_refused', `Storage refused the upload: HTTP ${res.status} ${text}`);
  }
  if (fault === 'response_lost') throw new UploadUncertain('response lost after the body was sent (test fault: stored)');
}

const prepareWrite = (target: string, token: string) => rpc('gear_prepare_write', { p_token: token, p_target: target });
const pause = async (fault: string | null, point: string) => {
  const m = fault ? new RegExp(`^pause_${point}:(\\d{1,5})$`).exec(fault) : null;
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

async function inspectStorage(target: string, opts: { repair?: boolean; token?: string; jwt?: string; fault?: string | null } = {}) {
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
  const neverLanded = ['recorded', 'uncertain'].includes(status ?? '')
    && (originDigest === null || originDigest === previous?.digest || acknowledged.has(originDigest));
  if (neverLanded) {
    if (!opts.repair) return { ...base, state: 'pending', reason: 'the latest recorded publication has not reached Storage yet' };
    await pause(opts.fault ?? null, 'before_resend');
    const bytes = new TextEncoder().encode(latest.document); // identical recorded bytes; one attempt, no retry loop
    try { await upload(target, bytes, null, { jwt: opts.jwt!, token: opts.token! }); } catch (error) {
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

async function withLease<T>(target: string, fn: (token: string, keep: () => void) => Promise<T>): Promise<T> {
  const token = await rpc('gear_acquire_lease', { p_target: target, p_ttl_seconds: LEASE_SECONDS });
  let release = true;
  try {
    return await fn(token, () => { release = false; });
  } finally {
    if (release) await rpc('gear_release_lease', { p_target: target, p_token: token }).catch(() => {});
  }
}

// ---------------------------------------------------------------- actions
async function publish(caller: Caller, body: any, fault: string | null) {
  const target = body.target;
  requirePublisher(caller, target);
  if (target === 'production' && body.confirmation !== CONFIRMATION) throw new HttpError(400, 'confirmation_required', `Type ${CONFIRMATION} to publish to Production`);
  return withLease(target, async (token, keepLease) => {
    const storage: any = await inspectStorage(target, { repair: true, token, jwt: caller.jwt, fault });
    if (storage.state === 'drift' && storage.futureIncident) {
      await rpc('gear_audit', { p_actor: caller.id, p_event: 'incident_future_timestamp_blocked_publish', p_detail: { target, digest: storage.originDigest, publishedAt: storage.originPublishedAt } });
      throw new HttpError(409, 'incident_future_timestamp', `Storage holds a catalog that passes validation stamped ${storage.originPublishedAt}, more than ${MAX_FUTURE_SKEW} s ahead. Publishing is blocked and reported; nothing is overwritten.`, { storage });
    }
    if (storage.state === 'drift' && !storage.acknowledged) throw new HttpError(409, 'storage_drift', `${target}: ${storage.reason}. Acknowledge it before publishing.`, { storage });
    if (storage.state === 'pending') throw new HttpError(409, 'storage_uncertain', `${target}: the previous upload is still unconfirmed; reconcile again`, { storage });

    const { head, latest } = await loadTarget(target);
    if ((body.expectedLiveRevision ?? null) !== (head?.revision ?? null)) {
      throw new HttpError(409, 'live_changed', `${target} changed since you reviewed it (now ${head?.revision ?? 'nothing published'})`);
    }
    let brands: any[];
    let draftVersion: number | null = null;
    let rollbackOf: string | null = null;
    const [draft] = await rest('gear_catalog_drafts?id=eq.main&select=catalog,meta,version');
    if (body.rollbackOf) {
      const [source] = await rest(`gear_catalog_publications?id=eq.${encodeURIComponent(body.rollbackOf)}&target=eq.${target}&select=id,document`);
      if (!source) throw new HttpError(404, 'not_found', 'No such publication for this target');
      brands = JSON.parse(source.document).brands;
      rollbackOf = source.id;
    } else {
      if (body.draftVersion !== draft.version) throw new HttpError(409, 'draft_changed', `The draft is now version ${draft.version}; you reviewed version ${body.draftVersion}`);
      brands = draft.catalog.brands;
      draftVersion = draft.version;
    }

    const now = Math.floor(Date.now() / 1000);
    const foreignMayBeAccepted = storage.state === 'drift' && storage.acknowledged && storage.passesValidation;
    const highest = Math.max(head?.published_at ?? 0, foreignMayBeAccepted ? storage.originPublishedAt ?? 0 : 0);
    if (highest > now + MAX_FUTURE_SKEW) throw new HttpError(409, 'live_in_future', `${target} publishedAt ${highest} is more than ${MAX_FUTURE_SKEW} s ahead; resolve the clock problem first`);

    const publishedAt = Math.max(now, highest + 1);
    const document = { schemaVersion: 1, revision: crypto.randomUUID(), publishedAt, brands };
    const errors = [...collectIssues(document).errors, ...(target === 'production' ? approvalErrors(brands, draft.meta) : [])];
    if (errors.length) throw new HttpError(422, 'invalid', 'The catalog cannot be published', { errors });
    const bytes = encodeCatalog(document);
    const used = (await rest(`gear_catalog_publications?target=eq.${target}&select=revision`)).map((r: any) => r.revision);
    let baselineDoc: any = latest ? JSON.parse(latest.document) : null;
    try {
      parseBytes(bytes);
      const liveBytes = foreignMayBeAccepted ? await readOrigin(target) : latest ? new TextEncoder().encode(latest.document) : null;
      if (liveBytes) {
        baselineDoc = JSON.parse(new TextDecoder().decode(liveBytes));
        if (foreignMayBeAccepted && storage.originRevision) used.push(storage.originRevision);
        if (checkSuccessor(baselineDoc, liveBytes, document, bytes, used) !== 'newer') throw new CatalogRejected('identical to the live publication');
      }
    } catch (error) {
      if (error instanceof CatalogRejected) throw new HttpError(422, 'invalid', error.message);
      throw error;
    }
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
    if (fault === 'crash_after_commit') {
      keepLease(); // a crashed process would not release its lease; it expires
      throw new HttpError(500, 'test_crash_after_commit', 'Test fault: stopped after the database commit, before the Storage upload', { revision: document.revision });
    }
    await pause(fault, 'after_commit');
    try {
      await upload(target, bytes, fault, { jwt: caller.jwt, token });
    } catch (error) {
      if (error instanceof StorageRejected) {
        // Storage refused this write (stale lease, object changed since it was read, or step-up
        // expired). Try to record it; if the lease is gone that fails too, which is correct: a stale
        // process may not finalize database state either.
        await rpc('gear_record_status', { p_token: token, p_publication_id: publicationId, p_status: 'conflict', p_note: 'Storage rejected the write (RLS)' }).catch(() => {});
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
  return withLease(body.target, (token) => inspectStorage(body.target, { repair: true, token, jwt: caller.jwt, fault }));
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
  if (TEST_FAULTS) result.diagnostics = { serviceCredential: SERVICE_KEY.startsWith('sb_secret_') ? 'secret_key' : 'legacy_service_role_jwt' };
  return result;
}

Deno.serve(async (req) => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'method', 'POST only');
    const caller = await authenticate(req);
    const body = await req.json().catch(() => { throw new HttpError(400, 'bad_json', 'Body must be JSON'); });
    if (!TARGETS.includes(body.target)) throw new HttpError(400, 'bad_target', 'target must be staging or production');
    const fault = TEST_FAULTS ? req.headers.get('x-gear-test-fault') : null;
    switch (body.action) {
      case 'publish': return json(200, await publish(caller, body, fault));
      case 'rollback': return json(200, await publish(caller, { ...body, rollbackOf: body.publicationId }, fault));
      case 'reconcile': return json(200, await reconcile(caller, body, fault));
      case 'acknowledge': return json(200, await acknowledge(caller, body));
      case 'inspect': return json(200, await inspect(caller, body));
      default: throw new HttpError(400, 'bad_action', 'Unknown action');
    }
  } catch (error) {
    if (error instanceof HttpError) return json(error.status, { error: error.code, message: error.message, ...error.extra });
    console.error(error);
    return json(500, { error: 'internal', message: 'Internal error' });
  }
});
