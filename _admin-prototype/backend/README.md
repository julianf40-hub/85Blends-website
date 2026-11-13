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
supabase start            # in this sandbox: SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io supabase start
node --test tests/*.test.mjs   # resets the local DB first; ~1–2 minutes
supabase stop
```

`node tools/make-seed.mjs` regenerates `supabase/seed.sql` from `../data/fictional-draft.json`.
The local keys the CLI prints are Supabase's standard local demo keys. They are never committed
(`supabase/.temp` is ignored), and the tests read them from `supabase status`.

## What is implemented

| Piece | File |
|---|---|
| Schema, RLS, grants, triggers, RPCs, local bucket | `supabase/migrations/20261113180000_gear_admin.sql` |
| Fictional users (publisher, editor, outsider, spare), admin rows, draft | `supabase/seed.sql` (generated) |
| `gear-publish` Edge Function (publish, rollback, reconcile, acknowledge, inspect) | `supabase/functions/gear-publish/index.ts` |
| Shared contract modules (byte-identical to `../lib/`) | `supabase/functions/_shared/{validator,diff}.mjs` |
| Integration tests against the running stack | `tests/backend.test.mjs` |
| Local config: TOTP enroll+verify on, sign-ups off, verify_jwt on, test-fault flag local-only | `supabase/config.toml` |

**Authorization (independent layers):**
1. The gateway requires a JWT (`verify_jwt = true`).
2. The function checks the session with Auth (`GET /auth/v1/user`), so revoked or signed-out
   sessions fail.
3. `aal2` is required.
4. Production needs a TOTP `amr` entry within `GEAR_PRODUCTION_STEP_UP_SECONDS`.
5. The `publisher` role in `gear_admins` **and** the pinned `GEAR_PUBLISHER_USER_ID` are both
   required.
6. A DB trigger requires, on every publication row:
   - the single publisher (a unique index allows only one);
   - `aal2`;
   - a digest equal to `sha256` of the stored bytes;
   - a strictly increasing `publishedAt`.
7. History, status, drift acknowledgements and audit are append-only (triggers).

RLS gives read access only to admins with `aal2`. There are no client write grants or policies on
any `gear_*` table or on the bucket. The publication RPCs are executable by `service_role` only.

**Draft concurrency:** `save_gear_draft(expected_version, …)` is a security-definer RPC. It needs
an `aal2` admin, does a conditional update on `version`, and raises HTTP 409 on conflict. It
strips server-stamped fields.

**Publishing:** a **lease with a fencing token** on `gear_publication_head`, rather than a Postgres
transaction held across the HTTP upload. A crashed function's lease expires, and every write
(record, status, acknowledgement) must present the live token. In order:
1. Reconcile the Storage origin (re-send recorded bytes that never landed).
2. Block drift until it is acknowledged, and block a far-future catalog as an incident.
3. Validate (same validator as the apps) and check partner approvals for Production.
4. Stamp `max(now, head + 1, acknowledged floor)`.
5. Record.
6. Upload with `Cache-Control: max-age=60`.
7. Read back from the authenticated origin and record `verified` / `uncertain` / `conflict`.

**Test faults** (`x-gear-test-fault`: `crash_after_commit`, `upload_timeout`, `response_lost`) work
only when `GEAR_ALLOW_TEST_FAULTS=local-only` **and** `SUPABASE_URL` is a local address. The
flag must never be set in a hosted project.

## Local validation (latest run: 22 / 22 pass, 3 consecutive runs)

- **Real TOTP:** password sign-in is `aal1`; enrolling and verifying a TOTP factor yields `aal2`
  with a `totp` `amr` entry; a wrong code is refused.
- **Sign-ups** are disabled.
- **RLS:** anon and `aal1` see nothing; `aal2` admins read; outsiders see nothing.
- **No client writes:** clients can't write `gear_*` tables or call the service-only RPCs.
- **Draft saves:** `aal1` and outsiders are refused; the version lock works; server-stamped fields
  are stripped; of two concurrent saves, exactly one wins.
- **Database:**
  - a second publisher is impossible;
  - publication rows require the publisher, `aal2`, a matching digest and an increasing
    `publishedAt`;
  - UPDATE and DELETE are refused.
- **Storage:** public read works; anonymous **and** `aal2` publisher direct writes fail.
- **Function refusals:**
  - editor → `publisher_required`;
  - `aal1` → `mfa_required`;
  - outsider → `not_admin`;
  - a signed-out session → 401;
  - a publisher role that doesn't match the pinned ID → `publisher_not_pinned`.
- **Global sign-out** revokes every session of the publisher.
- **Happy paths:**
  - Staging: recorded, uploaded, verified and publicly readable; MFA evidence stored on the row.
  - Production: needs the typed confirmation and partner approvals.
- **Stale reviews** are refused (live changed, draft changed). Of two concurrent publishes, one
  wins and the other gets `lease_held` / `live_changed`. A foreign lease holder blocks publishing.
- **Crash after commit:** the publication stays `pending`, the lease is held until expiry, then
  reconcile re-sends the identical bytes.
- **Uncertain uploads** (timeout: not stored; lost response: stored) are reconciled before the
  next publish.
- **Bypass writer** (service-key upload):
  - drift blocks publishing;
  - only the publisher can acknowledge;
  - the next publication is stamped after the foreign document and reviewed against it.
- **Foreign document that fails validation:** no timestamp floor.
- **Far-future catalog that passes validation:**
  - acknowledgement is refused;
  - publishing is blocked as `incident_future_timestamp`;
  - reconcile leaves it untouched;
  - the incident is audited.
- **Rollback** is a new publication (new revision, newer `publishedAt`, `rollback_of` set).

## Not implemented or not covered locally yet

- **Not implemented yet:**
  - image uploads (`gear-upload-url`, finalize);
  - the scheduled verifier (`gear-verify`);
  - wiring the prototype UI to this backend (it still uses `server.mjs`);
  - magic-link sign-in (tests use password sign-in; the local SMTP catcher is off).
- **Step-up expiry:** the Production 15-minute window is only exercised on the allowed side;
  testing expiry needs a clock change or a second function configuration.
- **Key path:** the local function uses the injected legacy `SUPABASE_SERVICE_ROLE_KEY`. The
  `sb_secret_…` path (`apikey` header only) is coded but not exercised.

## Checks that still need a hosted, non-production environment (plan §12 B)

- Storage origin consistency and read-back timing on the hosted (S3-backed) service. Local
  Storage serves from a local file backend.
- CDN and `Cache-Control` behavior on public URLs (Smart CDN).
- Whether hosted logs attribute a Storage write to a specific API key.
- The default secrets actually injected into hosted functions (`SUPABASE_SECRET_KEYS` format,
  legacy keys).
- Asymmetric JWT signing keys, and `verify_jwt` behavior with hosted-issued tokens.
- Magic-link email delivery and hosted Auth rate limits.
- The scheduled verifier on hosted cron.
- An iOS TestFlight build reading a staging object over the real network.
- Verified revocation of the remediated credentials (production-launch tier, live project only).
