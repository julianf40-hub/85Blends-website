// 85Blends Admin — Recommended Gear editor (local prototype).
// The browser holds NO credentials and makes no authorization decisions: it only calls the local
// API, which enforces roles, MFA, locking and validation. Validation here is for instant feedback
// and uses the same module the server runs.

import { collectIssues, LIMITS, BUNDLED_WHEEL_IDS, RVP_SPONSOR_ID, encodeCatalog, MAXIMUM_BYTES, charCount } from '/lib/validator.mjs';
import { diffCatalogs, summarize } from '/lib/diff.mjs';
import { appBehaviourNotes, REQUIRES_APP_RELEASE, EDITABLE_WITHOUT_RELEASE } from '/lib/capabilities.mjs';
import { previewSource } from '/lib/images.mjs';
import { renderPreview } from './preview.js';
import { escapeHTML as e, clone, formatTime, toUTCInput, fromUTCInput, getPath, setPath, sha256Hex } from './util.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const nowSeconds = () => Math.floor(Date.now() / 1000);
const safeSession = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch { /* private mode */ } },
};

const S = {
  session: null,
  user: safeSession.get('prototype-user'),
  aal: safeSession.get('prototype-aal') ?? 'aal2',
  server: null, // { draft, live, publishedDraftVersions }
  base: null, // the saved draft the working copy started from
  working: null, // { catalog, meta }
  selected: 0,
  tab: 'preview',
  changesTarget: 'production',
  preview: { source: 'draft', theme: 'light', narrow: false, largeText: false, time: null },
  reviews: {},
  results: {},
  history: [],
  historyTarget: 'production',
  confirmText: '',
  acknowledged: false,
};

// ---------------------------------------------------------------- API
async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const binary = body instanceof ArrayBuffer;
  const res = await fetch(path, {
    method,
    headers: {
      'X-Prototype-User': S.user ?? '', 'X-Prototype-AAL': S.aal,
      ...(body !== undefined && !binary ? { 'Content-Type': 'application/json' } : {}), ...headers,
    },
    body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.message ?? res.statusText);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

// ---------------------------------------------------------------- derived state
const brands = () => S.working.catalog.brands;
const current = () => brands()[S.selected];
const isDirty = () => S.working && JSON.stringify(S.working) !== JSON.stringify({ catalog: S.base.catalog, meta: S.base.meta });
const candidate = () => ({ schemaVersion: 1, revision: 'set-by-server-at-publish', publishedAt: nowSeconds(), brands: brands() });
const role = () => S.session?.user?.role;
const publishedIds = () => new Set(['staging', 'production'].flatMap((t) => (S.server.live[t].document?.brands ?? []).map((b) => b.id)));
const liveDoc = (target) => S.server.live[target].document;

function localChecks() {
  const doc = candidate();
  const { errors, warnings } = collectIssues(doc);
  const bytes = encodeCatalog(doc).length;
  if (bytes > MAXIMUM_BYTES) errors.push({ path: '', message: `document is ${bytes} bytes; limit ${MAXIMUM_BYTES}` });
  return { errors, warnings, notes: appBehaviourNotes(doc), bytes };
}

const issuePath = (index, rel) => `brands[${index}]${rel ? '.' + rel.replace(/\.(\d+)(?=\.|$)/g, '[$1]') : ''}`;

// ---------------------------------------------------------------- boot
async function boot() {
  try {
    S.session = await api('/api/session');
  } catch (error) {
    $('#workspace').innerHTML = `<p class="error-block">Cannot reach the local prototype server: ${e(error.message)}</p>`;
    return;
  }
  renderAccount();
  if (!S.session.user) return renderSignedOut();
  await loadState();
  setInterval(poll, 10_000);
}

async function loadState({ keepWorking = false } = {}) {
  try {
    S.server = await api('/api/state');
  } catch (error) {
    if (error.status === 401 || error.status === 403) return renderSignedOut(error.message);
    throw error;
  }
  const fresh = S.server.draft;
  const retainEdits = keepWorking && S.base && S.working && isDirty();
  if (retainEdits && fresh.version !== S.base.version) {
    // Keep the base the edits were made on. Advancing it would make the next save send the newer
    // version in If-Match and silently overwrite the other session's changes (PR #7 review).
    S.pendingRemote = clone(fresh);
  } else {
    S.base = clone(fresh);
    if (!retainEdits) S.working = { catalog: clone(S.base.catalog), meta: clone(S.base.meta) };
    S.pendingRemote = null;
  }
  S.selected = Math.min(S.selected, Math.max(0, brands().length - 1));
  renderAll();
  if (S.pendingRemote) showRemoteNotice(S.pendingRemote);
}

function showRemoteNotice(draft) {
  const notice = $('#remote-notice');
  notice.hidden = false;
  notice.innerHTML = `<strong>${e(draft.updatedBy)}</strong> saved draft version ${draft.version} while you have unsaved edits based on version ${S.base.version}. Saving will ask you to resolve the conflict.
    <button type="button" data-action="resolve-remote">Review now</button>`;
}

async function poll() {
  if (!S.server || document.hidden) return;
  let fresh;
  try { fresh = await api('/api/state'); } catch { return; }
  const draftMoved = fresh.draft.version !== S.base.version;
  const liveMoved = ['staging', 'production'].some((t) => fresh.live[t].head?.revision !== S.server.live[t].head?.revision);
  if (!draftMoved && !liveMoved) return;
  if (draftMoved && !isDirty()) {
    S.server = fresh;
    S.base = clone(fresh.draft);
    S.working = { catalog: clone(S.base.catalog), meta: clone(S.base.meta) };
    toast(`Draft updated to version ${fresh.draft.version} by ${fresh.draft.updatedBy}`);
    S.reviews = {};
    return renderAll();
  }
  if (draftMoved) {
    S.pendingRemote = fresh.draft;
    showRemoteNotice(fresh.draft);
  }
  if (liveMoved) {
    S.server.live = fresh.live;
    S.server.publishedDraftVersions = fresh.publishedDraftVersions;
    S.reviews = {};
    toast('A publication changed what is live. Server checks were reset.');
    renderSide();
  }
}

// ---------------------------------------------------------------- top bar and sign-in
function renderAccount() {
  const accounts = S.session.accounts.map((a) => `<option value="${e(a.email)}" ${a.email === S.user ? 'selected' : ''}>${e(a.name)} · ${e(a.role)}</option>`).join('');
  $('#account').innerHTML = `
    <span class="sim-tag" title="No real sign-in, roles or MFA exist in this prototype">SIMULATED</span>
    <label class="account-select"><span class="account-label">Simulated account</span>
      <select data-action="switch-user" aria-describedby="account-note"><option value="">Simulated sign-out</option>${accounts}</select></label>
    <label class="mfa"><input type="checkbox" data-action="toggle-mfa" ${S.aal === 'aal2' ? 'checked' : ''}> Simulated MFA (aal2)</label>
    <span id="account-note" class="sr-only">Simulated sign-in, role and MFA. Nothing is verified. A real deployment would use Supabase Auth with mandatory TOTP MFA and server-side roles.</span>`;
}

function renderSignedOut(message) {
  $('#draft-status').textContent = '';
  $('#workspace').innerHTML = `<section class="signin">
    <h1>Recommended Gear Admin <span class="sim-tag">SIMULATED SIGN-IN</span></h1>
    ${message ? `<p class="error-block">${e(message)}</p>` : ''}
    <p><strong>There is no real sign-in here.</strong> Choose a fictional account to <em>simulate</em> one. The role and the MFA level are also simulated: they are sent as plain headers to the local server, which a real deployment must never trust. Each browser tab keeps its own simulated account.</p>
    <ul class="plain">${S.session.accounts.map((a) => `<li><button type="button" data-action="sign-in" data-email="${e(a.email)}">${e(a.name)}</button> <span class="muted">${e(a.email)} · ${e(a.role)}</span></li>`).join('')}</ul>
    <p class="muted">Proposed operating model: Julian is the only publisher, MFA is required, only the publisher can publish (Staging and Production), and Production needs one person's reviewed summary plus a typed confirmation. In a real admin this would be Supabase Auth (invite-only, TOTP MFA) with roles from a server-side <code>gear_admins</code> table.</p>
  </section>`;
}

function renderStatus() {
  const dirty = isDirty();
  $('#draft-status').innerHTML = `
    <span class="pill ${dirty ? 'warn' : 'ok'}">${dirty ? 'Unsaved changes' : 'Saved'}</span>
    <span class="muted">Draft v${S.base.version} · ${e(S.base.updatedBy)} · ${e(new Date(S.base.updatedAt).toLocaleString())}</span>
    <button type="button" class="primary" data-action="save" ${dirty && !S.saving ? '' : 'disabled'} title="Save draft (Ctrl/⌘ S)">${S.saving ? 'Saving…' : 'Save draft'}</button>
    <button type="button" data-action="discard" ${dirty ? '' : 'disabled'}>Discard</button>
    <details class="devtools"><summary>Prototype tools</summary>
      <button type="button" data-action="dev-other-edit">Simulate a draft save from another tab or device</button>
      <span class="devtools-label">Next Staging publish:</span>
      <button type="button" data-action="dev-fault" data-target="staging" data-fault="crash_after_commit">crash after DB commit</button>
      <button type="button" data-action="dev-fault" data-target="staging" data-fault="response_lost">upload response lost (stored)</button>
      <button type="button" data-action="dev-fault" data-target="staging" data-fault="upload_timeout">upload timeout (not stored)</button>
      <span class="devtools-label">Writers that bypass the lock (Staging):</span>
      <button type="button" data-action="dev-external" data-target="staging" data-kind="cli">CLI publish (publish_catalog.py --upload)</button>
      <button type="button" data-action="dev-external" data-target="staging" data-kind="older">older file re-uploaded / late upload</button>
      <button type="button" data-action="dev-external" data-target="staging" data-kind="invalid">invalid file uploaded</button>
      <button type="button" data-action="dev-external" data-target="staging" data-kind="future">valid file with a far-future publishedAt</button>
      <button type="button" data-action="dev-reset">Reset all prototype data</button>
    </details>`;
}

// ---------------------------------------------------------------- layout
function renderAll() {
  $('#remote-notice').hidden = true;
  $('#workspace').innerHTML = `
    <aside class="panel list-panel" aria-labelledby="list-title">
      <div class="panel-head"><h2 id="list-title">Catalog order</h2>
        <button type="button" data-action="add-brand" title="Add a neutral Featured Brand card">+ Featured Brand</button></div>
      <p class="muted small">Array order is display order on Recommended Gear and on More. Drag, or use the arrows.</p>
      <ol class="brand-list" id="brand-list"></ol>
      <p class="muted small">Sponsor cards: at most one, and its layout is reserved for the <code>${RVP_SPONSOR_ID}</code> id. A new layout needs an app release.</p>
    </aside>
    <section class="panel editor-panel" id="editor" aria-label="Edit selected card"></section>
    <section class="panel side-panel" aria-label="Preview, changes, checks and publishing">
      <div class="tabs" role="tablist" id="tabs"></div>
      <div id="side" class="side-body" role="tabpanel"></div>
    </section>`;
  renderStatus();
  renderList();
  renderEditor();
  renderSide();
}

function renderList() {
  const checks = localChecks();
  const approvals = S.working.meta.approvals ?? {};
  $('#brand-list').innerHTML = brands().map((b, i) => {
    const errs = checks.errors.filter((x) => x.path.startsWith(`brands[${i}]`)).length;
    const approval = approvals[b.id] ?? 'not recorded';
    return `<li class="brand-item ${i === S.selected ? 'selected' : ''} ${b.hidden ? 'is-hidden' : ''}" draggable="true" data-index="${i}">
      <button type="button" class="brand-select" data-action="select" data-index="${i}" aria-current="${i === S.selected}">
        <span class="brand-name">${e(b.name || b.id || 'Untitled')}</span>
        <span class="chips">
          <span class="chip ${b.kind === 'rvp_wheels' ? 'sponsor' : ''}">${b.kind === 'rvp_wheels' ? 'Sponsor' : b.kind === 'brand' ? 'Featured Brand' : e(b.kind)}</span>
          ${b.hidden ? '<span class="chip muted-chip">Hidden</span>' : ''}
          ${b.more != null ? '<span class="chip">More</span>' : ''}
          ${b.offer ? '<span class="chip">Offer</span>' : ''}
          ${approval !== 'approved' ? `<span class="chip warn">${e(approval)}</span>` : ''}
          ${errs ? `<span class="chip error">${errs} issue${errs > 1 ? 's' : ''}</span>` : ''}
        </span>
      </button>
      <span class="order-buttons">
        <button type="button" class="icon" data-action="move" data-index="${i}" data-delta="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move ${e(b.name)} up">↑</button>
        <button type="button" class="icon" data-action="move" data-index="${i}" data-delta="1" ${i === brands().length - 1 ? 'disabled' : ''} aria-label="Move ${e(b.name)} down">↓</button>
      </span>
    </li>`;
  }).join('') || '<li class="muted">Empty catalog: a valid, authoritative “show nothing”.</li>';
  renderStatus();
}

// ---------------------------------------------------------------- editor
function counter(rel, value, limit) {
  const n = charCount(String(value ?? ''));
  return `<span class="count ${n > limit ? 'over' : ''}" data-count-for="${rel}" data-limit="${limit}">${n}/${limit}</span>`;
}

function input(index, { rel, label, limit, kind = 'text', required = false, multiline = false, help = '', placeholder = '', disabled = false }) {
  const brand = brands()[index];
  const value = getPath(brand, rel);
  const id = `f-${index}-${rel.replace(/\./g, '-')}`;
  const shown = kind === 'datetime' ? toUTCInput(value) : value ?? '';
  const attrs = `id="${id}" data-bind="${rel}" data-kind="${kind}" data-required="${required}" data-path="${issuePath(index, rel)}" aria-describedby="${id}-err${help ? ` ${id}-help` : ''}" ${disabled ? 'disabled' : ''} placeholder="${e(placeholder)}"`;
  const control = multiline
    ? `<textarea ${attrs} rows="3">${e(shown)}</textarea>`
    : `<input ${attrs} type="${kind === 'int' ? 'number' : kind === 'datetime' ? 'datetime-local' : kind === 'url' ? 'url' : 'text'}" ${kind === 'int' ? 'step="1" min="1" max="10000"' : ''} value="${e(shown)}" ${kind === 'url' ? 'spellcheck="false" autocomplete="off"' : ''}>`;
  return `<div class="field">
    <label for="${id}">${e(label)}${required ? ' <span class="req" aria-hidden="true">*</span>' : ' <span class="opt">optional</span>'}</label>
    ${control}
    <div class="field-foot">${help ? `<span id="${id}-help" class="help">${help}</span>` : '<span></span>'}${limit ? counter(rel, value, limit) : ''}</div>
    <p class="field-error" id="${id}-err" data-error-for="${issuePath(index, rel)}"></p>
  </div>`;
}

function imageField(index, rel, label, help) {
  const value = getPath(brands()[index], rel);
  const src = previewSource(value);
  return `<div class="image-field">
    ${input(index, { rel, label, kind: 'url', help, placeholder: 'https://… (upload to get an immutable URL)' })}
    <div class="image-actions">
      ${value ? (src ? `<img class="thumb" src="${src}" alt="">` : '<span class="thumb img-fallback"><span>not loaded</span></span>') : ''}
      <button type="button" data-action="upload" data-rel="${rel}">Upload image…</button>
      ${value ? `<button type="button" data-action="clear" data-rel="${rel}">Remove</button>` : ''}
    </div>
  </div>`;
}

function renderEditor() {
  const el = $('#editor');
  const brand = current();
  if (!brand) {
    el.innerHTML = '<div class="empty-editor"><h2>No cards</h2><p>The catalog is empty. Publishing it shows the empty state on Recommended Gear and no partner cards on More.</p></div>';
    return;
  }
  const i = S.selected;
  const locked = publishedIds().has(brand.id);
  const approval = S.working.meta.approvals?.[brand.id] ?? 'pending';
  const sponsor = brand.kind === 'rvp_wheels';
  const known = brand.kind === 'brand' || sponsor;
  el.innerHTML = `
    <div class="panel-head">
      <h2>${e(brand.name || 'Untitled card')} <span class="chip ${sponsor ? 'sponsor' : ''}">${sponsor ? 'Sponsor card' : known ? 'Featured Brand card' : 'Unknown kind'}</span></h2>
      <div class="head-actions">
        <label class="switch"><input type="checkbox" data-action="toggle-hidden" ${brand.hidden ? 'checked' : ''}> Hidden</label>
        <button type="button" class="danger-quiet" data-action="remove">Remove…</button>
      </div>
    </div>
    <p class="field-error block" data-error-for="${issuePath(i)}"></p>
    ${brand.hidden ? '<p class="info">Hidden: kept in the document but withdrawn from Recommended Gear <strong>and</strong> More on every device that refreshes.</p>' : ''}
    ${!known ? `<p class="info warn">Kind “${e(brand.kind)}” is unknown to v1 apps: they skip it. Showing it needs an app release.</p>` : ''}

    <fieldset><legend>Identity</legend>
      <div class="field">
        <label for="f-id">Stable ID <span class="req" aria-hidden="true">*</span></label>
        <input id="f-id" data-action="edit-id" data-path="${issuePath(i, 'id')}" value="${e(brand.id)}" ${locked || sponsor ? 'readonly' : ''} spellcheck="false" aria-describedby="f-id-help f-id-err">
        <span id="f-id-help" class="help">${sponsor ? 'Reserved by the v1 contract for the sponsor layout.' : locked ? 'Locked: already published. IDs key bundled artwork, analytics and the selected card, and never change.' : 'Lowercase letters, digits and hyphens. Cannot be changed after the first publication.'}</span>
        <p class="field-error" id="f-id-err" data-error-for="${issuePath(i, 'id')}"></p>
      </div>
      <div class="field two">
        <label for="f-approval">Partner approval <span class="opt">dashboard only · never published</span></label>
        <select id="f-approval" data-action="approval">
          ${['pending', 'approved'].map((s) => `<option value="${s}" ${approval === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <span class="help">Production publishing is blocked while a visible card is pending.</span>
      </div>
      <div class="field">
        <label for="f-notes">Internal notes <span class="opt">dashboard only · never published</span></label>
        <textarea id="f-notes" data-action="notes" rows="2">${e(S.working.meta.notes?.[brand.id] ?? '')}</textarea>
      </div>
    </fieldset>

    <fieldset><legend>Card copy and link</legend>
      ${input(i, { rel: 'name', label: 'Name', limit: LIMITS.name, required: true })}
      ${input(i, { rel: 'tagline', label: 'Tagline', limit: LIMITS.tagline, required: true })}
      ${input(i, { rel: 'description', label: 'Description', limit: LIMITS.description, required: true, multiline: true })}
      ${input(i, { rel: 'accessibilityDescription', label: 'VoiceOver / TalkBack text', limit: LIMITS.accessibilityText, multiline: true, help: 'Defaults to the description.' })}
      ${input(i, { rel: 'ctaTitle', label: 'Button title', limit: LIMITS.ctaTitle, required: true })}
      ${input(i, { rel: 'destinationURL', label: sponsor ? 'Collection link (“View All”)' : 'Destination link', kind: 'url', required: true, help: 'https only. Opens in the browser.' })}
      ${!sponsor ? '<p class="help">Neutral cards may not say “sponsor”, “partner”, “affiliate” or “endorse”; the apps reject it.</p>' : ''}
    </fieldset>

    <fieldset><legend>More screen placement</legend>
      <label class="switch"><input type="checkbox" data-action="toggle-more" ${brand.more != null ? 'checked' : ''}> Also show on More</label>
      <p class="help">${sponsor ? 'Shown as the “Sponsored by {name}” banner (fixed app copy) linking to the homepage.' : 'Shown as a compact Featured Brand card under the sponsor banner, in catalog order.'}</p>
      ${brand.more != null ? input(i, { rel: 'more.subtitle', label: 'More subtitle', limit: LIMITS.subtitle, help: 'Defaults to the tagline.' }) : ''}
    </fieldset>

    ${brand.kind === 'brand' ? brandOnlyFields(i, brand) : ''}
    ${sponsor ? sponsorFields(i, brand) : ''}
  `;
  refreshInline();
}

function brandOnlyFields(i, brand) {
  return `
    <fieldset><legend>Images</legend>
      <p class="help">PNG or JPEG, ≤ 5 MB (aim for ≤ 400 KB), each side ≤ 8,192 px. HEIF/HEIC uploads are disabled until server-side decoding and dimension checks exist. Uploads get a new content-addressed URL; files are never overwritten.</p>
      ${imageField(i, 'logo.url', 'Logo (light)', 'Transparent wordmark, about 4:1, legible on white.')}
      ${brand.logo ? imageField(i, 'logo.darkURL', 'Logo (dark / OLED)', 'Use when the light logo is dark.') : ''}
      ${imageField(i, 'heroImageURL', 'Product image', 'No image = no artwork panel on the card.')}
    </fieldset>
    <fieldset><legend>Price</legend>
      ${input(i, { rel: 'priceText', label: 'Price text', limit: LIMITS.priceText, placeholder: 'From $49', help: 'Short free text. The app does not format or convert it.' })}
    </fieldset>
    <fieldset><legend>Offer</legend>
      <label class="switch"><input type="checkbox" data-action="toggle-offer" ${brand.offer ? 'checked' : ''}> Card has an offer</label>
      ${brand.offer ? `
        ${input(i, { rel: 'offer.amountOff', label: 'Amount off (whole US dollars)', kind: 'int', required: true, help: 'Shown as “$N OFF”. Percent and other currencies need an app change.' })}
        ${input(i, { rel: 'offer.eligibleProducts', label: 'Eligible products', limit: LIMITS.offerText, required: true, help: '“Save $N on …”' })}
        ${input(i, { rel: 'offer.code', label: 'Code', limit: LIMITS.offerCode, required: true, help: 'No spaces.' })}
        ${input(i, { rel: 'offer.terms', label: 'Terms', limit: LIMITS.offerText, required: true, multiline: true })}
        ${input(i, { rel: 'offer.disclosure', label: 'Disclosure', limit: LIMITS.offerText, required: true, multiline: true })}
        <div class="row">
          ${input(i, { rel: 'offer.startsAt', label: 'Starts (UTC)', kind: 'datetime' })}
          ${input(i, { rel: 'offer.expiresAt', label: 'Expires (UTC)', kind: 'datetime', help: 'Strongly recommended: offline devices drop an offer only when it expires.' })}
        </div>` : ''}
    </fieldset>`;
}

function sponsorFields(i, brand) {
  const wheels = brand.wheels ?? [];
  const visible = wheels.filter((w) => w.hidden !== true).length;
  return `
    <fieldset><legend>Sponsor links</legend>
      ${input(i, { rel: 'homepageURL', label: 'Homepage (More banner)', kind: 'url', required: true })}
      ${input(i, { rel: 'configuratorURL', label: 'Configurator (ring centre / “Custom Wheels”)', kind: 'url', required: true })}
      ${input(i, { rel: 'footnote', label: 'Footnote pill', limit: LIMITS.footnote })}
      <p class="help">Sponsor cards carry no price, offer, remote logo or product image (contract rule).</p>
    </fieldset>
    <fieldset><legend>Wheels <span class="muted">(${visible} visible of ${wheels.length}; ring only with exactly 9)</span></legend>
      <div class="wheels">
        ${wheels.map((w, k) => `<div class="wheel-row ${w.hidden ? 'is-hidden' : ''}">
          <div class="wheel-head">
            <strong>${k + 1}. ${e(w.displayName || w.id)}</strong>
            ${BUNDLED_WHEEL_IDS.has(w.id) ? '<span class="chip">bundled artwork</span>' : '<span class="chip warn">remote image required</span>'}
            <span class="order-buttons">
              <label class="switch small"><input type="checkbox" data-action="wheel-hidden" data-wheel="${k}" ${w.hidden ? 'checked' : ''}> Hidden</label>
              <button type="button" class="icon" data-action="wheel-move" data-wheel="${k}" data-delta="-1" ${k === 0 ? 'disabled' : ''} aria-label="Move wheel up">↑</button>
              <button type="button" class="icon" data-action="wheel-move" data-wheel="${k}" data-delta="1" ${k === wheels.length - 1 ? 'disabled' : ''} aria-label="Move wheel down">↓</button>
              <button type="button" class="icon danger-quiet" data-action="wheel-remove" data-wheel="${k}" aria-label="Remove wheel">✕</button>
            </span>
          </div>
          <p class="field-error block" data-error-for="${issuePath(i, `wheels.${k}`)}"></p>
          <div class="row">
            ${input(i, { rel: `wheels.${k}.id`, label: 'Wheel ID', required: true, disabled: publishedWheelIds().has(w.id) })}
            ${input(i, { rel: `wheels.${k}.displayName`, label: 'Name', limit: LIMITS.name, required: true })}
          </div>
          ${input(i, { rel: `wheels.${k}.accessibilityName`, label: 'Accessibility name', limit: LIMITS.accessibilityText, required: true })}
          ${input(i, { rel: `wheels.${k}.productURL`, label: 'Product link', kind: 'url', required: true })}
          ${imageField(i, `wheels.${k}.imageURL`, 'Wheel image', 'Square. Required unless the ID has bundled artwork.')}
        </div>`).join('')}
      </div>
      <button type="button" data-action="wheel-add" ${wheels.length >= LIMITS.wheels ? 'disabled' : ''}>+ Add wheel</button>
    </fieldset>`;
}

function publishedWheelIds() {
  return new Set(['staging', 'production'].flatMap((t) => (liveDoc(t)?.brands ?? []).flatMap((b) => (b.wheels ?? []).map((w) => w.id))));
}

/** Inline errors, warnings and counters without re-rendering (keeps focus while typing). */
function refreshInline() {
  const checks = localChecks();
  for (const el of $$('[data-error-for]')) {
    const path = el.dataset.errorFor;
    const isBlock = el.classList.contains('block');
    const mine = checks.errors.filter((x) => x.path === path || (isBlock && x.path === path));
    el.textContent = mine.map((x) => x.message).join(' · ');
    const control = $(`[data-path="${CSS.escape(path)}"]`);
    if (control) control.setAttribute('aria-invalid', mine.length ? 'true' : 'false');
  }
  updateTabBadges(checks);
}

// ---------------------------------------------------------------- side panel
const TABS = [['preview', 'Preview'], ['changes', 'Changes'], ['checks', 'Checks'], ['publish', 'Publish'], ['history', 'History'], ['json', 'JSON']];

function updateTabBadges(checks = localChecks()) {
  const tabs = $('#tabs');
  if (!tabs) return;
  tabs.innerHTML = TABS.map(([key, label]) => {
    const badge = key === 'checks' && checks.errors.length ? ` <span class="badge error">${checks.errors.length}</span>`
      : key === 'changes' && diffCatalogs(liveDoc(S.changesTarget), candidate()).changed ? ' <span class="badge">•</span>' : '';
    return `<button type="button" role="tab" aria-selected="${S.tab === key}" data-action="tab" data-tab="${key}">${label}${badge}</button>`;
  }).join('');
}

let sideTimer = null;
function scheduleSide() {
  clearTimeout(sideTimer);
  sideTimer = setTimeout(() => { if (['preview', 'changes', 'json', 'checks', 'publish'].includes(S.tab)) renderSide(); }, 200);
}

function renderSide() {
  updateTabBadges();
  const side = $('#side');
  if (!side) return;
  const render = { preview: sidePreview, changes: sideChanges, checks: sideChecks, publish: sidePublish, history: sideHistory, json: sideJSON }[S.tab];
  side.innerHTML = render();
  if (S.tab === 'history') loadHistory();
}

function sidePreview() {
  const p = S.preview;
  const source = p.source === 'draft' ? candidate() : liveDoc(p.source);
  const time = p.time ?? nowSeconds();
  const { html, notes } = renderPreview(source, { theme: p.theme, narrow: p.narrow, largeText: p.largeText, nowSeconds: time, isStaging: p.source === 'staging' });
  const opt = (name, value, label) => `<option value="${value}" ${p[name] === value ? 'selected' : ''}>${label}</option>`;
  return `
    <div class="preview-controls">
      <label>Show <select data-action="preview" data-key="source">${opt('source', 'draft', isDirty() ? 'Draft (incl. unsaved)' : 'Draft')}${opt('source', 'production', 'Live · Production')}${opt('source', 'staging', 'Live · Staging')}</select></label>
      <label>Theme <select data-action="preview" data-key="theme">${opt('theme', 'light', 'Light')}${opt('theme', 'dark', 'Dark')}${opt('theme', 'oled', 'OLED')}</select></label>
      <label class="switch"><input type="checkbox" data-action="preview-flag" data-key="narrow" ${p.narrow ? 'checked' : ''}> Narrow (iPhone SE)</label>
      <label class="switch"><input type="checkbox" data-action="preview-flag" data-key="largeText" ${p.largeText ? 'checked' : ''}> Accessibility text size</label>
      <label>Device clock (UTC) <input type="datetime-local" data-action="preview-time" value="${toUTCInput(time)}"></label>
      ${p.time ? '<button type="button" data-action="preview-now">Now</button>' : ''}
    </div>
    ${source ? html : '<p class="muted">Nothing published here yet. Apps show the empty staging state (Staging) or bundled content (Production, before the first publication).</p>'}
    ${notes.map((n) => `<p class="info">${e(n)}</p>`).join('')}
    <div class="info warn small preview-limits"><strong>Preview limits.</strong>
      <ul>
        <li>A web approximation of the <strong>iOS</strong> screens, written from the SwiftUI source (2.4.1 code on the iOS main branch). It is not a screenshot or a build of the app.</li>
        <li>Not reproduced: SF fonts and Dynamic Type metrics, exact spacing, bundled artwork (grey dashed boxes), eFlexFuel/RVP styling, VoiceOver, image download limits and fallback timing, carousel behaviour, and the app's offline/cache and ordering rules.</li>
        <li><strong>Android does not read this catalog yet.</strong> Nothing here represents Android; its future layout would be native Compose and is not designed.</li>
        <li>Remote images load only from the simulated gear storage. Final check: an iOS TestFlight build with Staging selected.</li>
      </ul></div>`;
}

const show = (v) => (v === undefined ? '<span class="muted">—</span>' : typeof v === 'number' && v > 1_000_000_000 ? e(formatTime(v)) : e(typeof v === 'string' ? v : JSON.stringify(v)));

function diffMarkup(diff, { before = 'Before (live)', after = 'After (draft)' } = {}) {
  if (!diff.changed) return '<p class="info ok">No content changes compared with what is live.</p>';
  const rows = diff.entries.filter((x) => x.change !== 'unchanged').map((x) => {
    const tag = { added: 'Added', removed: 'Removed', edited: 'Edited', moved: 'Moved' }[x.change];
    const pos = x.from != null && x.to != null && x.from !== x.to ? ` · position ${x.from + 1} → ${x.to + 1}` : x.to != null && x.change === 'added' ? ` · position ${x.to + 1}` : '';
    const fields = (x.fields ?? []).map((f) => `<tr><th scope="row">${e(f.label)}</th><td class="before">${show(f.before)}</td><td class="after">${show(f.after)}</td></tr>`).join('');
    const wheels = x.wheels ? `<tr><th scope="row">Wheels</th><td colspan="2">${x.wheels.entries.filter((w) => w.change !== 'unchanged').map((w) => `${e(w.change)}: ${e(w.name || w.id)}${(w.fields ?? []).length ? ` (${w.fields.map((f) => e(f.label)).join(', ')})` : ''}`).join('<br>')}${x.wheels.reordered ? '<br>Wheel order changed' : ''}</td></tr>` : '';
    return `<article class="diff-entry ${x.change}">
      <h4><span class="chip ${x.change}">${tag}</span> ${e(x.name || x.id)} <span class="muted small">${e(x.id)}${pos}${x.visibility ? ` · now ${x.visibility}` : ''}${x.affectsMore ? ' · affects More' : ''}</span></h4>
      ${fields || wheels ? `<table class="diff-table"><thead><tr><th>Field</th><th>${e(before)}</th><th>${e(after)}</th></tr></thead><tbody>${fields}${wheels}</tbody></table>` : ''}
    </article>`;
  }).join('');
  return `<p class="summary-line"><strong>${e(summarize(diff))}</strong></p>
    ${diff.reordered ? `<p class="small">Order: ${diff.beforeOrder.map(e).join(' → ')}<br>becomes: ${diff.afterOrder.map(e).join(' → ')}</p>` : ''}
    ${rows}`;
}

function sideChanges() {
  const target = S.changesTarget;
  const live = S.server.live[target];
  const baseline = S.server.baselines?.[target];
  const acknowledged = baseline?.source === 'acknowledged_storage';
  return `
    <div class="preview-controls">
      <label>Compare draft with <select data-action="changes-target">
        <option value="production" ${target === 'production' ? 'selected' : ''}>Live · Production</option>
        <option value="staging" ${target === 'staging' ? 'selected' : ''}>Live · Staging</option></select></label>
      ${isDirty() ? '<span class="pill warn">Includes unsaved edits</span>' : ''}
    </div>
    ${acknowledged
      ? `<p class="info warn small"><strong>Baseline: the acknowledged Storage document</strong> (revision <code>${e(baseline.document.revision)}</code>, ${e(formatTime(baseline.document.publishedAt))}). It replaced the latest recorded publication without going through the publisher and may be on devices, so the next publication is compared with it.</p>`
      : `<p class="muted small">Live ${e(target)}: ${live.head ? `revision <code>${e(live.head.revision)}</code>, published ${e(formatTime(live.head.publishedAt))}` : 'nothing published yet'}.</p>`}
    ${diffMarkup(diffCatalogs(acknowledged ? baseline.document : liveDoc(target), candidate()), acknowledged ? { before: 'Before (Storage)', after: 'After (draft)' } : undefined)}`;
}

function sideChecks() {
  const checks = localChecks();
  const approvals = S.working.meta.approvals ?? {};
  const list = (items, cls) => items.map((x) => `<li class="${cls}"><button type="button" class="link" data-action="jump" data-path="${e(x.path)}">${e(x.message)}</button></li>`).join('');
  return `
    <h3>Contract validation <span class="muted small">(same rules as the apps; re-run on the server at publish)</span></h3>
    ${checks.errors.length ? `<ul class="issues">${list(checks.errors, 'error')}</ul>` : '<p class="info ok">Valid v1 catalog. Devices would accept it.</p>'}
    ${checks.warnings.length ? `<h4>Wording to review</h4><ul class="issues">${list(checks.warnings, 'warning')}</ul>` : ''}
    <p class="small muted">${checks.bytes.toLocaleString()} of ${MAXIMUM_BYTES.toLocaleString()} bytes · ${brands().length}/${LIMITS.brands} cards</p>
    <h3>Partner approvals <span class="muted small">(dashboard only)</span></h3>
    <ul class="plain">${brands().map((b) => `<li>${e(b.name || b.id)}: <span class="chip ${approvals[b.id] === 'approved' ? '' : 'warn'}">${e(approvals[b.id] ?? 'not recorded')}</span>${b.hidden ? ' <span class="muted small">(hidden: not gated)</span>' : ''}</li>`).join('')}</ul>
    <h3>How the apps will treat this draft</h3>
    ${checks.notes.length ? `<ul class="issues">${checks.notes.map((n) => `<li class="${n.level}"><button type="button" class="link" data-action="jump" data-path="${e(n.path)}">${e(n.message)}</button></li>`).join('')}</ul>` : '<p class="muted">Nothing unusual.</p>'}
    <details class="capabilities"><summary>What this admin can and cannot change</summary>
      <h4>Without an app release (data in the v1 contract)</h4>
      <ul>${EDITABLE_WITHOUT_RELEASE.map((x) => `<li>${e(x)}</li>`).join('')}</ul>
      <h4>Needs an iOS release (and, once Android supports the remote catalog, Android work too)</h4>
      <dl>${REQUIRES_APP_RELEASE.map((x) => `<dt>${e(x.area)}</dt><dd>${e(x.detail)}</dd>`).join('')}</dl>
    </details>`;
}

function targetPanel(target) {
  const live = S.server.live[target];
  const review = S.reviews[target];
  const result = S.results[target];
  const dirty = isDirty();
  const production = target === 'production';
  const stagedVersion = S.server.publishedDraftVersions?.staging;
  const isPublisher = role() === 'publisher';
  const mfa = S.aal === 'aal2';
  const storage = S.server.storage?.[target] ?? { state: 'empty' };
  const storageOK = ['in_sync', 'empty', 'repaired'].includes(storage.state) || (storage.state === 'drift' && storage.acknowledged);
  const requirements = [
    [!dirty, 'Draft saved (publishing uses the saved version)'],
    [!!review && review.draftVersion === S.base.version, 'Server checks run for this draft version'],
    [!!review && review.errors.length === 0, 'Server validation, image and approval checks pass'],
    [mfa, 'Simulated MFA (aal2)'],
    [isPublisher, 'Simulated publisher role (the only role that may publish)'],
    [storageOK || storage.state === 'pending', 'Storage matches the latest recorded publication (re-checked under the lock)'],
  ];
  if (production) {
    requirements.push([S.acknowledged, 'I reviewed the before/after summary (single-person approval)']);
    requirements.push([S.confirmText === S.session.productionConfirmation, `Typed ${S.session.productionConfirmation}`]);
  }
  const ready = requirements.every(([ok]) => ok);
  return `<section class="target ${target}" aria-labelledby="t-${target}">
    <h3 id="t-${target}">${production ? 'Production' : 'Staging'} <span class="target-path">recommended-gear/${production ? '' : 'staging/'}catalog-v1.json</span></h3>
    <p class="small">${production ? 'Read by <strong>iOS builds that include remote Recommended Gear</strong> (the 2.4.1 code on the iOS main branch; App Store availability not verified here), within about 2 minutes. <strong>Android does not read this catalog yet.</strong> Withdrawing content needs another publication; deleting the file does not clear devices.'
      : 'Read only by iOS TestFlight, Xcode and Debug installs with <strong>Staging</strong> selected. Never by App Store installs. Not read by Android. Partner-approval gate skipped.'}</p>
    <dl class="kv">
      <dt>Live revision</dt><dd>${live.head ? `<code>${e(live.head.revision)}</code>` : 'nothing published'}</dd>
      <dt>Published</dt><dd>${live.head ? e(formatTime(live.head.publishedAt)) : '—'}</dd>
      <dt>Storage (simulated)</dt><dd>${storageMarkup(target, storage)}</dd>
      ${production ? `<dt>Previewed on Staging</dt><dd>${stagedVersion === S.base.version ? '✓ this draft version is live on Staging' : '<span class="warn-text">Not yet: publish this version to Staging and check it on a TestFlight build first</span>'}</dd>` : ''}
    </dl>
    <button type="button" data-action="review" data-target="${target}" ${dirty ? 'disabled' : ''}>Run server checks</button>
    ${review ? `<div class="review">
      <p><strong>${e(review.summary)}</strong> · ${review.bytes.toLocaleString()} bytes</p>
      ${review.errors.length ? `<ul class="issues">${review.errors.map((x) => `<li class="error">${e(x.message)}</li>`).join('')}</ul>` : '<p class="info ok">Server checks pass.</p>'}
      ${review.warnings.length ? `<ul class="issues">${review.warnings.map((x) => `<li class="warning">${e(x.message)}</li>`).join('')}</ul>` : ''}
    </div>` : ''}
    ${production ? `
      <label class="switch"><input type="checkbox" data-action="ack" ${S.acknowledged ? 'checked' : ''}> I reviewed the before/after summary against live Production</label>
      <label class="confirm">Type <code>${e(S.session.productionConfirmation)}</code> to confirm
        <input type="text" data-action="confirm-text" value="${e(S.confirmText)}" autocomplete="off" spellcheck="false"></label>` : ''}
    <ul class="requirements">${requirements.map(([ok, label]) => `<li class="${ok ? 'ok' : 'todo'}">${ok ? '✓' : '○'} ${e(label)}</li>`).join('')}</ul>
    <button type="button" class="${production ? 'danger' : 'primary'}" data-action="publish" data-target="${target}" ${ready ? '' : 'disabled'}>
      Simulate publish to ${production ? 'Production' : 'Staging'}</button>
    ${result ? `<div class="result ${result.storage === 'verified' ? '' : 'uncertain'}" role="status"><strong>Simulated publication recorded${result.storage === 'verified' ? ' and verified' : ', upload NOT confirmed'}.</strong>
      <dl class="kv"><dt>Revision</dt><dd><code>${e(result.revision)}</code></dd><dt>publishedAt</dt><dd>${e(result.publishedAt)} (${e(formatTime(result.publishedAt))})</dd>
      <dt>SHA-256</dt><dd><code>${e(result.digest.slice(0, 16))}…</code> · ${e(result.bytes)} bytes</dd><dt>Storage</dt><dd>${e(result.storage)}</dd><dt>Read-back</dt><dd>${e(result.readBack)}</dd>
      <dt>Object</dt><dd>${e(result.objectPath)}</dd></dl></div>` : ''}
  </section>`;
}

function storageMarkup(target, storage) {
  const label = {
    in_sync: '✓ origin holds the latest recorded publication', empty: 'nothing published yet', repaired: '✓ repaired by reconcile',
    pending: '⚠ latest recorded publication not confirmed in Storage (crash or uncertain upload)',
    drift: storage.acknowledged ? '⚠ drift acknowledged: the next publication will supersede it' : `✗ DRIFT: ${storage.reason}`,
  }[storage.state] ?? storage.state;
  const actions = [];
  if (storage.state === 'pending') actions.push(`<button type="button" data-action="reconcile" data-target="${target}">Reconcile now</button>`);
  if (storage.state === 'drift' && !storage.acknowledged) {
    actions.push(`<button type="button" data-action="ack-drift" data-target="${target}" data-digest="${e(storage.originDigest)}">Acknowledge drift…</button>`);
  }
  return `<span class="${storage.state === 'drift' && !storage.acknowledged ? 'error-text' : storage.state === 'pending' ? 'warn-text' : ''}">${e(label)}</span> ${actions.join(' ')}`;
}

function sidePublish() {
  return `
    <p class="info"><strong>Simulated.</strong> Publishing runs the proposed server-side flow (reconcile Storage, lock, stamp, validate, record, upload, origin read-back) but writes only to <code>_admin-prototype/.local-state/</code>. Nothing reaches Supabase, a CDN or any device. Sign-in, roles and MFA are simulated. Use <em>Prototype tools</em> to inject crashes, uncertain uploads and writers that bypass the lock.</p>
    ${isDirty() ? '<p class="info warn">You have unsaved edits. Save the draft first: only the saved version can be checked and published.</p>' : ''}
    <div class="targets">${targetPanel('staging')}${targetPanel('production')}</div>`;
}

function sideHistory() {
  const t = S.historyTarget;
  const head = S.server.live[t].head;
  const items = S.history.filter((h) => h.target === t);
  return `
    <div class="preview-controls"><label>Target <select data-action="history-target">
      <option value="production" ${t === 'production' ? 'selected' : ''}>Production</option>
      <option value="staging" ${t === 'staging' ? 'selected' : ''}>Staging</option></select></label>
      <span class="muted small">Append-only (simulated). A rollback is a <strong>new</strong> publication of old content, with a new revision and a newer publishedAt. Storage status is tracked separately: recorded → verified, or uncertain until reconciled.</span></div>
    ${items.length ? `<ol class="history">${items.map((h) => `<li class="${h.revision === head?.revision ? 'live' : ''}">
      <div><strong>${e(formatTime(h.publishedAt))}</strong> ${h.revision === head?.revision ? '<span class="chip ok">latest recorded</span>' : ''} ${h.rollbackOf ? '<span class="chip">rollback</span>' : ''}
        <span class="chip ${h.storageStatus === 'verified' ? '' : 'warn'}">storage: ${e(h.storageStatus)}</span></div>
      <div class="small">${e(h.summary)} · by ${e(h.publishedBy)}${h.draftVersion ? ` · draft v${e(h.draftVersion)}` : ''}</div>
      <div class="small muted"><code>${e(h.revision)}</code> · sha256 <code>${e(h.digest.slice(0, 12))}…</code></div>
      <div class="history-actions">
        <button type="button" data-action="history-view" data-id="${e(h.id)}">View document</button>
        ${h.revision !== head?.revision ? `<button type="button" data-action="history-rollback" data-id="${e(h.id)}" ${role() === 'publisher' ? '' : 'disabled title="Simulated publisher role only"'}>Roll back to this…</button>` : ''}
      </div></li>`).join('')}</ol>` : '<p class="muted">No publications yet.</p>'}`;
}

async function loadHistory() {
  try {
    const { history } = await api(`/api/history?target=${S.historyTarget}`);
    const changed = JSON.stringify(history.map((h) => h.id)) !== JSON.stringify(S.history.filter((h) => h.target === S.historyTarget).map((h) => h.id));
    S.history = history;
    if (changed && S.tab === 'history') $('#side').innerHTML = sideHistory();
  } catch (error) { toast(error.message, 'error'); }
}

function sideJSON() {
  const bytes = encodeCatalog(candidate());
  const text = new TextDecoder().decode(bytes).replace('"set-by-server-at-publish"', '"<set by server at publish>"').replace(/"publishedAt": \d+/, '"publishedAt": <set by server at publish>');
  return `<p class="small muted">The exact document layout the publisher writes. <code>revision</code> (new UUID) and <code>publishedAt</code> (strictly increasing) are stamped by the server, never by the browser. Dashboard-only fields (approvals, notes) are not part of it.</p>
    <p class="small">${bytes.length.toLocaleString()} / ${MAXIMUM_BYTES.toLocaleString()} bytes <button type="button" data-action="copy-json">Copy</button></p>
    <pre class="json" tabindex="0">${e(text)}</pre>`;
}

// ---------------------------------------------------------------- actions
function changed({ editor = false } = {}) {
  renderList();
  if (editor) renderEditor(); else refreshInline();
  scheduleSide();
}

function newBrandId() {
  const ids = new Set(brands().map((b) => b.id));
  let n = 1;
  while (ids.has(`new-brand-${n}`)) n += 1;
  return `new-brand-${n}`;
}

function openDialog(html) {
  const dialog = $('#dialog');
  dialog.innerHTML = html;
  dialog.showModal();
  return dialog;
}
const closeDialog = () => $('#dialog').close();

function toast(message, level = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.textContent = message;
  const region = $('#toasts');
  region.append(el);
  while (region.children.length > 3) region.firstElementChild.remove();
  setTimeout(() => el.remove(), level === 'error' ? 8000 : 4000);
}

async function saveDraft() {
  if (S.saving) return;
  // Send a snapshot. Fields stay editable while the request is in flight; anything typed after
  // this point is NOT in the saved version and must survive the response (PR #7 review).
  const submitted = clone(S.working);
  S.saving = true;
  renderStatus();
  try {
    const { draft } = await api('/api/draft', { method: 'PUT', headers: { 'If-Match': `"v${S.base.version}"` }, body: submitted });
    const editedSince = JSON.stringify(S.working) !== JSON.stringify(submitted);
    S.base = clone(draft);
    S.server.draft = draft;
    S.pendingRemote = null;
    if (!editedSince) S.working = { catalog: clone(draft.catalog), meta: clone(draft.meta) };
    S.reviews = {};
    S.acknowledged = false;
    S.confirmText = '';
    S.saving = false;
    toast(editedSince ? `Draft saved · version ${draft.version}. Edits made while saving are kept and not yet saved.` : `Draft saved · version ${draft.version}`);
    if (editedSince) { renderList(); refreshInline(); scheduleSide(); } else renderAll();
  } catch (error) {
    S.saving = false;
    renderStatus();
    if (error.status === 409) return showConflict(error.data.current);
    toast(error.message, 'error');
  }
}

function showConflict(theirs) {
  const mine = diffCatalogs(S.base.catalog, S.working.catalog);
  const other = diffCatalogs(S.base.catalog, theirs.catalog);
  S.pendingRemote = theirs;
  openDialog(`<h2 id="dialog-title">Someone else saved the draft</h2>
    <p><strong>${e(theirs.updatedBy)}</strong> saved version ${theirs.version} at ${e(new Date(theirs.updatedAt).toLocaleString())}. You started from version ${S.base.version}.</p>
    <h3>Their changes</h3>${diffMarkup(other, { before: `Version ${S.base.version}`, after: `Their version ${theirs.version}` })}
    <h3>Your unsaved changes</h3>${diffMarkup(mine, { before: `Version ${S.base.version}`, after: 'Yours (unsaved)' })}
    <div class="dialog-actions">
      <button type="button" data-action="conflict-theirs">Load their version (discard mine)</button>
      <button type="button" class="danger" data-action="conflict-mine">Save mine over theirs</button>
      <button type="button" data-action="dialog-close">Cancel</button>
    </div>`);
}

async function uploadImage(rel) {
  const brand = current();
  if (!/^[a-z0-9-]{1,64}$/.test(brand.id)) return toast('Give the card a valid ID before uploading images.', 'error');
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/png,image/jpeg';
  picker.addEventListener('change', async () => {
    const file = picker.files?.[0];
    if (!file) return;
    try {
      if (!['image/png', 'image/jpeg'].includes(file.type)) throw new Error('Images must be PNG or JPEG. HEIF/HEIC is disabled until the server can decode it and check its dimensions.');
      if (file.size > 5_000_000) throw new Error(`Image is ${(file.size / 1e6).toFixed(1)} MB; the limit is 5 MB (aim for 400 KB).`);
      const bitmap = await createImageBitmap(file);
      const { width, height } = bitmap;
      bitmap.close();
      if (width > 8192 || height > 8192 || width * height > 40_000_000) throw new Error(`Image is ${width}×${height}; each side must be ≤ 8,192 px and ≤ 40 MP.`);
      if (Math.max(width, height) > 2400) toast(`Image is ${width}×${height}. About 2,000 px on the longest side is plenty.`, 'warn');
      const buffer = await file.arrayBuffer();
      const sha = await sha256Hex(buffer);
      const grant = await api('/api/uploads/sign', { method: 'POST', body: { brandId: brand.id, contentType: file.type, byteLength: buffer.byteLength, sha256: sha } });
      if (!grant.alreadyStored) await api(grant.uploadURL, { method: 'PUT', body: buffer, headers: { 'Content-Type': file.type } });
      setPath(brand, rel, grant.publicURL);
      toast(grant.alreadyStored ? 'Same image already stored; reusing its URL.' : 'Image uploaded to an immutable, content-addressed URL.');
      changed({ editor: true });
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  picker.click();
}

function moveItem(list, from, to) {
  if (to < 0 || to >= list.length) return false;
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
  return true;
}

async function publish(target) {
  const review = S.reviews[target];
  try {
    const result = await api('/api/publish', { method: 'POST', body: {
      target, draftVersion: S.base.version, expectedLiveRevision: review?.live?.revision ?? null,
      confirmation: target === 'production' ? S.confirmText : undefined,
    } });
    S.results[target] = result;
    S.reviews = {};
    S.acknowledged = false;
    S.confirmText = '';
    toast(`Simulated ${target} publication: ${result.summary}`);
    await loadState();
  } catch (error) {
    toast(error.message, 'error');
    if (error.status === 409 || error.status === 500) { S.reviews = {}; await loadState({ keepWorking: true }); }
    else if (error.data?.errors) { S.reviews[target] = { ...review, errors: error.data.errors }; renderSide(); }
  }
}

function rollbackDialog(id) {
  const entry = S.history.find((h) => h.id === id);
  const target = entry.target;
  const doc = JSON.parse(entry.document);
  const diff = diffCatalogs(liveDoc(target), doc);
  openDialog(`<h2 id="dialog-title">Roll back ${e(target)}</h2>
    <p>This publishes the content of <code>${e(entry.revision)}</code> (${e(formatTime(entry.publishedAt))}) as a <strong>new</strong> publication with a new revision and a newer publishedAt, so devices accept it. Partner approvals are checked again for Production.</p>
    ${diffMarkup(diff, { before: 'Live now', after: 'After rollback' })}
    ${target === 'production' ? `<label class="confirm">Type <code>${e(S.session.productionConfirmation)}</code> <input type="text" id="rollback-confirm" autocomplete="off"></label>` : ''}
    <div class="dialog-actions">
      <button type="button" class="${target === 'production' ? 'danger' : 'primary'}" data-action="rollback-go" data-id="${e(id)}">Simulate rollback</button>
      <button type="button" data-action="dialog-close">Cancel</button></div>`);
}

async function rollback(id) {
  const entry = S.history.find((h) => h.id === id);
  try {
    const result = await api('/api/rollback', { method: 'POST', body: {
      target: entry.target, publicationId: id, expectedLiveRevision: S.server.live[entry.target].head?.revision ?? null,
      confirmation: $('#rollback-confirm')?.value,
    } });
    closeDialog();
    toast(`Simulated rollback recorded as revision ${result.revision}`);
    S.results[entry.target] = result;
    await loadState({ keepWorking: isDirty() });
  } catch (error) {
    toast(error.message, 'error');
  }
}

function jumpTo(path) {
  const match = /^brands\[(\d+)\]/.exec(path);
  if (match) {
    S.selected = Number(match[1]);
    renderList();
    renderEditor();
  }
  const el = $(`[data-path="${CSS.escape(path)}"]`) ?? $(`[data-error-for="${CSS.escape(path)}"]`);
  el?.scrollIntoView({ block: 'center' });
  el?.focus?.();
}

// ---------------------------------------------------------------- events
document.addEventListener('click', async (event) => {
  const el = event.target.closest('[data-action]');
  if (!el || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && el.type !== 'button')) return;
  const action = el.dataset.action;
  const brand = S.working ? current() : null;
  switch (action) {
    case 'sign-in':
      S.user = el.dataset.email; safeSession.set('prototype-user', S.user); location.reload(); break;
    case 'select': S.selected = Number(el.dataset.index); renderList(); renderEditor(); break;
    case 'move': {
      const from = Number(el.dataset.index);
      const to = from + Number(el.dataset.delta);
      if (moveItem(brands(), from, to)) { if (S.selected === from) S.selected = to; else if (S.selected === to) S.selected = from; changed(); }
      break;
    }
    case 'add-brand': {
      const id = newBrandId();
      brands().push({ id, kind: 'brand', name: '', tagline: '', description: '', ctaTitle: '', destinationURL: '' });
      S.working.meta.approvals = { ...S.working.meta.approvals, [id]: 'pending' };
      S.selected = brands().length - 1;
      changed({ editor: true });
      $('#f-id')?.focus();
      break;
    }
    case 'remove':
      openDialog(`<h2 id="dialog-title">Remove ${e(brand.name || brand.id)}?</h2>
        <p>Removing deletes the card from the document. <strong>Hidden</strong> keeps it in the document but withdrawn. Either way it disappears from Recommended Gear and More once a publication containing the change reaches devices.</p>
        <div class="dialog-actions"><button type="button" class="danger" data-action="remove-go">Remove card</button><button type="button" data-action="dialog-close">Cancel</button></div>`);
      break;
    case 'remove-go':
      brands().splice(S.selected, 1);
      S.selected = Math.max(0, S.selected - 1);
      closeDialog();
      changed({ editor: true });
      break;
    case 'upload': uploadImage(el.dataset.rel); break;
    case 'clear':
      setPath(brand, el.dataset.rel, undefined);
      if (brand.logo && !brand.logo.url && !brand.logo.darkURL) delete brand.logo;
      changed({ editor: true });
      break;
    case 'wheel-move': {
      const k = Number(el.dataset.wheel);
      if (moveItem(brand.wheels, k, k + Number(el.dataset.delta))) changed({ editor: true });
      break;
    }
    case 'wheel-remove': brand.wheels.splice(Number(el.dataset.wheel), 1); changed({ editor: true }); break;
    case 'wheel-add': {
      brand.wheels = brand.wheels ?? [];
      const ids = new Set(brand.wheels.map((w) => w.id));
      let n = 1;
      while (ids.has(`new-wheel-${n}`)) n += 1;
      brand.wheels.push({ id: `new-wheel-${n}`, displayName: '', accessibilityName: '', productURL: '' });
      changed({ editor: true });
      break;
    }
    case 'save': saveDraft(); break;
    case 'discard':
      S.working = { catalog: clone(S.base.catalog), meta: clone(S.base.meta) };
      S.selected = Math.min(S.selected, Math.max(0, brands().length - 1));
      renderAll();
      break;
    case 'tab': S.tab = el.dataset.tab; renderSide(); break;
    case 'preview-now': S.preview.time = null; renderSide(); break;
    case 'review': {
      const target = el.dataset.target;
      try { S.reviews[target] = await api('/api/review', { method: 'POST', body: { target } }); }
      catch (error) { toast(error.message, 'error'); }
      renderSide();
      break;
    }
    case 'publish': publish(el.dataset.target); break;
    case 'history-view': {
      const entry = S.history.find((h) => h.id === el.dataset.id);
      openDialog(`<h2 id="dialog-title">${e(entry.target)} · ${e(entry.revision)}</h2><pre class="json">${e(entry.document)}</pre>
        <div class="dialog-actions"><button type="button" data-action="dialog-close">Close</button></div>`);
      break;
    }
    case 'history-rollback': rollbackDialog(el.dataset.id); break;
    case 'rollback-go': rollback(el.dataset.id); break;
    case 'copy-json':
      try { await navigator.clipboard.writeText(new TextDecoder().decode(encodeCatalog(candidate()))); toast('Copied (revision and publishedAt are placeholders).'); }
      catch { toast('Clipboard unavailable in this browser context.', 'error'); }
      break;
    case 'jump': jumpTo(el.dataset.path); break;
    case 'dialog-close': closeDialog(); break;
    case 'conflict-theirs':
      S.base = clone(S.pendingRemote);
      S.working = { catalog: clone(S.base.catalog), meta: clone(S.base.meta) };
      closeDialog(); renderAll(); toast(`Loaded version ${S.base.version}.`);
      break;
    case 'conflict-mine':
      S.base = clone(S.pendingRemote);
      closeDialog(); saveDraft();
      break;
    case 'resolve-remote': showConflict(S.pendingRemote); break;
    case 'reconcile':
      try { const r = await api('/api/reconcile', { method: 'POST', body: { target: el.dataset.target } }); toast(`Reconcile (${el.dataset.target}): ${r.state}`); await loadState({ keepWorking: isDirty() }); }
      catch (error) { toast(error.message, 'error'); }
      break;
    case 'ack-drift':
      openDialog(`<h2 id="dialog-title">Acknowledge Storage drift (${e(el.dataset.target)})</h2>
        <p>${e(S.server.storage[el.dataset.target].reason)}.</p>
        <p>The server validates the Storage document first. If it is a valid catalog, devices may already hold it: the next publication must be stamped newer than it and is reviewed against it. If it is invalid, devices ignore it and it is simply superseded. A far-future <code>publishedAt</code> is never accepted here: that is an incident (see the plan). Acknowledging does not skip any check on the next publication. Investigate who wrote it before continuing; Reconcile never overwrites drift by itself.</p>
        <div class="dialog-actions"><button type="button" class="danger" data-action="ack-drift-go" data-target="${e(el.dataset.target)}" data-digest="${e(el.dataset.digest)}">Acknowledge (simulated)</button><button type="button" data-action="dialog-close">Cancel</button></div>`);
      break;
    case 'ack-drift-go':
      try { await api('/api/drift/acknowledge', { method: 'POST', body: { target: el.dataset.target, digest: el.dataset.digest } }); closeDialog(); toast('Drift acknowledged. Publish a new version to supersede it.'); await loadState({ keepWorking: isDirty() }); }
      catch (error) { toast(error.message, 'error'); }
      break;
    case 'dev-fault':
      try { await api('/api/dev/fault', { method: 'POST', body: { target: el.dataset.target, fault: el.dataset.fault } }); toast(`Simulated fault armed for the next ${el.dataset.target} publish: ${el.dataset.fault}`, 'warn'); }
      catch (error) { toast(error.message, 'error'); }
      break;
    case 'dev-external':
      try { await api('/api/dev/external-write', { method: 'POST', body: { target: el.dataset.target, kind: el.dataset.kind } }); toast(`Simulated ${el.dataset.kind} write to ${el.dataset.target} Storage, bypassing the lock.`, 'warn'); await loadState({ keepWorking: isDirty() }); }
      catch (error) { toast(error.message, 'error'); }
      break;
    case 'dev-other-edit':
      try { const { draft } = await api('/api/dev/simulate-other-editor', { method: 'POST', body: {} }); toast(`Simulated: another session saved draft v${draft.version}. Edit something and save to see the conflict.`); }
      catch (error) { toast(error.message, 'error'); }
      break;
    case 'dev-reset':
      if (!confirm('Reset the prototype: draft, simulated publications, history and uploads?')) return;
      try { await api('/api/dev/reset', { method: 'POST', body: {} }); S.results = {}; S.reviews = {}; S.history = []; await loadState(); toast('Prototype data reset to the fictional seed.'); }
      catch (error) { toast(error.message, 'error'); }
      break;
    default: break;
  }
});

document.addEventListener('change', (event) => {
  const el = event.target;
  const action = el.dataset.action;
  const brand = S.working ? current() : null;
  switch (action) {
    case 'switch-user':
      S.user = el.value || null; safeSession.set('prototype-user', S.user); location.reload(); return;
    case 'toggle-mfa':
      S.aal = el.checked ? 'aal2' : 'aal1'; safeSession.set('prototype-aal', S.aal); S.reviews = {}; if (S.server) renderSide(); return;
    case 'toggle-hidden':
      if (el.checked) brand.hidden = true; else delete brand.hidden;
      return changed({ editor: true });
    case 'toggle-more':
      if (el.checked) brand.more = {}; else delete brand.more;
      return changed({ editor: true });
    case 'toggle-offer':
      if (el.checked) brand.offer = { amountOff: 10, eligibleProducts: '', code: '', terms: '', disclosure: '', expiresAt: nowSeconds() + 30 * 86400 };
      else delete brand.offer;
      return changed({ editor: true });
    case 'wheel-hidden': {
      const wheel = brand.wheels[Number(el.dataset.wheel)];
      if (el.checked) wheel.hidden = true; else delete wheel.hidden;
      return changed({ editor: true });
    }
    case 'approval':
      S.working.meta.approvals = { ...S.working.meta.approvals, [brand.id]: el.value };
      return changed();
    case 'preview': S.preview[el.dataset.key] = el.value; return renderSide();
    case 'preview-flag': S.preview[el.dataset.key] = el.checked; return renderSide();
    case 'preview-time': S.preview.time = fromUTCInput(el.value) ?? null; return renderSide();
    case 'changes-target': S.changesTarget = el.value; return renderSide();
    case 'history-target': S.historyTarget = el.value; return renderSide();
    case 'ack': S.acknowledged = el.checked; return renderSide();
    default:
  }
});

document.addEventListener('input', (event) => {
  const el = event.target;
  if (!S.working) return;
  const brand = current();
  if (el.dataset.action === 'confirm-text') {
    S.confirmText = el.value;
    const pos = el.selectionStart;
    renderSide();
    const again = $('[data-action="confirm-text"]');
    again?.focus();
    again?.setSelectionRange(pos, pos);
    return;
  }
  if (el.dataset.action === 'notes') {
    S.working.meta.notes = { ...S.working.meta.notes, [brand.id]: el.value };
    if (!el.value) delete S.working.meta.notes[brand.id];
    return renderStatus();
  }
  if (el.dataset.action === 'edit-id') {
    const previous = brand.id;
    brand.id = el.value;
    for (const key of ['approvals', 'notes']) {
      const map = S.working.meta[key] ?? {};
      if (previous in map) { map[el.value] = map[previous]; delete map[previous]; }
    }
    return changed();
  }
  const rel = el.dataset.bind;
  if (!rel) return;
  let value = el.value;
  switch (el.dataset.kind) {
    case 'int': value = value === '' ? undefined : Number.isFinite(Number(value)) ? Number(value) : value; break;
    case 'datetime': value = fromUTCInput(value); break;
    default:
      if (value.trim() === '' && el.dataset.required !== 'true') value = undefined;
  }
  setPath(brand, rel, value);
  if (brand.logo && !brand.logo.url && !brand.logo.darkURL) delete brand.logo;
  const count = $(`[data-count-for="${CSS.escape(rel)}"]`);
  if (count) {
    const n = charCount(el.value);
    count.textContent = `${n}/${count.dataset.limit}`;
    count.classList.toggle('over', n > Number(count.dataset.limit));
  }
  changed();
});

// Drag-to-reorder (arrows are the keyboard-accessible equivalent).
let dragFrom = null;
document.addEventListener('dragstart', (event) => {
  const item = event.target.closest?.('.brand-item');
  if (!item) return;
  dragFrom = Number(item.dataset.index);
  event.dataTransfer.effectAllowed = 'move';
});
document.addEventListener('dragover', (event) => { if (dragFrom != null && event.target.closest?.('.brand-item')) event.preventDefault(); });
document.addEventListener('drop', (event) => {
  const item = event.target.closest?.('.brand-item');
  if (dragFrom == null || !item) return;
  event.preventDefault();
  const to = Number(item.dataset.index);
  const selectedId = current()?.id;
  if (moveItem(brands(), dragFrom, to)) {
    S.selected = Math.max(0, brands().findIndex((b) => b.id === selectedId));
    changed();
  }
  dragFrom = null;
});

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 's') {
    event.preventDefault();
    if (S.working && isDirty()) saveDraft();
  }
});
window.addEventListener('beforeunload', (event) => {
  if (S.working && isDirty()) { event.preventDefault(); event.returnValue = ''; }
});

boot();
