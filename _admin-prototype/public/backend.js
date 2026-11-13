// Backend adapters for the admin UI. Both expose the same interface, so the editor code does not
// know which one it talks to:
//   - simulated:      the prototype's local /api server (fictional accounts, simulated MFA)
//   - local-supabase: a LOCAL Supabase stack: real Auth with TOTP, PostgREST under RLS, the
//                     gear-publish Edge Function and Storage. The page holds only public values
//                     (local URL + publishable key) and the signed-in user's own session.
// Neither adapter holds a secret or makes an authorization decision.

class BackendError extends Error {
  constructor(status, data) {
    super(data?.message ?? `HTTP ${status}`);
    this.status = status;
    this.data = data ?? {};
  }
}

// ---------------------------------------------------------------- simulated
export function createSimulatedBackend() {
  const get = (k) => { try { return sessionStorage.getItem(k); } catch { return null; } };
  const set = (k, v) => { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch { /* private mode */ } };
  const ident = { user: get('prototype-user'), aal: get('prototype-aal') ?? 'aal2' };
  async function api(path, { method = 'GET', body, headers = {} } = {}) {
    const binary = body instanceof ArrayBuffer;
    const res = await fetch(path, {
      method,
      headers: { 'X-Prototype-User': ident.user ?? '', 'X-Prototype-AAL': ident.aal, ...(body !== undefined && !binary ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new BackendError(res.status, data);
    return data;
  }
  return {
    mode: 'simulated',
    ident,
    setSimulatedUser(email) { ident.user = email || null; set('prototype-user', ident.user); },
    setSimulatedAal(aal) { ident.aal = aal; set('prototype-aal', aal); },
    session: () => api('/api/session'),
    loadState: () => api('/api/state'),
    saveDraft: (baseVersion, working) => api('/api/draft', { method: 'PUT', headers: { 'If-Match': `"v${baseVersion}"` }, body: working }),
    review: (target) => api('/api/review', { method: 'POST', body: { target } }),
    reviewRollback: async () => null,
    publish: (body) => api('/api/publish', { method: 'POST', body }),
    rollback: (body) => api('/api/rollback', { method: 'POST', body }),
    reconcile: (target) => api('/api/reconcile', { method: 'POST', body: { target } }),
    acknowledge: (target, digest) => api('/api/drift/acknowledge', { method: 'POST', body: { target, digest } }),
    history: (target) => api(`/api/history?target=${encodeURIComponent(target)}`),
    async uploadImage({ brandId, contentType, buffer, sha256 }) {
      const grant = await api('/api/uploads/sign', { method: 'POST', body: { brandId, contentType, byteLength: buffer.byteLength, sha256 } });
      if (!grant.alreadyStored) await api(grant.uploadURL, { method: 'PUT', body: buffer, headers: { 'Content-Type': contentType } });
      return { publicURL: grant.publicURL, alreadyStored: !!grant.alreadyStored };
    },
    verify: null,
    dev: (path, body) => api(`/api/dev/${path}`, { method: 'POST', body }),
    signOut: async () => { ident.user = null; set('prototype-user', null); },
  };
}

// ---------------------------------------------------------------- local Supabase
export function createSupabaseBackend(cfg) {
  const STORE = 'gear-admin-local-session';
  const read = () => { try { return JSON.parse(sessionStorage.getItem(STORE) ?? 'null'); } catch { return null; } };
  let session = read();
  let factorId = null;
  const save = (s) => {
    session = s ? { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at } : null;
    try { s ? sessionStorage.setItem(STORE, JSON.stringify(session)) : sessionStorage.removeItem(STORE); } catch { /* private mode */ }
  };
  const claims = () => (session ? JSON.parse(atob(session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) : null);
  const expired = (why) => new BackendError(401, { error: 'session_expired', message: why ?? 'Your session ended (it expired, was signed out elsewhere or was revoked). Sign in again.' });

  async function auth(path, { method = 'POST', body, token } = {}) {
    const res = await fetch(`${cfg.supabaseUrl}/auth/v1/${path}`, {
      method, body: body ? JSON.stringify(body) : undefined,
      headers: { apikey: cfg.publishableKey, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new BackendError(res.status, { error: data.error_code ?? data.code ?? 'auth_error', message: data.msg ?? data.message ?? data.error_description ?? 'Authentication failed' });
    return data;
  }
  async function refresh() {
    if (!session?.refresh_token) { save(null); throw expired(); }
    try { save(await auth('token?grant_type=refresh_token', { body: { refresh_token: session.refresh_token } })); }
    catch { save(null); throw expired(); }
  }
  async function accessToken() {
    if (!session) throw expired('Sign in to continue.');
    if (session.expires_at * 1000 - Date.now() < 60_000) await refresh(); // refresh shortly before expiry
    return session.access_token;
  }
  async function call(url, init = {}, retried = false) {
    const token = await accessToken();
    const res = await fetch(url, { ...init, headers: { apikey: cfg.publishableKey, Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
    if (res.status === 401 && !retried) { await refresh(); return call(url, init, true); }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (res.status === 401) { save(null); throw expired(); }
    if (!res.ok) {
      const message = data?.message ?? String(data ?? res.statusText);
      const code = data?.error ?? /^([a-z_]+):/.exec(message)?.[1] ?? 'error';
      throw new BackendError(res.status, { ...(typeof data === 'object' ? data : {}), error: code, message });
    }
    return data;
  }
  const rest = (path, init) => call(`${cfg.supabaseUrl}/rest/v1/${path}`, init);
  const rpc = (name, args) => rest(`rpc/${name}`, { method: 'POST', body: JSON.stringify(args), headers: { 'Content-Type': 'application/json' } });
  const fn = (body) => call(`${cfg.supabaseUrl}/functions/v1/gear-publish`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  const me = () => claims()?.sub;
  const who = (id) => (!id ? 'seed (fictional)' : id === me() ? 'you' : `admin ${id.slice(0, 8)}`);
  const mapDraft = (row) => ({ catalog: row.catalog, meta: row.meta, version: row.version, updatedBy: who(row.updated_by), updatedAt: row.updated_at });

  async function loadDraft() {
    const [row] = await rest('gear_catalog_drafts?id=eq.main&select=catalog,meta,version,updated_by,updated_at');
    return mapDraft(row);
  }

  return {
    mode: 'local-supabase',
    config: cfg,
    async session() {
      const base = { mode: 'local-supabase', productionConfirmation: 'PUBLISH PRODUCTION', accounts: [] };
      if (!session) return { ...base, user: null };
      try {
        const token = await accessToken();
        const user = await auth('user', { method: 'GET', token });
        const c = claims();
        const [row] = await rest(`gear_admins?select=role&user_id=eq.${encodeURIComponent(c.sub)}`);
        const totp = (user.factors ?? []).filter((f) => f.factor_type === 'totp');
        factorId = totp.find((f) => f.status === 'verified')?.id ?? null;
        return { ...base, user: { email: user.email, id: c.sub, role: row?.role ?? null, aal: c.aal, name: user.email }, mfa: { enrolled: !!factorId, unverified: totp.filter((f) => f.status !== 'verified').map((f) => f.id) } };
      } catch (error) {
        if (error.data?.error === 'session_expired') return { ...base, user: null, ended: error.message };
        throw error;
      }
    },
    async signIn(email, password) { save(await auth('token?grant_type=password', { body: { email, password } })); },
    async enrollTotp() {
      const token = await accessToken();
      const f = await auth('factors', { token, body: { factor_type: 'totp', friendly_name: `admin-${Date.now()}` } });
      factorId = f.id;
      return { factorId: f.id, secret: f.totp.secret, uri: f.totp.uri };
    },
    async verifyTotp(code) {
      if (!factorId) throw new BackendError(400, { error: 'no_factor', message: 'No authenticator is enrolled for this account' });
      const token = await accessToken();
      const challenge = await auth(`factors/${factorId}/challenge`, { token, body: {} });
      save(await auth(`factors/${factorId}/verify`, { token, body: { challenge_id: challenge.id, code } }));
    },
    async signOut() {
      try { if (session) await auth('logout?scope=local', { token: session.access_token }); } catch { /* already ended */ }
      save(null);
    },
    async loadState() {
      const draft = await loadDraft();
      const heads = await rest('gear_publication_head?select=target,revision,published_at,digest');
      const live = {};
      const publishedDraftVersions = {};
      const storage = {};
      const baselines = {};
      for (const target of ['staging', 'production']) {
        const head = heads.find((h) => h.target === target);
        const [latest] = await rest(`gear_catalog_publications?target=eq.${target}&select=revision,published_at,document,draft_version&order=published_at.desc&limit=1`);
        live[target] = { head: head?.revision ? { revision: head.revision, publishedAt: head.published_at, digest: head.digest } : null, document: latest ? JSON.parse(latest.document) : null };
        publishedDraftVersions[target] = latest?.draft_version ?? null;
        const inspected = await fn({ action: 'inspect', target });
        storage[target] = inspected;
        baselines[target] = inspected.baseline;
      }
      return { draft, live, publishedDraftVersions, storage, baselines };
    },
    async saveDraft(baseVersion, working) {
      try {
        const row = await rpc('save_gear_draft', { expected_version: baseVersion, new_catalog: working.catalog, new_meta: working.meta });
        return { draft: mapDraft(row) };
      } catch (error) {
        if (error.status === 409) throw new BackendError(409, { error: 'draft_conflict', message: 'Someone else saved the draft', current: await loadDraft() });
        throw error;
      }
    },
    review: (target) => fn({ action: 'review', target }),
    reviewRollback: (target, publicationId) => fn({ action: 'review', target, rollbackOf: publicationId }),
    async publish(body) {
      const r = await fn({ action: 'publish', ...body });
      return { ...r, readBack: r.storage === 'verified' ? 'verified: the local Storage origin holds exactly the recorded bytes' : `storage: ${r.storage}`,
        objectPath: `recommended-gear/${r.target === 'staging' ? 'staging/' : ''}catalog-v1.json (local stack)` };
    },
    async rollback(body) {
      const r = await fn({ action: 'rollback', ...body });
      return { ...r, readBack: `storage: ${r.storage}`, objectPath: `recommended-gear/${r.target === 'staging' ? 'staging/' : ''}catalog-v1.json (local stack)` };
    },
    reconcile: (target) => fn({ action: 'reconcile', target }),
    acknowledge: (target, digest) => fn({ action: 'acknowledge', target, digest }),
    async history(target) {
      const pubs = await rest(`gear_catalog_publications?target=eq.${target}&select=id,target,revision,published_at,published_by,digest,document,summary,rollback_of,draft_version&order=published_at.desc`);
      const ids = pubs.map((p) => p.id);
      const statuses = ids.length ? await rest(`gear_publication_status?select=publication_id,status,id&publication_id=in.(${ids.join(',')})&order=id.asc`) : [];
      const latestStatus = new Map(statuses.map((s) => [s.publication_id, s.status]));
      return { history: pubs.map((p) => ({ id: p.id, target: p.target, revision: p.revision, publishedAt: p.published_at, publishedBy: who(p.published_by), digest: p.digest,
        document: p.document, summary: p.summary, rollbackOf: p.rollback_of, draftVersion: p.draft_version, storageStatus: latestStatus.get(p.id) ?? 'recorded' })) };
    },
    async uploadImage({ brandId, contentType, buffer }) {
      return call(`${cfg.supabaseUrl}/functions/v1/gear-publish?action=upload_image&brand=${encodeURIComponent(brandId)}`, { method: 'POST', body: buffer, headers: { 'Content-Type': contentType } });
    },
    verify: () => fn({ action: 'verify' }),
    dev: null,
  };
}

export async function createBackend() {
  const res = await fetch('/config.json', { cache: 'no-store' });
  const cfg = res.ok ? await res.json() : { mode: 'simulated' };
  return cfg.mode === 'local-supabase' ? createSupabaseBackend(cfg) : createSimulatedBackend();
}
