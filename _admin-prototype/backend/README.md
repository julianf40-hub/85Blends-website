# Recommended Gear admin: local backend (Supabase, fictional data)

Status: **local only.** This is a standalone local Supabase project (`project_id = "gear-admin-local"`)
with fictional users and catalog data. It is not linked to, and has never contacted, any hosted
Supabase project. It is **not** the live project's migration history (that lives in
`E85-Blends-App/supabase/migrations`, plan §2). Nothing here writes to live Storage, changes
credentials or deploys anything.

## Run it

Requires Docker and the Supabase CLI (tested with 2.117.0).

```sh
cd _admin-prototype/backend
tools/start-local.sh            # starts the stack; hands gear-publish the local sb_secret_ key via env
node --test --test-concurrency=1 tests/*.test.mjs   # resets the local DB first; ~4–5 minutes
node tools/ui-local-supabase.mjs [shots-dir]          # browser run of the admin UI (resets the DB; ~2 minutes)
tools/serve-ui.sh               # or use the UI yourself: http://127.0.0.1:4174 (local-supabase mode)
supabase stop
```

### The admin UI against this stack

`server.mjs --backend=local-supabase` (started by `tools/serve-ui.sh`) serves the same editor in a
**separate, clearly labelled mode**: a teal "LOCAL SUPABASE MODE" banner instead of the amber
simulation banner, no simulated accounts or prototype tools, and the simulated `/api` disabled
(404). The page receives only `/config.json`: the loopback API URL and the local **publishable**
key; the server refuses any non-loopback URL or non-publishable key. Sign-in is real local
Supabase Auth with password + TOTP (enrollment shows the fictional account's secret for testing).
The session lives in `sessionStorage`, is refreshed shortly before expiry, and a session that
ended elsewhere returns to sign-in. Production asks for a fresh TOTP code when the step-up window
has lapsed. Simulated mode (`node server.mjs`) is unchanged.

- `tools/start-local.sh` passes the local new-style secret key to the function as
  `GEAR_PUBLISHER_SECRET_KEY` through `env(GEAR_LOCAL_SECRET_KEY)`, so no key is ever committed.
  In this sandbox the CLI image registry is overridden to Docker Hub.
- `node tools/make-seed.mjs` regenerates `supabase/seed.sql` from `../data/fictional-draft.json`.
- The local keys are Supabase's standard local demo keys. They are never committed
  (`supabase/.temp` is ignored), and the tests read them from `supabase status`.

## What is implemented

| Piece | File |
|---|---|
| Schema, RLS, grants, triggers, RPCs, lease, local bucket | `supabase/migrations/20261113180000_gear_admin.sql` |
| Storage fencing and compare-and-swap, Production step-up in Storage RLS | `supabase/migrations/20261113190000_gear_storage_cas.sql` |
| Fictional users (publisher, editor, outsider, spare), admin rows, draft, local step-up window | `supabase/seed.sql` (generated) |
| Single-use write grants, hidden lease token, catalog write policies, JSON guard, `refused` status | `supabase/migrations/20261113200000_gear_write_grants.sql` |
| Image grants (insert-only), image listings, lease overview for the verifier | `supabase/migrations/20261113210000_gear_images_verifier.sql` |
| `gear-publish` Edge Function (review, publish, rollback, reconcile, acknowledge, inspect, verify, upload_image) | `supabase/functions/gear-publish/index.ts` |
| Shared contract modules (byte-identical to `../lib/`) | `supabase/functions/_shared/{validator,diff}.mjs` |
| Integration tests against the running stack | `tests/backend.test.mjs`, `tests/bypass.test.mjs`, `tests/review_images_verify.test.mjs` |
| UI adapter (simulated / local-supabase) and browser run | `../public/backend.js`, `tools/serve-ui.sh`, `tools/ui-local-supabase.mjs` |

### Publishing: lease, then Storage compare-and-swap

A database fencing token alone does not stop a stale process from overwriting Storage. The
negative control below shows that it doesn't. So:

1. `gear_acquire_lease` returns a token, and every DB write must present the live token.
2. `gear_prepare_write` captures the stored object version **before** the function reads the object.
3. The upload uses the **caller's verified JWT** (not a service key). Under the lease the function
   issues a **single-use write grant** bound to the target, object path, prepared publication,
   the publisher's user ID and the byte size, and sends only its nonce (`gear_write`) in
   `x-metadata`. `storage.objects` RLS requires:
   - publisher plus `aal2` from that JWT;
   - a live grant for this path, issued to this user, whose size equals the declared
     `contentLength`, under the live, unexpired lease;
   - for an update, the existing version equal to the prepared version (compare-and-swap);
   - for Production, a TOTP `amr` entry within `gear_settings.production_step_up_seconds`.

   The grant is consumed after each attempt. A rejected upload leaves the served object unchanged.

   **When RLS runs (corrected):** Storage evaluates these policies in `canUpload()`, a
   **rolled-back dry run before the bytes are received**, against the declared metadata only;
   the real row is then written as a superuser. Earlier text here said RLS is "evaluated when
   Storage commits the object row"; that was wrong. Consequences: RLS cannot check content, and
   the lease/CAS checks hold when the upload **starts**. The function refuses to start an upload
   unless the lease outlives the upload timeout plus 500 ms.
4. Reconcile reads first, makes at most one re-send per call (no retry loop), re-sends only
   recorded bytes that never landed, and only through the same compare-and-swap. If Storage
   already holds the bytes, it records `verified` without writing.

**Negative control (run in this session, then reverted):** with uploads switched to the service
key, a publisher A paused past its lease overwrote publisher B's newer object. Storage served A's
older revision while the head said B. The database still refused A's status update (`lease_lost`),
but too late. With the RLS-checked upload, the same scenario is refused by Storage
(`storage_write_rejected`) and B's object stays.

**Still not prevented:** service and secret keys bypass Storage RLS. Writes made with them are
detected as drift and require acknowledgement (plan §6).

### Bypass review (a caller skipping the Edge Function)

Reviewed from `f7d2a3c`. **Finding:** the publisher could read `lease_token` from
`gear_publication_head` over REST, and with a live lease upload arbitrary bytes directly to
Storage (the probe returned 200). **Fixed** by hiding the lease columns (column-level grants) and
requiring the single-use grant above. `tests/bypass.test.mjs`:

| # | Attempt without the function | Result |
|---|---|---|
| B1 | Read `lease_token` / prepared version over REST (with a live lease) | Refused (column grants); readable at `f7d2a3c` |
| B2 | Publisher calls acquire-lease, prepare-write or authorize-write RPCs | Refused (service-only) |
| B3 | Use a leaked lease token as the write credential, no grant nonce | Refused |
| B4 | Replay a spent grant nonce read back from the object's metadata | Refused |
| B5 | Use a Staging grant on Production, or a grant on another path | Refused |
| B6 | Declare a size different from the authorized publication's | Refused |
| B7 | Expired grant; grant after the lease was released; second use of a live grant | Refused (positive control succeeds once) |
| B8 | `aal1` publisher; `aal2` editor; publisher role removed; publisher swapped to another account; role removed while the function is paused before upload | Refused; through the function: `storage_write_rejected`, served object unchanged, status `refused`, reconcile re-sends |
| B9 | **Different bytes of the same size** with a live, unspent grant | **Accepted** (documented limitation): RLS sees only declared metadata. Detected as drift by `inspect` and the verifier; must be acknowledged before publishing again |

**Content checks that still depend on the function:** v1 validation, successor/ordering,
partner approvals, image checks, byte-equality with the recorded publication, the Production
confirmation and review digest, and session revocation.

### Review binding, images, verifier

- **Review binding:** `review` returns `reviewDigest` = sha256 of target, draft version or
  rollback source, baseline bytes, candidate brands and Production approvals. Publish recomputes
  it inside the lease; any difference is `review_stale`. Draft changes are `draft_changed`.
- **Images:** `?action=upload_image&brand=<id>` with the raw bytes. Type sniffed from the bytes
  (PNG/JPEG only; HEIF/HEIC refused, including mislabelled), dimensions from the header
  (≤ 8,192 px per side, ≤ 40 MP), ≤ 5 MB, name `images/<brand>/<sha256>.<ext>`. Uploaded with the
  caller's JWT and a single-use image grant; insert-only policy (no overwrite, no delete); read
  back and hash-checked.
- **Verifier:** `{action: "verify"}`, on demand, read-only. Reports drift, incidents,
  pending/refused/uncertain statuses, expired leases, missing images and unreferenced images
  (`deleted: false`); writes one `verify_run` audit entry; `alertDelivery.configured: false` (D1).
  Not scheduled, and nothing is deleted automatically.

### MFA: what the database verifies vs evidence from the function

| Guarantee | Database verifies it independently? |
|---|---|
| `aal2` to read admin data or save drafts | **Yes**: PostgREST verifies the JWT; RLS and the RPC read `auth.jwt()` |
| Catalog Storage writes only by the publisher with `aal2` | **Yes**: the Storage API verifies the JWT; RLS checks it |
| Production writes need a TOTP within the step-up window | **Yes**: Storage RLS checks the `amr` TOTP timestamp |
| The session is not signed out or revoked | **No**: only the function's Auth check sees revocation. Database-side checks accept a revoked token until it expires |
| The pinned publisher ID | **Partly**: the function checks the ID; the database allows a single publisher and checks the role |
| The publication row's `auth_aal` / `auth_amr` / `published_by` | **No / partly**: evidence written by the function. The trigger checks the supplied values but cannot verify them. The Storage write is the independently verified step |

## Local validation (latest: 47 / 47 integration tests; browser run 15 / 15)

The browser run passed 8 consecutive times. One earlier run timed out in the rollback step and did
not recur; the script now dumps toasts and dialogs on failure so a recurrence can be diagnosed.
Screenshots from a run: `../docs/screenshots/local-supabase/`.

**Latest round (bypass, UI, images, verifier):**
- `tests/bypass.test.mjs` B1–B9 (table above).
- `tests/review_images_verify.test.mjs`: review digest binding (draft, approvals, baseline,
  rollback source), Origin allowlist (`bad_origin` 403), image type/size/dimension/HEIF checks,
  image grant replay and overwrite refused, verifier report and audit.
- `tools/ui-local-supabase.mjs` (Chromium, real local Auth): sign-in and TOTP enrollment for
  publisher and editor; wrong code stays `aal1`; outsider refused after TOTP; simulated API 404;
  **draft conflict** between two sessions; **reviewed-change binding** (draft saved after review →
  refused; a digest that differs from the server's → `review_stale`, nothing recorded);
  **Staging publish** verified by read-back; **Production step-up expiry** (after 42 s the
  function refuses, nothing recorded, the UI asks for a fresh code, then publishes);
  **reconcile** of an uncertain upload from the UI; **rollback** from History via a server
  review; **image upload** (PNG stored; HEIF refused by the browser, and the same bytes sent
  directly with the user's session refused by the server with `heif_disabled`); **verifier** with
  an unreferenced image reported, not deleted; **session** refresh near expiry, **global sign-out
  elsewhere** returns to sign-in, sign-out.
- Not exercised in the browser: a real 1-hour JWT expiry (refresh near expiry and revocation were
  tested instead), drift acknowledgement through the UI (covered by the integration tests).

**Earlier round:**

**First round:**
- **Auth:** real TOTP enrollment and verification; sign-ups disabled.
- **RLS:** anon and `aal1` see nothing; outsiders see nothing.
- **Clients:** no table writes and no access to the service-only RPCs.
- **Draft saves:** `save_gear_draft` locking, including concurrent saves.
- **Database guarantees:** a single publisher; the publication guard (publisher, `aal2`, digest,
  increasing `publishedAt`); append-only tables.
- **Function refusals:** editor, `aal1`, outsider, a signed-out session and a non-pinned
  publisher are all refused.
- **Publishing:** Staging and Production happy paths, including confirmation and approvals; stale
  reviews refused; concurrent publishes; lease fencing.
- **Recovery:** crash after commit; uncertain uploads; bypass drift; a document that fails
  validation; the far-future incident; rollback; global sign-out.

**Second round:**
- **Storage RLS:** anon, no token, a forged token, a missing prepared version, an `aal1` session
  with a valid token, and an `aal2` editor with a valid token are all refused. The `aal2` publisher
  with a live token and a prepared version succeeds once. A second write without re-preparing is
  refused (compare-and-swap). A released token is refused.
- **New-style secret key:** the function reports `serviceCredential: secret_key`. The platform
  accepts `sb_secret_…` in `apikey` alone for REST and RPC, and refuses it as a Bearer token.
- **Production MFA window expiry (40 s locally):**
  - the function refuses with `mfa_step_up_required`;
  - Storage RLS also refuses a direct write with a live lease and a prepared version;
  - a refresh-token grant keeps the old TOTP time and is still refused;
  - a new TOTP verification on that session restores access.
- **Stale publisher paused after its commit:** after its lease expires, B publishes. A's upload is
  refused by Storage (`storage_write_rejected`), A cannot record any status, Storage serves B, the
  head is B, and A's row was finalized by B's reconcile (`recorded` → `verified`).
- **Stale publisher paused before recording:** gets `lease_lost`. No publication row from A, and
  Storage serves B.
- **Reconcile racing a writer:** a bypass write during a paused re-send is **not** overwritten
  (`pending`, "nothing was overwritten"), then shows as drift.
- **Reconcile after a lost response:** reads back, finds the bytes already stored, and records
  `verified` with **no new write** (the object version is unchanged).

## Not implemented or not covered locally yet

- **Not implemented yet:**
  - scheduling the verifier (it runs on demand only), and alert delivery (D1);
  - image retention or deletion (D9; unreferenced images are only reported);
  - HEIF/HEIC (stays disabled, D6);
  - magic-link sign-in (password + TOTP locally; the local SMTP catcher is off).
- **Same-size different bytes with a live grant (B9):** accepted by Storage, detected as drift.
  Only signed catalogs (D8) would prevent it.
- **Object deleted by a key holder:** if a service-key holder deletes the object after a version
  was captured, an insert can recreate it. That deletion is itself a bypass and shows up as drift
  first.
- **Revocation timing:** session revocation is checked only by the function. Database checks rely
  on JWT expiry, so keep access tokens short-lived (decision D5).

## Checks that still need a hosted, non-production environment (plan §12 B)

- Storage origin consistency and read-back timing on the hosted (S3-backed) service.
- The same Storage RLS behavior on the hosted Storage API version: version compare-and-swap on
  upsert, `x-metadata` → `user_metadata`, and `auth.jwt()` / `amr` in policies. Locally this is
  `storage-api v1.72.1`.
- CDN and `Cache-Control` behavior on public URLs (Smart CDN).
- Whether hosted logs attribute a Storage write to a specific API key.
- The secrets actually injected into hosted functions. Locally the new-style key appears as
  `SUPABASE_INTERNAL_SECRET_KEY`, not the `SUPABASE_SECRET_KEYS` listed in the hosted docs.
- Asymmetric JWT signing keys, `verify_jwt` with hosted tokens, and the `amr` contents of
  hosted-issued tokens.
- Magic-link email delivery and hosted Auth rate limits.
- The scheduled verifier on hosted cron.
- CORS set by the hosted function for the admin origin (locally the gateway answers preflight
  with `*`; the function's own `bad_origin` check is what the tests rely on).
- The Storage API's dry-run RLS (`canUpload`) and `x-metadata` behavior on the hosted version;
  S3-protocol and resumable (TUS) uploads, which use different code paths and must be refused or
  covered by the same policies.
- An iOS TestFlight build reading a staging object over the real network.
- Verified revocation of the remediated credentials. This is an **independent workstream**
  (plan §12): it proceeds now, not when the website or admin is ready, and must be complete
  before any live admin publishing.
