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
# CURRENT DESIGN (what is proposed for deployment)
node --test --test-concurrency=1 tests/*.test.mjs                 # resets the DB; ~6 min
tools/check-deploy-package.sh                                     # the deployment package on its own stack; ~8 min
# HOSTED (opt-in; an explicitly configured NON-production project only; never run by default)
node --test tests/hosted/run-hosted-checks.mjs                    # refuses without the guard's variables (tools/hosted-target.mjs)
# LEGACY FAILURE DEMONSTRATIONS (superseded Storage path; evidence only, never deployed)
node --test --test-concurrency=1 tests/legacy-storage/*.test.mjs  # ~6 min
GEAR_LOCAL_JWT_EXPIRY=60 tools/start-local.sh && GEAR_LOCAL_JWT_EXPIRY=60 node tools/ui-local-supabase.mjs [shots-dir]
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

## Current design: the database is the publication channel (decision D10, option 2)

Plan §6.2 has the full description and the re-run scenario table.

- **Write:**
  - `gear-publish` reviews, stamps and validates the exact bytes, and stores them as a private
    intent keyed by the client's `operationId`;
  - `gear_commit_publication(operationId)`, called with the publisher's own JWT, checks in one
    transaction: role, aal2, Production step-up, pointer compare-and-swap and draft version. It
    then records the bytes and digest and advances `current_publication_id`;
  - retries with the same `operationId` return the original (`replayed: true`).
- **Read:** `GET /functions/v1/gear-catalog/{production|staging}`. It is public and read-only,
  serves the exact bytes, uses the SHA-256 ETag with 304, and sends
  `Cache-Control: public, max-age=60` (Production) or `no-cache` (Staging).
- **Not a channel any more:** the Storage catalog objects. Their write policies and every
  Storage-path RPC are revoked (`migrations/20261114100000_gear_db_pointer.sql`).
- **Images:** unchanged; still immutable Storage objects.
- **Operation IDs:**
  - bound to the publisher, the environment and the request fingerprint (target, action, review
    digest, draft version, expected head, rollback source);
  - stored on the intent and on the append-only publication;
  - a mismatched retry is `operation_conflict`;
  - `gear_cleanup_operations()` deletes expired pending intents and old committed intents.
    Committed replays are still recognized from the publications.
- **Deployment package:** `deploy/package/` (see `deploy/README.md`).
  - Built by `tools/build-deploy-package.mjs`, with test-only code removed and an allowlist plus
    forbidden-content check.
  - Checked statically by `tests/deploy_package.test.mjs`, and at runtime by
    `tools/check-deploy-package.sh`, which also writes `deploy/schema-comparison.md`.
- **Tests:**
  - current design: `tests/db_pointer.test.mjs` (scenarios, read endpoint, cache, client model,
    no second channel), `tests/operations.test.mjs`, `tests/foundation.test.mjs`,
    `tests/review_images.test.mjs`, `tests/deploy_package.test.mjs`,
    `tests/package_mode.test.mjs` (package stack only);
  - legacy failure demonstrations: `tests/legacy-storage/` only.
- **Images:** in their own bucket, `recommended-gear-images`. The existing `recommended-gear`
  bucket is never altered (`deploy/ROLLOUT.md`: fresh vs existing project).
- **Hosted mode** (prepared, unused):
  - `server.mjs --backend=hosted-test` and `tests/hosted/run-hosted-checks.mjs`;
  - both pass through `tools/hosted-target.mjs`: explicit ref and URL, production refs refused,
    typed confirmation, publishable key only, no privileged key in the environment;
  - functions answer CORS themselves, checked by `tests/cors.test.mjs`, which bypasses local Kong.
- **Staging is public (D11):** fictional or approved-for-public content only, labelled in the
  admin UI. Production partner approval is separate.
- **Client model:** `tests/client-model.mjs` is a line-referenced model of the iOS `accept` rule.
- **iOS and Android:** `../docs/proposals/ios-catalog-endpoint.md`.

### Superseded: the Storage publication path (experimental evidence only)

Everything below this point, through "Publication-safety review", describes the earlier design.
It is kept so its failures stay reproducible, and it is **excluded from the migration and
deployment path**:
- `supabase/experimental/legacy-storage-path/`: the catalog write policies, RPC grants and the
  commit-guard trigger, applied by the legacy tests as the local superuser;
- `supabase/functions/gear-legacy-storage-demo/`: refuses every request unless
  `GEAR_ALLOW_TEST_FAULTS=local-only`;
- `tests/legacy-storage/`.

## What is implemented

| Piece | File |
|---|---|
| Schema, RLS, grants, triggers, RPCs, lease, local bucket | `supabase/migrations/20261113180000_gear_admin.sql` |
| Storage fencing and compare-and-swap, Production step-up in Storage RLS | `supabase/migrations/20261113190000_gear_storage_cas.sql` |
| Fictional users (publisher, editor, outsider, spare), admin rows, draft, local step-up window | `supabase/seed.sql` (generated) |
| Single-use write grants, hidden lease token, catalog write policies, JSON guard, `refused` status | `supabase/migrations/20261113200000_gear_write_grants.sql` |
| Image grants (insert-only), image listings, lease overview for the verifier | `supabase/migrations/20261113210000_gear_images_verifier.sql` |
| **Database pointer, intents, commit RPC, read RPC; Storage catalog writes and Storage-path RPCs revoked** | `supabase/migrations/20261114100000_gear_db_pointer.sql` |
| `gear-publish` Edge Function (review, publish, rollback, inspect, verify, upload_image) | `supabase/functions/gear-publish/index.ts` |
| `gear-catalog` read-only endpoint (public) | `supabase/functions/gear-catalog/index.ts` |
| Superseded Storage path (local evidence only) | `supabase/functions/gear-legacy-storage-demo/`, `supabase/experimental/legacy-storage-path/` |
| Shared contract modules (byte-identical to `../lib/`) | `supabase/functions/_shared/{validator,diff}.mjs` |
| Integration tests against the running stack | Current: `tests/db_pointer.test.mjs`, `tests/foundation.test.mjs`, `tests/review_images.test.mjs`. Superseded: `tests/legacy-storage/*` |
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
   unless the lease outlives the upload timeout plus 500 ms, but that does **not** stop a started
   upload from committing late. The publication-safety review below reproduced exactly that;
   this is a blocker, addressed by the candidate commit guard.
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
| B9 | **Different bytes of the same size** with a live, unspent grant | Passes the RLS dry run (it sees only declared metadata). **Refused at commit** by the candidate commit guard (stored size and eTag/MD5 checked against the recorded publication); row and served bytes unchanged. Without the guard it was accepted and only detected as drift |

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

### Publication-safety review (from `ba3cfab`)

`tests/publication_safety.test.mjs` asserts the safe outcome. The `-unguarded` variants disable
the candidate trigger (as the local container superuser) and assert the reproduced hazard, so the
evidence is regenerated on every run (`EVIDENCE` lines in the test output).

**How Storage writes** (`storage-api` v1.72.1, read from the container):
1. `canUpload()` runs the policies in a **rolled-back** transaction on the request headers
   (`metadata = {mimetype, contentLength}`, `version: "1"`).
2. The body is streamed to the backend (the route's JSON parser is a no-op for uploads).
3. `completeUpload()` runs as a **superuser** under a per-object lock:
   `INSERT … ON CONFLICT (name, bucket_id) DO UPDATE`, with no RLS and no version condition.

**Local gateway buffering:** a probe that deleted the grant and released the lease while the
body was stalled got:
- **through Kong** (`:54321`): 403. Kong buffers the whole body, so Storage authorizes after the
  pause;
- **directly to Storage** (`:5000`): **200**. Storage authorized on the headers.

Local passes through Kong are therefore not evidence. The tests cover both paths, and the
fault `stall_body_direct:N` makes the function stream straight to Storage.

| Test | Result (latest run) |
|---|---|
| PS1a: A stalls mid-body for 20 s; its lease expires (6 s); B reconciles, publishes and verifies; A resumes, through Kong | A `409 storage_write_rejected` (refused at authorization, after the buffered body); serves B; `in_sync` |
| PS1b-unguarded: same, streamed to Storage | **Storage serves A's older document** ("A: paused mid-upload") while the head is B. A's function returns `409 lease_lost` (it cannot record anything), which hides the fact that its bytes landed. `inspect` → drift |
| PS1b: same, with the commit guard | A refused at commit (Storage `500 DatabaseError … PT403`, mapped to `storage_write_rejected`); serves B; `in_sync` |
| PS2-unguarded: two requests with one grant, both authorized before either body completes | **Both 200.** The grant row was still present afterwards |
| PS2 / PS2-direct / PS2-repeat (10 rounds, gateway and direct alternating) with the guard | Exactly one 200 per grant; the other gets `PT403`; the grant row is gone after commit; a third, sequential use is refused |

**Where consumption persists:** only in the transaction that commits the object row. The guard's
`DELETE … RETURNING` on `private.gear_write_grants` runs there. Storage's dry run is rolled back,
so nothing done during authorization can persist. The function's own `gear_consume_write` after
the upload remains as cleanup only.

**Bugs found while building the guard** (each covered by a test now):
- an ambiguous plpgsql identifier;
- treating an unchanged `user_metadata` as a key-holder write. That let a *replayed* nonce through
  once the first request had committed;
- key-holder overwrites that omit `user_metadata` inheriting the old nonce.

The final version decides on the proposed row in the INSERT phase of the upsert.

### MFA: what the database verifies vs evidence from the function

| Guarantee | Database verifies it independently? |
|---|---|
| `aal2` to read admin data or save drafts | **Yes**: PostgREST verifies the JWT; RLS and the RPC read `auth.jwt()` |
| Catalog Storage writes only by the publisher with `aal2` | **Yes**: the Storage API verifies the JWT; RLS checks it |
| Production writes need a TOTP within the step-up window | **Yes**: Storage RLS checks the `amr` TOTP timestamp |
| The session is not signed out or revoked | **No**: only the function's Auth check sees revocation. Database-side checks accept a revoked token until it expires |
| The pinned publisher ID | **Partly**: the function checks the ID; the database allows a single publisher and checks the role |
| The publication row's `auth_aal` / `auth_amr` / `published_by` | **No / partly**: evidence written by the function. The trigger checks the supplied values but cannot verify them. The Storage write is the independently verified step |

## Local validation

**After `7aca7c0` (affected checks only; NOT a full run):**
- `tests/replay_boundaries.test.mjs` (promoted from a scratch run): environment and fingerprint
  races, with the intent present and after cleanup (the fallback path), plus the publisher boundary
  at the database. Together with `tests/deploy_package.test.mjs`: **11 / 11**. `deploy/package`
  matches a fresh build and contains no test tools.
- `tools/ui-diagnostics-selftest.mjs` (test-only; never in the package): three deliberate failures
  at the first save, **3 / 3 classified correctly**:
  - `toast-suppressed`: persisted v2 → "save PERSISTED";
  - `save-blocked`: persisted v1, page "Unsaved changes", edit retained → "not persisted; unsaved
    edit retained";
  - `edit-lost`: persisted v1, editor shows the stored text → "not persisted; edit not visible".

  Phase labels always start with the step name.
- Normal browser run: **19 / 19**. Both original timeouts stay **unresolved**; the self-test only
  shows the diagnostics work.

**Full run on `7aca7c0`:** `tests/*.test.mjs` **59 tests: 57 pass, 0 fail, 2 skipped**.
`tools/check-deploy-package.sh`: **36 pass, 8 skipped (fault-dependent), 0 fail**; no unexpected
schema differences.

**Full run on pushed head `d0c02eb` (`claude/admin-backend-hosted-prep`), 2026-11-14:**
- `tests/*.test.mjs`, once, on a clean tree: **57 tests: 54 pass, 1 fail, 2 skipped** (package-only).
- **The failure was a real regression**, introduced in `3b135bd` by the defense-in-depth check in
  `gear_prepare_intent`. Five simultaneous copies of one operation still produced exactly one
  publication, but 2 copies got `operation_conflict` instead of the original. The race: a
  duplicate's lookup ran before the original committed, and its prepare after.
- Fixed after that run (migration `20261114170000`, a function fallback, and two deterministic race
  tests). **Targeted re-run only** (`db_pointer` + `operations`): **26 / 26**. The full suite has not
  been re-run on the fixed head.
- Browser run, once, with finer phases and a failure snapshot: **19 / 19**. Neither earlier
  timeout recurred, so both stay **unresolved**.

**Review round 2 (local branch, before push), 2026-11-14:**
- `tests/*.test.mjs` → 57 tests: 53 pass, 2 skipped (package-only). The 2 failures were tests
  corrected this round: a CORS check that Kong overwrote, and a cleanup expectation changed by the
  tombstone fix. Both re-run: `cors` and `operations` **10 / 10**.
- `tools/check-deploy-package.sh` → package stack **36 pass, 6 skipped (fault-dependent), 0 fail**;
  schema comparison: no unexpected differences.
- Legacy demonstrations **54 / 54**. Prototype tests **56 / 56**; simulated UI **6 / 6**.
- Browser run (60 s tokens): the first run had **1 failure**, a timeout waiting for the "Draft
  saved" toast at the start of the lost-response step. The re-run passed **19 / 19**.
  **Unresolved:** cause not identified, like the earlier rollback-step timeout. Diagnostics now
  also log draft saves.

**Review round 1 (current design), 2026-11-14:**
- `tests/*.test.mjs` → **44 pass, 0 fail, 2 skipped**. The 2 skipped are `package_mode` checks,
  which run only against the package stack. The suites:
  - database pointer (18);
  - operations: binding and cleanup (4);
  - foundation (9);
  - review and images (7);
  - deployment package, static (6).
- `tools/check-deploy-package.sh` → package stack **34 pass, 6 skipped (they need test-only
  faults, absent by design), 0 fail**. `deploy/schema-comparison.md`: no unexpected differences.
- Browser run (60 s tokens) → **19 / 19**, including the D11 PUBLIC label, its note, and the
  disabled Staging publish until the public-content confirmation.
- Legacy failure demonstrations `tests/legacy-storage/` → **54 / 54** (unchanged).

**Earlier, D10 option 2 first pass:**
- `tests/*.test.mjs` → **34 / 34** (18 database-pointer, 9 foundation, 7 review and images).
- The browser run (60 s tokens) → **19 / 19**, 3 consecutive runs. It replaces reconcile and drift with:
  - a lost response: the server commits, the browser gets a 502, and the UI retries with the
    same operation and gets the replayed original;
  - a key-holder write to the old Storage object that is never served;
  - a guest reading Production without a session.
- Legacy evidence `tests/legacy-storage/*.test.mjs` → **54 / 54** (unchanged behavior).

### Earlier rounds (Storage path)

Latest Storage-path round: 54 / 54 integration tests; browser run 18 / 18.

- **Integration:** `node --test --test-concurrency=1 tests/*.test.mjs` → 54 / 54. This is the
  default 3600 s token lifetime; the suite holds tokens for minutes.
- **Browser:** `GEAR_LOCAL_JWT_EXPIRY=60 tools/start-local.sh` then
  `GEAR_LOCAL_JWT_EXPIRY=60 node tools/ui-local-supabase.mjs` → 18 / 18, 7 consecutive runs.
  Screenshots: `../docs/screenshots/local-supabase/`.
- **Rollback-step timeout: unresolved.** One run (before `ba3cfab`) timed out in the rollback
  step. It has not recurred in 15 later runs (8 before this round, 7 in it), and its cause is
  **not identified**. The script now names the wait in progress (`phase:`) and dumps the last
  gear-publish responses, toasts and open dialog on any failure, so a recurrence will show which
  wait timed out and what the server returned. Hypotheses not ruled out:
  - the History list re-rendering under the click;
  - the 10 s poll racing the dialog;
  - a refused rollback, whose error toast the step does not wait for.

**This round (publication safety, drift, real expiry):**
- `tests/publication_safety.test.mjs`: PS1a, PS1b-unguarded, PS1b, PS2-unguarded, PS2, PS2-direct,
  PS2-repeat (see the review above). B9 now asserts refusal at commit.
- Browser, **drift acknowledgement:**
  - a key-holder write blocks publishing (the Publish button is disabled while drift is
    unacknowledged);
  - the publisher acknowledges in the UI (audit `drift_acknowledged`);
  - Changes compares with the acknowledged Storage document;
  - the next publish supersedes it with a newer `publishedAt` and `inspect` returns to
    `in_sync`.
- Browser, **real access-token expiry** (60 s lifetime). The page is held idle with its poll
  suppressed, and each server is probed every second with the exact expired token:

  | | Expired token | Revoked, not yet expired |
  |---|---|---|
  | PostgREST | accepted until **+31 s** after `exp`, `401 PGRST303 JWT expired` from +32 s (identical in all 7 runs) | **200** |
  | Storage (authenticated read) | refused at +1 s (400) | **200** |
  | gear-publish | refused at the gateway ("Invalid JWT") | 401 (`getUser`) |

  - After real expiry, the next UI action refreshes and continues without signing out.
  - After revocation and expiry, the next UI action cannot refresh and returns to sign-in.
  - The adapter's proactive refresh margin is now a quarter of the token lifetime (at most
    60 s), so short lifetimes are not masked by refreshing on every call.

**Previous round (bypass, UI, images, verifier):**
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
- **Commit ordering (D10) is resolved by the database pointer**: it is a database transaction, not a
  Storage write. The Storage path's failures (PS1b, PS2) remain reproducible in
  `tests/legacy-storage/` as evidence.
- **Installed iOS builds that read the Storage paths** never see database publications (no
  mirror). Ship the endpoint change before the first Production publication
  (`../docs/proposals/ios-catalog-endpoint.md`).
- **Abandoned intents** (reviews never committed) stay in `private.gear_publish_intents` and expire
  after 10 minutes. The verifier reports them; there is no cleanup job yet.
- **Signed catalogs (D8)** would authenticate content, but would **not** stop an older, validly
  signed publication from overwriting a newer object. Clients holding the newer one reject it by
  `publishedAt`; new installs and cold caches would accept it.
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
- **gear-catalog endpoint:**
  - anonymous access to a `verify_jwt = false` function with no apikey;
  - compression and ETag weakening;
  - CDN behavior;
  - invocation limits.
- **gear-publish:** whether hosted functions keep running after a client disconnect (they did
  locally; the design is safe either way).
- (Superseded, only if the Storage path is ever revisited) **Commit guard viability (D10):**
  - whether a project may create, replace and later remove a trigger on `storage.objects`;
  - whether hosted Storage commits through the same upsert;
  - whether the hosted eTag is the MD5 of the bytes (not for S3 multipart or some encryption
    modes);
  - whether TUS and S3-protocol uploads hit the same trigger.
- Whether the hosted gateway buffers or streams upload bodies (local Kong buffers; never rely
  on either).
- PostgREST's accepted clock skew on `exp` on the hosted version (about 30 s locally).
- CORS set by the hosted function for the admin origin (locally the gateway answers preflight
  with `*`; the function's own `bad_origin` check is what the tests rely on).
- The Storage API's dry-run RLS (`canUpload`) and `x-metadata` behavior on the hosted version;
  S3-protocol and resumable (TUS) uploads, which use different code paths and must be refused or
  covered by the same policies.
- An iOS TestFlight build reading a staging object over the real network.
- Verified revocation of the remediated credentials. This is an **independent workstream**
  (plan §12): it proceeds now, not when the website or admin is ready, and must be complete
  before any live admin publishing.
