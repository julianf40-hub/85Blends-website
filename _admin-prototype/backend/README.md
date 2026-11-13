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
node --test tests/*.test.mjs    # resets the local DB first; ~3–4 minutes (one test waits out the 40 s MFA window)
supabase stop
```

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
| `gear-publish` Edge Function (publish, rollback, reconcile, acknowledge, inspect) | `supabase/functions/gear-publish/index.ts` |
| Shared contract modules (byte-identical to `../lib/`) | `supabase/functions/_shared/{validator,diff}.mjs` |
| Integration tests against the running stack | `tests/backend.test.mjs` |

### Publishing: lease, then Storage compare-and-swap

A database fencing token alone does not stop a stale process from overwriting Storage. The
negative control below shows that it doesn't. So:

1. `gear_acquire_lease` returns a token, and every DB write must present the live token.
2. `gear_prepare_write` captures the stored object version **before** the function reads the object.
3. The upload uses the **caller's verified JWT** (not a service key) with the lease token in
   `x-metadata`. `storage.objects` RLS, evaluated by Postgres when Storage commits the object row,
   requires:
   - publisher plus `aal2` from that JWT;
   - the live, unexpired lease token;
   - for an update, the existing version equal to the prepared version (compare-and-swap);
   - for Production, a TOTP `amr` entry within `gear_settings.production_step_up_seconds`.

   A rejected upload leaves the served object unchanged.
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

### MFA: what the database verifies vs evidence from the function

| Guarantee | Database verifies it independently? |
|---|---|
| `aal2` to read admin data or save drafts | **Yes**: PostgREST verifies the JWT; RLS and the RPC read `auth.jwt()` |
| Catalog Storage writes only by the publisher with `aal2` | **Yes**: the Storage API verifies the JWT; RLS checks it |
| Production writes need a TOTP within the step-up window | **Yes**: Storage RLS checks the `amr` TOTP timestamp |
| The session is not signed out or revoked | **No**: only the function's Auth check sees revocation. Database-side checks accept a revoked token until it expires |
| The pinned publisher ID | **Partly**: the function checks the ID; the database allows a single publisher and checks the role |
| The publication row's `auth_aal` / `auth_amr` / `published_by` | **No / partly**: evidence written by the function. The trigger checks the supplied values but cannot verify them. The Storage write is the independently verified step |

## Local validation (latest: 28 / 28 pass, 3 consecutive full runs)

**Earlier round:**
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

**This round:**
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
  - image uploads (`gear-upload-url`, finalize);
  - the scheduled verifier (`gear-verify`);
  - wiring the prototype UI to this backend;
  - magic-link sign-in (tests use password sign-in; the local SMTP catcher is off).
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
- An iOS TestFlight build reading a staging object over the real network.
- Verified revocation of the remediated credentials (production-launch tier, live project only).
