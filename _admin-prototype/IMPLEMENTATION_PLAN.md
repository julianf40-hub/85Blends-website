# Recommended Gear Admin: plan for connecting it securely

Status: **plan only.** Nothing here has been migrated, deployed, published or configured. The
prototype in this folder is local, uses fictional data, and simulates sign-in, roles, MFA and publishing.
**The live implementation is planned for a new private repository, `85Blends-Admin`**. It has not
been created, and nothing has been moved. Every step that touches Supabase, Cloudflare, DNS,
credentials or another repository needs Julian's go-ahead. Requirements are split into three
tiers: prototype review, backend staging, production launch (§12).

Read-only inputs: `julianf40-hub/E85-Blends-App` `main` at `e6c42ed` (`docs/remote-gear/*`,
`tools/remote-gear/*`, `EightyFiveBlends/GearCatalog.swift`, `RecommendedGearView.swift`,
`MoreView.swift`, `supabase/config.toml`, `supabase/functions/_shared`), plus the branches
`fix/gear-publisher-secret-keys` and `feature/supabase-publishable-key-migration` (not changed),
public DNS (§9), and the Cloudflare and Supabase documentation cited inline (read 2026-11-13).
**The Android repository was not inspected.**

---

## 0. Operating model (confirmed by Julian, 2026-11-13)

Julian has also accepted the **local-first implementation direction**: the backend is built and
tested against a local Supabase stack with fictional data before any hosted environment (§12 B).

| Rule | Real enforcement (§4) | Prototype |
|---|---|---|
| **Julian is the only publisher** | A DB unique index allows one publisher row; the function checks a pinned publisher ID; a DB trigger rejects publications by anyone else | One simulated publisher |
| **Real MFA required** | TOTP. `aal2` is checked by the function after verifying the session with Auth, and by RLS. Production also needs a TOTP verification ≤ 15 min old | A simulated `aal2` toggle |
| **Publisher-only Staging and Production** | `gear-publish` for every target, rollback, reconcile and drift acknowledgement | Enforced; the optional editor can only draft |
| **No second approver** | One person: passing checks, recorded partner approvals, a reviewed summary and the typed confirmation | Enforced |

## 1. Platform scope and the catalog contract (unchanged; iOS and future Android)

- The admin only produces **catalog v1** documents. It changes no schema, fields or kinds, so the
  contract stays platform-neutral. `lib/validator.mjs` is a rule-for-rule port of
  `validate_catalog.py`: 166 / 166 documents agree (`tools/parity.mjs`), and the schema is
  byte-identical. Dashboard-only data (partner approvals, notes) is never published.
- **iOS:** the remote-catalog client is the 2.4.1 code on iOS `main`. Its README says it is not
  release ready, and App Store availability was not verified. The admin preview is a web
  approximation of those SwiftUI screens, not a build.
- **Android does not read this catalog yet.** This does **not** block an iOS-only launch. Before
  Android is **enabled** to read the catalog, its reader must implement the **same acceptance
  rules** as iOS (port the validator test cases), including rejecting documents that fail
  validation and the `publishedAt` ordering rules. Several admin decisions rely on that, notably
  §6 "fails validation → no timestamp floor". If Android ever accepted something iOS rejects,
  that decision would have to be revisited.
- Image uploads are **PNG/JPEG only**. HEIF/HEIC is disabled until server-side decoding and
  dimension checks exist. The contract and apps still accept HEIF URLs; only the admin restricts uploads.

## 2. Target architecture: Cloudflare Pages frontend, Supabase backend

```
Browser (Julian)
  │  Cloudflare Access (defense in depth, not the security boundary)
  ▼
Cloudflare Pages: static files from private 85Blends-Admin (public/, lib/, config.js, _headers)
  │  supabase-js with the publishable key: Auth (magic link + TOTP), PostgREST under RLS, Functions
  ▼
Supabase project (the existing one; it holds the recommended-gear bucket the apps read)
  Auth · Postgres (gear_* tables, RLS, triggers) · Edge Functions (gear-*) · Storage
```

`server.mjs` is the executable spec, and each route maps to one backend piece:

| Prototype | Real backend |
|---|---|
| Simulated identity headers | Supabase Auth session JWT, verified server-side (§4) |
| `GET /api/state` | RLS selects, plus `gear-state` (Storage inspection, review baseline) |
| `PUT /api/draft` + `If-Match` | `rpc('save_gear_draft')` |
| `/api/review`, `/publish`, `/rollback`, `/reconcile`, `/drift/acknowledge` | `gear-publish` actions |
| Upload sign + PUT | `gear-upload-url` (signed upload, `upsert: false`), then `gear-upload-finalize` |
| `*.jsonl` logs, local object files | `gear_*` tables and the `recommended-gear` bucket |
| `/api/dev/*` fault injection | Not deployed. Equivalent fault tests run in the backend staging tier (§12) |

**Code locations:**
- `85Blends-Admin`: the frontend, `lib/` and the function source.
- `E85-Blends-App/supabase/migrations/`: the SQL migrations, which keep the single, reconstructed
  migration history of the live project.

### Cloudflare Pages and Access: verified against Cloudflare's documentation

- Pages' **"Enable access policy"** setting protects **preview deployments only**. Cloudflare's
  docs say this "will only protect your preview deployments" and "not your `*.pages.dev`
  domain or custom domain" ([preview deployments](https://developers.cloudflare.com/pages/configuration/preview-deployments/)).
- Protecting the **production `<project>.pages.dev`** is a documented procedure
  ([known issues: "Enable Access on your `*.pages.dev` domain"](https://developers.cloudflare.com/pages/platform/known-issues/)):
  1. enable the policy;
  2. edit the generated Access application and **delete the `*` subdomain** (it now protects
     `<project>.pages.dev`);
  3. re-enable the policy, which yields **two applications**: `<project>.pages.dev` and
     `*.<project>.pages.dev`.
- **Aliases:** Access wildcards match **exactly one subdomain level**; `*.example.com` covers
  `alpha.example.com` but not `example.com` or `foo.bar.example.com`
  ([application paths](https://developers.cloudflare.com/cloudflare-one/policies/access/app-paths/)).
  Deployment hashes (`<hash>.<project>.pages.dev`) and branch aliases (`<branch>.<project>.pages.dev`)
  are one level below the project, so the wildcard application matches them by Cloudflare's own
  rule. The Pages docs never name branch aliases explicitly, so coverage of every alias is a
  **verification step**, not an assumption.
- **Custom domain:** the same page says a custom domain needs its own Access application, or the
  login "will render but not work". Not proposed (§9).

**Proposed arrangement:** the production `<project>.pages.dev` plus `*.<project>.pages.dev`
(two applications, per the documented procedure). **Required verification before use:** without
signing in, request the production URL, a deployment-hash URL and a branch-alias URL; each must
redirect to Access. Repeat after every new branch. To reduce the alias surface further, use a
**single production branch with no preview branches** (direct upload of production only), so the
only aliases are deployment hashes.

**If verification fails:** hold the frontend deployment. Fallbacks:
- keep using the admin locally (static files on `127.0.0.1`) against the backend staging tier; or
- add a custom hostname with its own Access application. That requires a DNS change (Julian's call).

In every case, security does not depend on Access: Supabase Auth, MFA and RLS are the boundary
(§4), and the page holds only public configuration.

**Deploying to Pages**, one of:
- (a) Cloudflare's GitHub integration, granted access to the one private repo; or
- (b) a GitHub Actions direct upload with a Pages-only Cloudflare API token.

Both create a new integration or credential, so neither happens until the production-launch tier.

## 3. Authentication

- Supabase Auth, invite-only (`enable_signup = false` in the checked-in config; confirm on the
  live project), magic link plus **mandatory TOTP**. The apps don't use Supabase Auth.
- RLS returns nothing below `aal2`. Production requires a TOTP verification ≤ 15 minutes old.
- MFA on Julian's Supabase **dashboard/organization** account too, because the dashboard is a
  privileged bypass (§6).

## 4. Backend authorization that does not trust the UI (implemented locally; not applied anywhere hosted)

Implemented and tested in the local backend (`_admin-prototype/backend/` on branch
`claude/admin-backend-local`):

1. **Gateway:** `verify_jwt = true` for `gear-publish`.
2. **Function:** checks the session with Auth (`GET /auth/v1/user`, so revoked or signed-out
   sessions fail), then requires all of:
   - `aal2`;
   - for Production, a TOTP `amr` entry within the step-up window;
   - the `publisher` role in `gear_admins`;
   - `sub` equal to the pinned `GEAR_PUBLISHER_USER_ID`.

   Roles never come from user-editable metadata.
3. **Database:** row-level security on every table, a single-publisher unique index, a publication
   guard trigger, append-only triggers, and Storage RLS on the catalog objects (§6).

### MFA: what the database verifies itself vs evidence supplied by the function

| Guarantee | Verified independently by the database? | How |
|---|---|---|
| Reading admin data and saving drafts requires `aal2` | **Yes** | PostgREST verifies the JWT signature; RLS and `save_gear_draft` read `aal` from `auth.jwt()` |
| A catalog object in Storage can only be written by the publisher with `aal2` | **Yes** | The Storage API verifies the caller's JWT; the `storage.objects` RLS policy calls `private.gear_role()` in Storage's pre-upload permission check (a rolled-back dry run, see §6), plus a single-use write grant bound to that user |
| Production object writes need a TOTP verification within the step-up window | **Yes** | The same policy checks the `amr` TOTP timestamp against `gear_settings.production_step_up_seconds` |
| The session has not been revoked or signed out | **No** (function only) | PostgREST and Storage check the signature and expiry, not session revocation. Only the function's Auth check sees a sign-out, so a revoked token stays valid at the database until it expires (keep JWT expiry short) |
| The caller is the pinned publisher ID | **Partly** | The function checks the pinned ID. The database independently allows only one publisher row and checks that role |
| The publication row's `auth_aal` / `auth_amr` | **No** (evidence) | Written by the function with the service role. The guard trigger checks the supplied `auth_aal = 'aal2'` but cannot verify it. The Storage write that publishes the bytes is the independently verified step |
| The publication row's `published_by` is the publisher | **Partly** | The trigger checks that the supplied `published_by` holds the publisher role; the value itself comes from the function |

## 5. Credentials: actual permissions, not intended ones

| Credential | What it can actually do (per Supabase docs) | Where it lives |
|---|---|---|
| Publishable key | Public; acts as anon; subject to RLS | Admin page, apps |
| User session JWT | That user's RLS permissions | Browser, short-lived |
| **Any secret key (`sb_secret_…`)**, including a "dedicated publisher" key | Uses the `service_role` Postgres role, **bypasses every RLS policy**, and has "full access to your project's data": **all tables and all Storage buckets in the project**. The docs describe **no** way to scope a secret key to a table, bucket or function ([API keys](https://supabase.com/docs/guides/api/api-keys)) | Edge Function secrets |
| Function secrets (e.g. a `GEAR_PUBLISHER_SECRET_KEY`) | Set at **project level**, readable by **every** Edge Function in the project; the docs describe no per-function scoping ([function secrets](https://supabase.com/docs/guides/functions/secrets)) | Project secrets |
| Default function env | `SUPABASE_SECRET_KEYS`, `SUPABASE_SERVICE_ROLE_KEY` (legacy) and `SUPABASE_DB_URL` are available to **every** function by default (same page) | Injected by Supabase |

So a separate publisher key is **not** restricted to `gear-publish` or to `recommended-gear`. What
it does give:
- **separate rotation:** it can be rotated or deleted without touching other components, as
  Supabase recommends ("a separate secret key for each backend component");
- **clearer attribution**, where logs record which key was used. Verify this in the backend
  staging tier; don't assume it.

The other functions in the project (price alerts, promo, referral, RevenueCat) already receive
equally powerful defaults. The real containment is therefore:
- the bucket has no write policies;
- every function's code is reviewed, with a CI check that only `gear-*` touches `recommended-gear`;
- the verifier (§6) watches Storage;
- **keys are minimized and revocation is verified** (§12, production launch).

If stronger isolation is ever required, the options are a separate Supabase project for the
catalog (the apps read `SUPABASE_URL`, so that is an iOS change, and future Android work) and
signed catalogs (also an app change). Signatures **authenticate** content; they do **not** stop an
older, validly signed publication from overwriting a newer object (§6.1).

## 6. Publishing across the database and Storage

> **Superseded by §6.2 (decision D10, option 2, 2026-11-14).** The current design publishes through
> one database transaction and a read-only endpoint; nothing writes the catalog to Storage. The text
> below and §6.1 describe the earlier Storage path and the blocker that ruled it out. That path is
> kept only as local experimental evidence (`backend/supabase/experimental/legacy-storage-path/`,
> `backend/supabase/functions/gear-legacy-storage-demo/`, `backend/tests/legacy-storage/`) and is
> excluded from the migration and deployment path.

A database lock or fencing token alone does **not** stop a stale process from overwriting Storage.
The local backend shows this with a negative control. When uploads used the service key (which
bypasses Storage RLS):
- a publisher paused past its lease overwrote the newer publication in Storage;
- the database correctly refused its status update, but too late.

The implemented design:

1. **Lease with a fencing token** on the head row (`gear_acquire_lease`). A crashed process's lease
   expires. Every database write (record, status, acknowledgement) must present the live token.
2. **Capture the object version first** (`gear_prepare_write`), then read the authenticated
   origin (never the CDN) and classify it.
3. **Storage enforces fencing and compare-and-swap when an upload starts.** The function uploads
   with the **publisher's own verified JWT**, not a service key. Under the lease it issues a
   **single-use write grant** (`private.gear_write_grants`) bound to the target, the object path,
   the prepared publication, the publisher's user ID and the declared byte size, and puts only the
   grant's nonce in the object's user metadata. The lease token itself is never readable by
   clients (column grants hide it). `storage.objects` RLS requires:
   - publisher plus `aal2`;
   - a live grant for this exact path, issued to this user, with the declared `contentLength`
     equal to the granted size, under the live, unexpired lease;
   - for an update, the existing object version equal to the version captured in step 2;
   - for Production, a recent TOTP.

   The grant is consumed after every attempt. A rejected upload leaves the served object unchanged.

   **Correction (bypass review at `f7d2a3c`):** an earlier version of this plan said RLS is
   "evaluated when Storage commits the object row". It is not. The Storage API (`storage-api`
   v1.72.1 locally) runs RLS in `canUpload()` as a **rolled-back dry run before the bytes arrive**,
   seeing only the declared metadata (`mimetype`, `contentLength`); the final row is then written
   as a superuser without RLS. So:
   - **RLS cannot bind content.** It binds who, where, when, which lease/publication and the
     declared size, not the bytes;
   - the fencing and compare-and-swap checks are **check-then-act**: they hold when an upload
     starts, not when it commits. **This is a blocker, not a bounded window** (§6.1): the
     publication-safety review reproduced a publisher overwriting a newer verified publication
     after its lease expired, and two simultaneous requests both using one grant. The function's
     lease-margin check only stops it *starting* late; it cannot stop a started upload from
     committing late, and it is not a protection.

   Also found at `f7d2a3c` and fixed: the publisher could read `lease_token` over REST and upload
   arbitrary bytes directly. Now the token is hidden, writes need a grant, and expired, released,
   replayed, cross-environment, cross-path, wrong-size, wrong-user and role-changed grants are
   refused (backend `tests/bypass.test.mjs`, B1–B9).

   **Still enforced only by the function** without the candidate commit guard (§6.1); with it,
   size, content and ordering are re-checked at commit (B9 now refused locally):
   full v1 validation, the successor and ordering checks, partner approvals, image checks,
   byte-equality with the recorded publication, the Production confirmation and review digest,
   and session revocation.
### 6.1 Publication-safety review at `ba3cfab` (local; blocker found; candidate fix)

Reproduced exactly as requested (`backend/tests/publication_safety.test.mjs`; evidence in the
backend README):

| # | Scenario | Without a commit-time check | With the candidate commit guard |
|---|---|---|---|
| PS1a | A pauses mid-body, lease expires, B reconciles, publishes and verifies, A resumes; **through the local gateway** | Safe, **but only because local Kong buffers the whole body**, so Storage authorizes after the pause (A refused at authorization) | Safe |
| PS1b | Same, with Storage receiving a streamed body (authorized on the headers, as Storage itself does) | **Unsafe:** Storage serves A's **older** document while the head says B. A's function returns `lease_lost`, which does not tell its operator that A's bytes landed. Detected as drift afterwards | **Safe:** A refused at commit; Storage serves B; `in_sync` |
| PS2 | Two simultaneous requests with one grant | **Both succeed** (via the gateway and direct). Consumption ran only afterwards, in the function; nothing persists in the rolled-back dry run | **Exactly one succeeds** (10 alternating rounds plus 2 single runs); the grant is deleted in the committing transaction |

**Blocker:** Storage authorizes before the body and commits as a superuser with no RLS and no
version condition (`storage-api` `Uploader.completeUpload`: `upsertObject`, `ON CONFLICT DO
UPDATE`). A lease, fencing token, RLS policy or timing margin checked *before* the body cannot
order commits. Whether hosted Storage authorizes on the headers depends on whether the hosted
gateway streams request bodies; local Kong buffers. That must not be relied on either way.

**Alternatives (none is a timing margin):**
1. **Commit-time guard trigger on `storage.objects`** (candidate, implemented locally:
   `migrations/20261113220000_gear_commit_guard.sql`). It is a BEFORE INSERT/UPDATE trigger, so
   it runs inside Storage's committing transaction (superuser writes do not bypass triggers),
   under Storage's per-object lock. It consumes the grant atomically (`DELETE … RETURNING`) and
   re-checks the live lease, the uploader, compare-and-swap against the prepared version, the
   **stored** size, and the stored eTag against the MD5 of the recorded publication. It decides
   on the proposed row in the INSERT phase, because an overwrite that omits `user_metadata`
   keeps the old row's value. Key-holder writes (no grant nonce) are not blocked: they remain
   detected drift. **Depends on hosted facts not yet verified:**
   - that a project can create, replace and remove such a trigger (`storage.objects` is owned by
     `supabase_storage_admin`; locally `postgres` holds TRIGGER but cannot disable it);
   - that hosted Storage still writes through this upsert path;
   - that the hosted eTag is the MD5 of the bytes (not true for S3 multipart or some encryption
     modes);
   - that TUS and S3-protocol uploads reach the same trigger (they write the same table, but this
     is untested).

   It also couples correctness to Storage internals, which can change between versions.
2. **The database is the source of truth for "latest":** apps read the latest verified
   publication from the database (an Edge Function or a PostgREST RPC, cacheable). Storage keeps
   immutable, content-addressed publication files that are never overwritten (insert-only,
   which is already enforced for images). Commit order is then a database transaction. This is
   an app change (iOS, and future Android) and a caching design.
3. **Immutable per-revision objects plus a small pointer object.** This only moves the
   overwrite problem to the pointer, unless the pointer is guarded by 1 or served by 2.
4. **Signed catalogs plus monotonic acceptance on clients.** Signatures authenticate content
   but **do not** stop an older valid signed publication from overwriting a newer object.
   Clients that already hold the newer document reject the older one by `publishedAt` (the
   existing v1 rule), but new installs and cold caches accept it. This limits device impact
   only; the served bytes are still wrong.

**Decided (2026-11-14): option 2**, implemented locally in §6.2. The commit-guard trigger (option 1)
remains experimental evidence only and is not in the migration path.

### 6.2 Current design: the database is the publication channel (D10, option 2; local)

**Write path:** one application-owned database transaction.
1. The admin reviews (`review`): the server returns a `reviewDigest`. It covers the target, the
   draft version or rollback source, the current publication (id and digest) as the baseline,
   the candidate brands, and (Production) the approvals.
2. Publish sends that digest and an `operationId` (a UUID the client keeps for retries).
   `gear-publish` then:
   - checks the caller (Auth session, aal2, publisher, pinned ID, Production step-up);
   - recomputes the review (any difference → `review_stale`);
   - stamps `publishedAt = max(now, current + 1)` (±300 s guard), validates and successor-checks
     the exact bytes;
   - stores them as a private **intent** (`private.gear_publish_intents`, service-written),
     together with their SHA-256, the reviewed draft version (or rollback source) and the
     pointer the review saw.
3. `gear_commit_publication(operationId)` runs **with the publisher's own JWT**. In one
   transaction, under a row lock on the target's head, the database itself checks:
   - publisher and aal2 (`private.gear_role()`); for Production, a TOTP `amr` within the step-up
     window;
   - the intent belongs to this user and has not expired;
   - **the pointer is still the reviewed one (CAS)** and **the draft is still the reviewed
     version**.

   It then inserts the publication (exact bytes and digest; MFA evidence taken from the JWT) and
   advances `gear_publication_head.current_publication_id`.
4. **Idempotency:**
   - a request with a known `operationId` never prepares another publication. If committed, it
     returns the original (`replayed: true`); if not yet, it commits that same intent;
   - concurrent duplicates resolve to one intent and one commit; the intent row is locked;
   - reusing an `operationId` for a different request is `operation_conflict`.
5. **Rollback** is the same flow with `rollbackOf`: a new revision with a newer `publishedAt`,
   bound to the reviewed source and baseline.

The Storage catalog write policies and every Storage-path RPC (lease, record, grants, drift
acknowledgement) are removed from client and service roles by migration `20261114100000`. So the
commit RPC is the only way to create a publication or move the pointer, short of a direct-SQL
superuser. Images remain immutable, content-addressed Storage objects (unchanged).

**Read path:** `GET /functions/v1/gear-catalog/{production|staging}` (`verify_jwt = false`).
- Guests and app users read it with no credentials. It uses only the anon-executable
  `gear_current_catalog(target)`: one statement, so bytes, digest, revision and `publishedAt`
  always belong to one publication.
- It returns the exact bytes (the v1 JSON contract, unchanged), after checking them against
  their digest.
- Staging and Production are separate URLs with separate client state.

**Cache behavior:**

| | Production | Staging |
|---|---|---|
| `Cache-Control` | `public, max-age=60` | `no-cache` |
| `ETag` | `"<sha256>"` (gateways may weaken it to `W/"…"`; both forms revalidate) | same |
| `If-None-Match` | 304 | 304 |
| Nothing published | 404 | 404 |
| Errors | 503, `no-store` | same |

The app already sends `If-None-Match`, handles 200 and 304, never clears on another status, and
accepts only a strictly newer `publishedAt`. So a delayed or cached older response cannot
regress a client that has a newer one. Remaining exposure: a device that never received the
newer publication can be served an older complete one by a cache for at most `max-age`
(Production 60 s).

**Re-run scenarios** (`backend/tests/db_pointer.test.mjs`; evidence lines in the test output):

| Scenario | Result |
|---|---|
| Concurrency: 5 publishers from one reviewed state | 1 × 200; 4 × 409 (`live_changed`, `review_stale`); the pointer advanced once |
| Stale writer: A prepared, delayed 4 s; B commits | A 409 `live_changed` from the database CAS; the pointer and the endpoint serve B; A's intent stays uncommitted |
| Client gives up mid-request (abort) | Measured: the server **still committed** after the client aborted. The retry with the same `operationId` replayed it; exactly one publication. Asserted to hold either way |
| Stale writer whose client gave up, then B commits | The newer head stays; retrying A is 409 |
| Duplicates: one operation sent 5× at once | 5 × 200, 1 original + 4 replays, one revision, one publication |
| Lost response (commit succeeded, 502 returned) | The retry returns the original (`replayed: true`), no second publication. Reusing the ID for another request: `operation_conflict` |
| Retry while the original is in flight | One publication; both answers name it |
| Rollback | New revision, newer `publishedAt`, old content served. A stale rollback is refused; a retry replays |
| Draft saved between validation and commit | The database refuses (`draft_changed`); nothing committed |
| Commit RPC called directly | Unknown operation, editor, aal1 and anon refused; intents and their RPCs are service-only |
| Production step-up at commit | The database refuses a session older than the window; a fresh TOTP commits |
| Old Storage object | No client can write it. A key-holder write is never served; the verifier reports it as `legacy_storage_object` |
| Delayed responses vs a client (model of iOS `accept`) | v2 accepted, delayed v1 `rejected(stale)`; 304/404/503 change nothing; the rollback v3 is accepted |
| Readers during 4 publishes (137 responses) | Every body was exactly a recorded publication and matched its ETag; a sequential reader never went backwards |

**The old-design demonstrations stay reproducible** in `backend/tests/legacy-storage/`
(54/54, including the PS1b and PS2 hazards asserted without the guard).

**App impact:**
- **iOS:** the smallest change is the two paths in `GearCatalogSource.objectPath` plus their test
  literals. Installed builds that read the Storage paths keep bundled or last-accepted content
  and never see new publications. Ship the change before the first Production publication. No
  Storage mirror is maintained.
- **Android:** use the endpoint from the start, with the same acceptance rules.

Details: `docs/proposals/ios-catalog-endpoint.md`.

4. **Stamp** `max(now, head + 1, floor)` with a ±300 s guard. **Record** history with status
   `recorded`. **Upload, read back**, and record `verified`, `uncertain` or `conflict`.
5. **Reconcile** reads first and makes at most one re-send per call (no retry loop). It re-sends
   only recorded bytes that never landed, and only through the same compare-and-swap, so content
   that changed after it read is never overwritten automatically. If the object already holds the
   bytes, reconcile records `verified` without writing.

**Tested locally:**
- a stale publisher paused after its commit is rejected by Storage, and B's object stays;
- a stale publisher paused before recording gets `lease_lost`;
- a bypass write during a reconcile pause is not overwritten;
- a lost-response upload is reconciled with no new write.

**Still not prevented:** service and secret keys bypass Storage RLS, so writers holding them
remain detectable drift (below).

Anything in Storage that the database didn't record is **drift**, and it blocks publishing.

### Validation status vs device state

The admin can observe **validation** but not **device or cache state**. The wording is therefore:

- **Fails catalog validation:** conforming clients (iOS 2.4.1 rules; future Android must match)
  reject it and keep their previous document. Its `publishedAt` sets **no** floor, and it is not
  the review baseline. Whether a device or a cache shows something unexpected is **unknown**.
- **Passes catalog validation:** a conforming client **could have** accepted it, depending on its
  own last accepted publication. Whether any device actually holds it is **unknown**. Treat it as
  possibly accepted: it becomes the **review baseline**, its `publishedAt` is the stamping floor,
  and its revision counts as used.
- **Acknowledging records this; it never skips a check.** The next publication still passes:
  - full validation and the successor check;
  - the image checks;
  - partner approvals (Production);
  - the clock guard;
  - publisher and MFA verification.

### Far-future valid catalog: block and report (default)

If Storage holds a document that **passes** validation with `publishedAt` more than 300 s ahead:
- acknowledgement is **refused**;
- every publish attempt is **refused** (`incident_future_timestamp`);
- both are written to the audit log, and the UI shows an incident banner;
- reconcile does **not** overwrite it, and **no** timestamp leap is made.

Any recovery is a separate decision by Julian, made outside the admin and not implemented here:
restore the previous bytes, publish a forward-stamped correction, or an app change that caps
accepted skew. **How the incident is delivered** (email, push, other) **is an unresolved deployment
decision.** Today the prototype reports it only through the UI and the audit log.

### Prevention vs detection

The scheduled verifier (proposed: every 5 minutes) is **detection only**.

**Prevention:**
- the bucket has no write policies for `anon`/`authenticated`;
- `gear-publish` is the only routine writer;
- CLI `--upload` is retired;
- key minimization and verified revocation (§5);
- Supabase org membership limited to Julian, with MFA.

**Remaining privileged bypasses,** handled by detection, the drift workflow and audit:
- Supabase dashboard uploads;
- any secret-key holder;
- **every Edge Function in the project**, through the default keys;
- direct SQL as `postgres`;
- the Supabase platform itself.

**Residual risk:** a bypassing write can be served until it is detected and superseded.
Signed catalogs (an app change) would make clients reject content that was not signed by the
publisher. They would **not** prevent an older, validly signed publication from being written
over a newer one, and they would not stop clients with no newer copy from accepting it. Ordering
needs a commit-time check (§6.1, option 1) or a database-served pointer (option 2).

## 7. Drafts, history, images

- **Drafts:** version lock. Edits typed during a save are kept, and retained edits keep their
  original base (review fixes).
- **History:** append-only exact bytes, a separate status log, and rollback as a new publication.
- **Images (implemented locally):** `gear-publish?action=upload_image` sniffs the type from the
  bytes (PNG/JPEG only; HEIF/HEIC refused even when mislabelled), reads dimensions from the header
  (≤ 8,192 px per side, ≤ 40 MP, ≤ 5 MB), names the object `images/<brand>/<sha256>.<png|jpg>`,
  and uploads with the caller's JWT and a single-use image grant. Storage RLS allows **insert only**
  (no overwrite, no delete policy). The function reads the object back and checks its hash.
- **Verifier (implemented locally, on demand; not scheduled):** read-only. It reports drift,
  incidents, pending/refused/uncertain statuses, expired leases, missing images and unreferenced
  images (`deleted: false`), and writes one audit entry. **Nothing is deleted automatically**
  (D9). Alert delivery stays unresolved (D1); scheduling waits for the hosted tier.
- **Review binding:** `review` returns a digest of target, draft version or rollback source,
  baseline bytes, candidate brands and (Production) approvals. Publish recomputes it under the
  lease and refuses `review_stale` on any difference.

## 8. Future-dated seed; proposed validator warning (separate change)

The supported publisher restamps `publishedAt`. The risk is only a **raw upload** of
`docs/remote-gear/catalog-v1.json` (stamped 2026-11-18). The warning for `validate_catalog.py` is
a **separate proposed tooling change** in the iOS repository: see
`docs/proposals/validator-future-timestamp.md`. It is not part of this PR.

## 9. Public DNS for 85blends.app (read 2026-11-13; no changes)

Read through two resolvers (Google, Cloudflare). They agree, and the answers are DNSSEC-validated.

| Record | Value |
|---|---|
| NS | `nse1`–`nse4.squarespacedns.com` |
| SOA | contact `cloud-dns-hostmaster.google.com` |
| DS | present (zone is DNSSEC-signed) |
| A (apex) | GitHub Pages `185.199.108–111.153`; no AAAA, no CAA |
| `www` | CNAME `julianf40-hub.github.io` |
| MX | `smtp.google.com` |
| TXT | SPF (Google), Google site verification |
| `_dmarc` | `p=none` |
| `admin.85blends.app` | NXDOMAIN |
| `_github-pages-challenge-julianf40-hub` | NXDOMAIN |

**What this establishes:** Squarespace DNS serves the zone, the site is on GitHub Pages, mail is
routed to Google, the zone is signed, and `admin.` is unused.

**What it does not establish:** the registrar, the account owner, or who controls any of the
accounts.

The `.pages.dev` arrangement in §2 needs **no DNS change**. Moving the zone would require careful
DS coordination and is not proposed. Out of scope, reported only:
- no visible GitHub Pages domain-verification record;
- no CAA record;
- DMARC is `p=none`.

## 10. Review findings on PR #7

All three findings at `f44de12` (Codex, P2) were fixed in `53a31e2`, after first failing in
`tools/ui-regression.cjs`:
- edits typed during a save were lost;
- retained edits took a newer base;
- the wrong review baseline was used after drift.

Revision `d473feb` added:
- the validation-status wording;
- the far-future incident, which blocks publishing with a distinct incident error and an audit
  entry, and is never acknowledgeable.

### Manual review at `d473feb` (no automated re-review ran; Codex credits are exhausted)

- **The three original findings are confirmed fixed** in the current code. `tools/ui-regression.cjs`
  checks 1–3 pass, and each fails against `f44de12`.
- **Four new findings, fixed in this revision.** Each has a test that fails against `d473feb` and
  passes after the fix.

| # | Finding | Fix | Test |
|---|---|---|---|
| M1 | The local server checked Origin against Host only, so a DNS-rebinding page (matching Origin and Host) could reach the simulated API | Accept only `127.0.0.1` / `localhost` Host headers | `server.test.mjs` "non-loopback Host" |
| M2 | A crash after commit while Storage held an **acknowledged** foreign document was classified as acknowledged drift. The crashed publication stayed `recorded` and was never re-sent | "Never landed" also covers an acknowledged foreign digest; reconcile re-sends the recorded bytes | `server.test.mjs` "crash after commit over an acknowledged foreign document" |
| M3 | The stored history summary was diffed against the recorded publication, not the baseline the publisher reviewed | Summarize against the same baseline | `server.test.mjs` "history summary uses the baseline" |
| M4 | A background poll during an in-flight save showed a spurious "someone else saved" notice. With edits typed during the save, the notice stayed after the save | Skip polling while saving; clear the notice on a successful save | `ui-regression.cjs` #6 |

- **Areas reviewed with no further findings:**
  - simulated authorization: identity headers, MFA and role checks per route, publisher-only
    publish, rollback, reconcile and acknowledgement, single-use upload grants;
  - save conflicts: If-Match, 409 plus the conflict dialog, retained base;
  - drift: validation status, the baseline, the floor only for passing documents, the far-future
    incident;
  - recovery: crash, timeout, lost response, older and foreign writes, rollback as a new publication.
- **The dev fault endpoints (`/api/dev/*`)** need only a simulated sign-in. That is acceptable for
  a local prototype and **must not exist in the real backend** (§2).

## 11. Isolation

This PR touches only `_admin-prototype/` on `claude/85blends-admin-gear-prototype-9v827z`. I did not
connect to, read or change any Supabase project, Cloudflare account, DNS record, key or catalog,
and I created or moved no repository.

## 12. Requirements by tier

### A. Prototype review (this PR): status

| Requirement | Status |
|---|---|
| All changes inside `_admin-prototype/`; Pages build excludes it | Done; `tools/verify-pages-exclusion.sh` PASS |
| Simulation clearly labeled; fictional data; no keys or network | Done; `tests/security.test.mjs` |
| Contract parity with the Python validator | Done; 166 / 166 |
| Review findings fixed and regression-tested (Codex at `f44de12`; manual review at `d473feb`) | Done; `tools/ui-regression.cjs` 6 / 6, `server.test.mjs` |
| Operating model, MFA, publisher-only, drift and incident rules modeled | Done; `tests/server.test.mjs` |
| Operating model and local-first direction | Accepted by Julian (2026-11-13) |

### B. Backend staging (no production data; nothing the apps read)

**Local Supabase first (`supabase start`, free).** The CLI runs Postgres, Auth, Storage and the
Edge Runtime locally. The repository has already replayed its migrations this way
(`MIGRATION_RECOVERY.md`). Local TOTP needs `[auth.mfa.totp] enroll_enabled = true` and
`verify_enabled = true`; **both default to `false`**
([CLI config](https://supabase.com/docs/guides/local-development/cli/config)), so this goes in a
local-only config.

**Status:** the local backend exists on branch `claude/admin-backend-local`, with fictional data
and 47 integration tests passing against a local stack, plus a 15-step browser run of the admin UI
in local-supabase mode (see its README). Implemented locally: Storage write grants, review
binding, validated image uploads, the on-demand verifier, and the UI with real local sign-in and
TOTP. Not implemented: magic-link sign-in, scheduling the verifier, and image retention (D9).

**Checks that local covers:**
- migration replay; RLS; the single-publisher index and publication trigger;
- `save_gear_draft` locking;
- TOTP enrollment and `aal2` (using a time-based code generator);
- `verify_jwt` and `getUser` paths;
- `gear-publish` logic and the lock;
- the crash, timeout and lost-response fault tests;
- drift detection and acknowledgement rules, the far-future incident;
- upload type and dimension checks;
- that anonymous and non-admin writes to the bucket fail;
- validator parity in Deno.

**Checks that need a hosted, non-production environment:**
- Storage origin consistency after an overwrite, and read-back timing on the real (S3-backed) service;
- CDN and `Cache-Control` behavior on public URLs (Smart CDN is unverified);
- whether hosted logs attribute a Storage write to a specific key (§5);
- the default secrets actually injected into hosted functions;
- the asymmetric JWT signing keys and new API keys as issued by the hosted platform. Locally, the
  function receives the new-style key under a different variable name than the hosted docs list;
- the same Storage RLS behavior on the hosted Storage API version: version-based compare-and-swap,
  `x-metadata` in `user_metadata`, and `amr` in policies;
- magic-link email delivery;
- scheduled verifier execution (cron);
- **gear-catalog (D10):**
  - a guest with no apikey can call a `verify_jwt = false` function on the hosted gateway;
  - whether responses are compressed and ETags weakened;
  - whether any CDN in front of functions honors `Cache-Control` and `ETag`;
  - invocation limits and latency at the expected request rate;
- **gear-publish:** the commit RPC called with a hosted-issued user JWT (signing keys, `amr`
  contents); and whether hosted Edge Functions keep processing after a client disconnect (it
  committed locally; the design is safe either way);
- PostgREST's accepted clock skew on expired JWTs (about 30 s locally);
- CORS on hosted functions (locally the gateway answers preflight itself; the function's own
  Origin check is what the tests rely on);
- the Storage API's dry-run RLS and `x-metadata` behavior on the hosted version, and S3 multipart
  or resumable uploads (TUS), which take a different code path from the standard upload;
- an iOS TestFlight build reading a staging object over the real network.

**Options for that hosted environment, cheapest first:**
1. a separate **Free-plan Supabase project** used only for staging. It costs $0, but the free tier
   limits active projects and pauses idle ones, and its plan features may differ from the live
   project's. Confirm the current limits.
2. a **Pro branch** of the live project ($0.01344 per branch-hour). Needs Pro.
3. the live project's `staging/` object. That is a **live write** read by TestFlight installs, so
   it belongs to the production-launch tier and needs explicit approval.

Exit criteria for B: everything above passes, including the alias/Access verification (§2) if
the frontend is hosted in this tier. Each hosted environment, credential or integration created
here needs Julian's go-ahead.

### Credential remediation: an independent workstream (not gated on the admin or the website)

Credential remediation is tracked **separately** from this admin work. It does not wait for the
admin, the backend staging tier or the website to be ready: it proceeds on its own schedule now.
The only coupling is one-way: **verified revocation must be complete before any live admin
publishing** (tier C, item 1). Nothing in tiers A or B depends on it, and nothing in those tiers
creates, changes or uses a live credential.

### C. Production launch (any write to the live project, including `staging/`)

1. **Credential remediation completed and revocation verified** (the independent workstream
   above; required before live admin publishing, not deferred until then), not merely the migration PRs
   merged:
   - the remediation steps of the credential plan are done;
   - every superseded or exposed key is revoked, or the legacy JWT keys are disabled where planned;
   - **verification on the live project** that each revoked credential is now refused, using a
     non-destructive request;
   - no **privileged secret** (secret keys, the service-role or legacy JWT secret, database
     passwords or URLs with credentials, signing secrets, third-party API secrets) remains in any
     repository or its history. **Intentionally public client keys** (the publishable or legacy
     anon key shipped in the apps) are out of scope for this history rule; they are protected by
     RLS, not secrecy.

   **Verified revocation remains mandatory** for every credential the remediation plan revokes,
   whether privileged or public.

   Only after this is the publisher's secret key created.
2. Private `85Blends-Admin` created by Julian; code moved there deliberately.
3. The migration reviewed in `E85-Blends-App`, passing tier B, then applied to the live project. It
   should be a **squashed** migration containing only the §6.2 design. The local history keeps the
   superseded Storage-path steps (and drops their policies and grants in `20261114100000`), but
   the live project never needs them. Exclude `supabase/experimental/` and
   `gear-legacy-storage-demo` from deployment.
4. Real Auth: TOTP enrolled for Julian, dashboard MFA on, sign-ups confirmed off.
5. Function code reviewed across the whole project, plus a CI check that only `gear-*` references
   `recommended-gear` (§5).
6. CLI `--upload` retired.
7. Cloudflare Pages and Access set up by Julian; the §2 coverage verification passes for the
   production URL, deployment hashes and any branch alias.
8. **Alert delivery for the verifier and incidents: unresolved decision.**
9. Far-future incident recovery options decided (the default stays block and report).
10. **The iOS remote-catalog client released, reading the gear-catalog endpoint** (the two-path
    change in `docs/proposals/ios-catalog-endpoint.md`). Production publishing only reaches users
    who install it; builds that read the old Storage paths never see it.
11. The first Production publication goes through `gear-publish`; the seed is never uploaded raw.
12. Android is **not** a blocker for an iOS-only launch. **Before Android is enabled** to read the
    catalog, its reader must implement the identical acceptance rules and pass the ported
    validator cases (§1).

## 13. Unresolved decisions (specific; tracked separately from blockers)

| # | Decision | Options / proposal | Needed by |
|---|---|---|---|
| D1 | Alert delivery for the verifier and incidents | Email, push, or another channel | Production launch |
| D2 | Far-future incident recovery | Restore the previous bytes, a forward-stamped correction, or an app change capping accepted skew (default stays block and report) | Production launch |
| D3 | Admin URL and deploy method | `<project>.pages.dev` with Access (no DNS change) vs a custom hostname (DNS change); Cloudflare Git integration vs a direct upload with a Pages-only token | Hosting the frontend |
| D4 | Hosted non-production environment for tier B's hosted-only checks | Free-plan project vs a Pro branch | Backend staging, hosted part |
| D5 | Production step-up window and JWT lifetime | Proposed 900 s step-up and a short access-token expiry (revocation is function-only, §4). Measured locally: PostgREST accepts an expired JWT for about 30 s after `exp` (refused from +32 s), and a revoked but unexpired JWT until then | Production launch |
| D6 | HEIF uploads | Stay disabled until a server-side decoder and dimension checks exist | Optional |
| D7 | Future-timestamp warning in `validate_catalog.py` | Separate iOS tooling PR (`docs/proposals/validator-future-timestamp.md`) | Optional |
| D8 | Signed catalogs: authenticate content against key holders and tampering. Does **not** prevent an older valid signed publication from overwriting a newer one (needs D10) | App change on iOS (and Android when enabled) | Optional, long term |
| D10 | Commit ordering for catalog writes (§6.1 blocker) | **Decided 2026-11-14: option 2**, the database pointer plus the read endpoint (§6.2). The trigger is experimental evidence only | Done (local) |
| D11 | Staging catalog visibility | The endpoint serves Staging without credentials, as the public Storage object did; the app limits it to TestFlight/Xcode/Debug. Staging may hold content not yet partner-approved. Alternative: require a tester token | Before the first Staging publication on a hosted project |
| D9 | Retention of unreferenced images | e.g. report after 30 days, delete manually | Before image uploads ship |

## 14. Verification in this session

### Backend branch (local stack, fictional data)

- **D10 option 2 (current design):** `node --test --test-concurrency=1 backend/tests/*.test.mjs`
  → **34 / 34**: the database pointer (re-run scenarios, §6.2), foundation, review binding, images,
  origin. The browser run (60 s tokens) → **19 / 19**.
- **Superseded Storage path (evidence):** `backend/tests/legacy-storage/*.test.mjs` → **54 / 54**.
  This includes the PS1b and PS2 hazards, asserted without the guard.

- **Publication-safety review (this round):** `tests/publication_safety.test.mjs` reproduces the
  §6.1 blocker (unguarded variants) and shows the candidate commit guard closing it. The full
  suite is **54 / 54**.
- Browser run **18 / 18**, 7 consecutive, with a 60 s token lifetime. It adds drift
  acknowledgement, real access-token expiry and revocation-then-expiry. The rollback-step timeout
  seen once earlier is **unresolved** (not reproduced in 15 runs; cause not identified;
  diagnostics added).
- Earlier: `node --test --test-concurrency=1 _admin-prototype/backend/tests/*.test.mjs`: 47 / 47
  (backend, bypass B1–B9, review binding, origin, images, verifier).
- Earlier: `node _admin-prototype/backend/tools/ui-local-supabase.mjs`: 15 / 15 browser checks:
  sign-in + TOTP enrollment, wrong code, outsider refused, simulated API disabled, draft conflict,
  draft-version and review-digest binding, Staging publish, Production step-up expiry and fresh
  code, reconcile of an uncertain upload, rollback, image upload with HEIF refused (browser and
  server), verifier, near-expiry refresh, global sign-out elsewhere, sign-out.
- Simulated mode unchanged: `tools/ui-regression.cjs` 6 / 6; `tests/*.test.mjs` 56 pass.

### Prototype PR

- `node --test _admin-prototype/tests/*.test.mjs`: **54 pass**.
- `node _admin-prototype/tools/ui-regression.cjs`: 6 / 6.
- `node _admin-prototype/tools/parity.mjs <E85-Blends-App>`: 166 / 166.
- `_admin-prototype/tools/verify-pages-exclusion.sh`: PASS.
- Site checks unchanged.
- **Not run:** anything against Supabase (local or hosted), Cloudflare, Deno, a CDN or the apps.
