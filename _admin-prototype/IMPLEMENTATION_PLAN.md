# Recommended Gear Admin: plan for connecting it securely

Status: **plan only.** Nothing here has been migrated, deployed, published or configured. The
prototype in this folder is local, fictional and simulated. Every step below that touches Supabase,
credentials or hosting needs Julian's go-ahead, and none should start until the active credential
migration has landed (see §9).

Inputs, read from `julianf40-hub/E85-Blends-App` `main` at `e6c42ed`:
`docs/remote-gear/{README,PUBLISHING_DASHBOARD,STAGING_SETUP}.md`, `catalog-v1.schema.json`,
`catalog-v1.json`, `tools/remote-gear/{validate_catalog,publish_catalog,make_fixtures}.py` and
tests, `EightyFiveBlends/GearCatalog.swift`, `RecommendedGearView.swift`, `MoreView.swift`, and
`supabase/` (config, functions/_shared). The migration branches `fix/gear-publisher-secret-keys` and
`feature/supabase-publishable-key-migration` were read but not touched.

This plan follows `PUBLISHING_DASHBOARD.md` and adds what the prototype showed is needed:
draft locking, separate staging and production heads, explicit confirmation, a live-revision
check, and the credential model of the migration.

---

## 1. Contract: unchanged

- The admin edits **data inside catalog v1**. It does not change the schema, add fields, or add
  kinds. iOS and Android stay the only renderers. Layout, styling and fixed copy remain native.
- `lib/validator.mjs` is a rule-for-rule port of `validate_catalog.py`. `tools/parity.mjs` runs
  both over 166 documents (seed, staging fixtures, mutations of every rule, URL and Unicode edge
  cases). Result: **0 mismatches**, and the vendored schema is byte-identical. Run it in CI on both
  repositories whenever either validator changes. The Python validator stays the reference, and
  Android ports the same cases.
- The publisher writes `JSON.stringify(doc, null, 2) + "\n"`, the same layout as
  `publish_catalog.encode`. Integers are emitted as integers, so the Python int-vs-float
  distinction (`100.0`) cannot arise in bytes we produce.
- Dashboard-only data lives **next to** the catalog, never inside it: `meta.approvals` and
  `meta.notes` are never part of the published document. Nothing needs stripping.

### What needs app changes (iOS **and** Android), not admin work

| Request | Why the website can't do it |
|---|---|
| New card layout or kind (video, product grid, comparison, banner) | v1 apps skip unknown kinds. Needs SwiftUI + Compose, then an optional v1 field or `catalog-v2.json` published **alongside** v1. |
| A second sponsor, or a sponsor other than the RVP layout | One `rvp_wheels`, reserved id. Needs a new kind. |
| Badge text, "Sponsored by …", empty state, "About Featured Brands", section titles | Fixed app copy. |
| Colors, fonts, per-brand themes, eFlexFuel-style treatment for another brand | Styling is native and keyed by stable ID. |
| Bundled artwork for a new brand or wheel ID | Assets in both apps. Until then use `imageURL` / `logo` / `heroImageURL`. |
| Percent-off, non-USD, multiple offers, offers on the sponsor card | v1 offer is one whole-USD amount on a `brand`. |
| More order different from Recommended Gear, More-only entries | More follows catalog order (sponsor banner, then Featured Brands). |
| Sections, categories, search, targeting by region/vehicle/platform | Every device gets the same document. |
| Rich text, Markdown, HTML, video, animated images | Plain text; PNG/JPEG/HEIF only. |
| Ring with ≠ 9 wheels | Ring is designed for nine; other counts use the grid automatically. |
| Deep links into the app, non-https links | https only; the app scheme is rejected. |
| New click tracking in the apps | App work plus a privacy review. (Query parameters inside an https URL are just data.) |

The editor surfaces these instead of pretending: an unknown kind, an unknown key or a missing dark
logo produces an "app change" or "info" note. A "nine" in the sponsor description with 8 visible
wheels gets a warning, and adding a second sponsor is not offered.

---

## 2. Hosting

- **Not on GitHub Pages / 85blends.app.** Pages is public, and this repository deploys `main` to
  it. The prototype folder starts with `_`, so Jekyll excludes it, but the real admin needs its
  own origin and deploy pipeline.
- Recommended: a static build of `public/` + `lib/` on a separate host at a separate origin
  (e.g. `admin.85blends.app` on Cloudflare Pages/Netlify/Vercel), with `noindex`, the prototype's
  strict CSP (allowing `connect-src` only to the Supabase project), HSTS and no third-party scripts.
  Optional defense in depth: an identity-aware proxy (e.g. Cloudflare Access) restricted to the
  admins' emails, in front of the page.
- The page is not the security boundary. It holds nothing privileged. Every rule is enforced by
  RLS and Edge Functions (§3–§6), so a leaked page or a modified browser gains nothing.
- Where the UI code lives is a decision for Julian (§10). Backend pieces (migrations, functions,
  shared validator copy) belong in `E85-Blends-App/supabase/`, next to the existing functions,
  `_shared/` helpers and migration history.

## 3. Authentication

- Supabase Auth on the existing project, **invite-only**. The apps don't use Supabase Auth, and
  the checked-in `supabase/config.toml` already has `enable_signup = false`. Confirm the live
  project matches before relying on it. Even so, authorization never relies on "is signed in":
  only `gear_admins` membership counts.
- Email magic link (or SSO) **plus mandatory TOTP MFA**. Every write requires `aal2` in the JWT,
  checked in RLS **and** in each function.
- Short sessions (1 h access token, refresh rotation, reauthentication for Production publish if
  the session is older than ~15 min).
- The browser sends the user JWT as `Authorization: Bearer` (no cookies), so classic CSRF does not
  apply. Functions still check `Origin` against the admin origin, as the prototype does.

## 4. Authorization (server-side only)

SQL below is a **draft for review**: not applied, not run anywhere.

```sql
create table public.gear_admins (
  user_id uuid primary key references auth.users on delete cascade,
  role text not null check (role in ('editor', 'publisher')),
  added_by uuid references auth.users, added_at timestamptz not null default now()
);
create or replace function private.gear_role() returns text language sql stable security definer
  set search_path = '' as $$
  select a.role from public.gear_admins a
  where a.user_id = auth.uid() and coalesce(auth.jwt() ->> 'aal', '') = 'aal2' $$;

create table public.gear_catalog_drafts (
  id text primary key default 'main',
  catalog jsonb not null, meta jsonb not null default '{}',
  version integer not null default 1,
  updated_by uuid not null references auth.users, updated_at timestamptz not null default now()
);
create table public.gear_publication_head (
  target text primary key check (target in ('staging', 'production')),
  revision uuid, published_at bigint, digest text
);
create table public.gear_catalog_publications (
  id uuid primary key default gen_random_uuid(),
  target text not null check (target in ('staging', 'production')),
  revision uuid not null unique, published_at bigint not null,
  document text not null, digest text not null,       -- the exact bytes uploaded
  summary text not null, draft_version integer, rollback_of uuid references public.gear_catalog_publications,
  validator_version text not null, published_by uuid not null references auth.users,
  storage_status text not null default 'recorded',    -- recorded | uploaded | verified | conflict | failed
  created_at timestamptz not null default now(),
  unique (target, published_at)
);
create table public.gear_audit_log (id bigserial primary key, at timestamptz not null default now(),
  actor uuid, event text not null, detail jsonb not null default '{}');

alter table public.gear_admins enable row level security;
alter table public.gear_catalog_drafts enable row level security;
alter table public.gear_publication_head enable row level security;
alter table public.gear_catalog_publications enable row level security;
alter table public.gear_audit_log enable row level security;

create policy "admins read own row" on public.gear_admins for select to authenticated using (user_id = auth.uid());
create policy "admins read draft" on public.gear_catalog_drafts for select to authenticated using (private.gear_role() is not null);
create policy "admins read history" on public.gear_catalog_publications for select to authenticated using (private.gear_role() is not null);
create policy "admins read heads" on public.gear_publication_head for select to authenticated using (private.gear_role() is not null);
-- No INSERT/UPDATE/DELETE policies for anon or authenticated on any gear table: drafts are written
-- through the save_gear_draft RPC below; publications, heads and audit rows only by gear-publish.
revoke all on public.gear_admins, public.gear_catalog_drafts, public.gear_publication_head,
  public.gear_catalog_publications, public.gear_audit_log from anon;

create or replace function public.save_gear_draft(expected_version integer, new_catalog jsonb, new_meta jsonb)
returns public.gear_catalog_drafts language plpgsql security definer set search_path = '' as $$
declare result public.gear_catalog_drafts;
begin
  if private.gear_role() is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if octet_length(new_catalog::text) > 2000000 then raise exception 'too large'; end if;
  update public.gear_catalog_drafts
     set catalog = jsonb_build_object('schemaVersion', 1, 'brands', new_catalog -> 'brands'),
         meta = new_meta, version = version + 1, updated_by = auth.uid(), updated_at = now()
   where id = 'main' and version = expected_version
  returning * into result;
  if not found then raise exception 'draft_conflict' using errcode = '40001'; end if;  -- → HTTP 409
  insert into public.gear_audit_log(actor, event, detail) values (auth.uid(), 'draft_save', jsonb_build_object('version', result.version));
  return result;
end $$;
revoke all on function public.save_gear_draft from public, anon;
grant execute on function public.save_gear_draft to authenticated;
```

| Action | editor | publisher | Enforced by |
|---|---|---|---|
| Read draft, history, heads | ✓ (aal2) | ✓ (aal2) | RLS |
| Save draft | ✓ | ✓ | `save_gear_draft` (role + aal2 + version) |
| Upload image | ✓ | ✓ | `gear-upload-url` |
| Publish to **Staging** | ✓ | ✓ | `gear-publish` |
| Publish / roll back **Production** | — | ✓ + typed confirmation (+ optional second publisher) | `gear-publish` |
| Manage admins | — | owner via SQL / dashboard only | no API at all |

Storage bucket `recommended-gear` stays as `STAGING_SETUP.md` describes: public read, **no**
INSERT/UPDATE/DELETE policies for `anon` or `authenticated`.

## 5. Credentials

| Where | Holds | Never holds |
|---|---|---|
| Browser (admin page) | Project URL + **publishable key** (`sb_publishable_…`, public by design, for Supabase Auth), the user's own session JWT | secret keys, service-role JWT, DB URL |
| `gear-publish`, `gear-upload-url` Edge Functions | A **dedicated secret key** for the publisher (e.g. secret `GEAR_PUBLISHER_SECRET_KEY` = `sb_secret_…`), sent only as the `apikey` header for Storage writes (the convention on `fix/gear-publisher-secret-keys`); `SUPABASE_DB_URL` for the publish transaction | anything returned to the browser or logged |
| Apps | Publishable key, public catalog URL (catalog reads send **no** key) | any write path |
| Repositories / CI | nothing secret; secret scanning on | keys of any kind |

- A dedicated secret key, rather than the project-wide legacy service-role JWT, can be revoked on
  its own if exposed. **Do not create or rotate keys as part of this work.** Do it after the
  credential migration lands, following the same procedure.
- Functions redact the key from any error text, as `publish_catalog.py` does, and log no request
  headers.
- `tests/security.test.mjs` already fails on key-shaped strings, `supabase.co` references in
  browser code, or any network client in the prototype server. Keep equivalent checks in the real
  build.

## 6. Edge Functions

The prototype's `server.mjs` is the executable spec: each endpoint maps 1:1.

| Prototype | Real | Notes |
|---|---|---|
| `PUT /api/draft` + `If-Match` | `rpc('save_gear_draft', {expected_version, …})` | 0 rows → 409 with the current draft |
| `POST /api/review` | `gear-publish` with `dryRun: true` | Validation, images, approvals, diff; no writes |
| `POST /api/publish` | `gear-publish` | Below |
| `POST /api/rollback` | `gear-publish` with `{ rollbackOf }` | Same path, old document as input |
| `POST /api/uploads/sign` + `PUT` | `gear-upload-url` → `createSignedUploadUrl(path, { upsert: false })`, then `gear-upload-finalize` | Finalize sniffs type, reads dimensions, deletes the object if invalid |

`gear-publish` (verify_jwt **on**; `Origin` check; role + aal2 from `gear_admins`):

1. Load the draft (or the rollback source). Refuse if `draftVersion` ≠ the current version: the
   publisher must have reviewed exactly what is published.
2. `BEGIN` on `SUPABASE_DB_URL`. `SELECT … FROM gear_publication_head WHERE target = $1 FOR UPDATE`
   serializes publishes per target.
3. Refuse if `expectedLiveRevision` ≠ head revision (someone else published since the review).
   Refuse if head `published_at` > now + 300 s (clock guard, as `publish_catalog.py`).
4. Production only: refuse unless every visible card's approval is `approved` and
   `confirmation = 'PUBLISH PRODUCTION'`. Optionally require a second publisher's approval row.
5. Stamp `revision = gen_random_uuid()` and `publishedAt = max(floor(now), head + 1)`. Encode the
   bytes. Run `parseBytes` + `checkSuccessor` against the head bytes and every revision in history.
6. Check images: every referenced URL must be on the gear storage host and exist (HEAD 200,
   `image/*`). For Staging, other hosts are warnings. For Production they are errors.
7. `INSERT` the publication (exact bytes, digest, summary, validator version), update the head,
   write audit, `COMMIT`.
8. Upload with `Content-Type: application/json`, `Cache-Control: max-age=60`, `x-upsert: true`.
   Retries resend the **identical** bytes (devices treat a re-upload as "unchanged").
9. Read back the authenticated origin with the retry/budget logic from
   `fix/gear-publisher-secret-keys`, then the public URL. Record
   `uploaded`/`verified`/`conflict`/`failed`. Return the same outcome classes as the CLI
   (published, CDN lagging, conflict, unverified, unknown).

Reuse `lib/validator.mjs`, `lib/diff.mjs` and `lib/images.mjs` unchanged. They are
dependency-free ES modules that run in Deno. Keep the parity test in CI.

**One publisher path per target.** Once the dashboard can publish to Staging, retire
`--upload` in `publish_catalog.py`, or have it call `gear-publish`. Otherwise the CLI bypasses the
database lock, and two writers can overwrite each other, which is the limitation its own docstring
describes.

## 7. Concurrent edits and history

- **Drafts:** one shared draft with an integer `version` (optimistic lock). A conflicting save
  gets 409 plus the current draft. The UI shows *their* changes and *yours*, with "Load theirs"
  and "Save mine over theirs". Merging is deliberately not offered. Production can add Supabase
  Realtime presence ("Alex is editing") so conflicts rarely happen. The prototype polls every 10 s.
- **Publishing:** row lock per target, plus `expectedLiveRevision` and `draftVersion`
  preconditions. The prototype's tests show that two simultaneous publishes give one success and
  one 409, and that same-second publishes get t and t + 1.
- **Staging and Production are independent:** separate heads, histories, objects and ordering.
  The Production panel shows whether this exact draft version is live on Staging, and warns if not.
- **History:** append-only (no UPDATE/DELETE policy). Each row holds the exact bytes and digest,
  author, time, summary, the draft version it came from, and `rollback_of`. Rollback = a new
  publication of old content: new revision, newer `publishedAt`, approvals re-checked. Retain
  indefinitely (documents are small).
- **Images:** content-addressed (`images/<brand>/<sha256>.<ext>`), never overwritten. Unreferenced
  uploads are kept until a periodic report lists ones older than 30 days and unreferenced by any
  publication. Deletion stays manual.

## 8. Findings from this inspection

1. **The iOS seed's `publishedAt` is in the future.** `docs/remote-gear/catalog-v1.json` has
   `publishedAt: 1794960000` = 2026-11-18T00:00Z (today is 2026-11-13). If that file is uploaded
   unchanged as the first Production publication, `publish_catalog.py` (and `gear-publish`)
   refuse every later publish until about Nov 18 ("live is more than 5 minutes in the future").
   Devices that accepted it also reject anything stamped earlier. **Restamp it when publishing**
   (the publisher does this; a manual upload doesn't). The prototype's own seed uses a past time.
2. The dashboard proposal says "public sign-ups disabled", but that is a project-wide Auth setting.
   It is safe today because the apps don't use Supabase Auth. If the apps adopt Supabase Auth later,
   the `gear_admins` check (not sign-up settings) must remain the boundary, which this design
   already assumes.
3. Concurrent staging publishing via the CLI is unprotected (documented in the tool). See §6, "one
   publisher path".
4. HEIC/HEIF pixel dimensions can't be read without a decoder in the browser or the prototype. The
   finalize function needs a real decoder, or HEIF should be disallowed in the admin until it has one.
5. Smart CDN behavior for this plan is still unverified (open item in the iOS docs). Until it is,
   expect about 2 minutes from publish to device.

## 9. Isolation from the credential migration

- This work touched **only** `_admin-prototype/` in the website repository, on
  `claude/85blends-admin-gear-prototype-9v827z`. No Supabase project, bucket, key, Auth setting,
  migration, function or catalog was read with credentials or changed. The iOS repository was only
  cloned read-only.
- Sequence: (a) the migration PRs merge and keys are rotated per their own plan → (b) review the §4
  SQL as a migration in `E85-Blends-App/supabase/migrations/` → (c) apply it to a **Supabase branch
  or staging project** only → (d) create the dedicated publisher secret key there.

## 10. Rollout (each step needs Julian's go-ahead)

| Phase | Work | Exit gate |
|---|---|---|
| 0 (this) | Local prototype, fictional data, simulated publishing | Review UI and plan |
| 1 | Migration + RLS for review; `save_gear_draft`; tests with `supabase test db` | Replays clean on an empty DB; advisors clean; anon/authenticated non-admin writes fail |
| 2 | `gear-publish`, `gear-upload-url`/`finalize` on a **Supabase branch**; Deno tests incl. validator parity and the server tests ported | Concurrent publish test, rollback, clock guard, image checks pass on the branch |
| 3 | Host admin privately; connect to the branch; then Staging only on the live project | Staging publication shows on a TestFlight build (STAGING_SETUP §5 checklist) |
| 4 | Enable Production publishing (first publication = restamped seed; §8.1) | Rollback rehearsed on Staging; two publishers named; MFA enforced |
| 5 | Android client implements the same contract | Android ports validator cases; bundled-ID mapping created |

## 11. Decisions for Julian

1. Where the admin UI lives: a new private repo (recommended, to keep it out of the public site's
   repo and Pages), or this repository with a separate deploy.
2. Hosting provider and domain for the admin; whether to add an identity-aware proxy.
3. First editors/publishers, and whether Production needs two-person approval.
4. Whether editors may publish to Staging (the prototype allows it; the proposal implied publishers only).
5. Whether to allow HEIF uploads before server-side dimension checks exist (§8.4).
6. Retention for unreferenced images.

## 12. Verification run in this session

- `node --test _admin-prototype/tests/*.test.mjs`: validator cases ported from Python, model,
  server rules (auth, MFA, Origin, If-Match, roles, approval gate, stale review, invalid content,
  serialized publish, rollback, append-only history, clock guard, uploads, security headers, path
  containment) and static security checks.
- `node _admin-prototype/tools/parity.mjs <E85-Blends-App>`: 166 documents, 0 mismatches.
- Headless Chromium walkthrough: edit with inline errors, changes summary, conflict dialog,
  staging publish, production gate, approval, production publish, rollback, sponsor ring in dark
  mode, MFA-off refusal, and a 390 px layout with no horizontal scroll.
- Not run: anything against Supabase, Deno, a real CDN, or the apps.
