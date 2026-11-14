# Proposal: hosted non-production environment (plan §12 B, decision D4)

Status: **recommendation only. Nothing has been created.** Every step is for Julian to run, or to
approve before anyone runs it.

## Sources (official only, read 2026-11-14)

- Pricing page, https://supabase.com/pricing:
  - Free plan: $0, 2 active projects, paused after 1 week of inactivity, 500 MB database, 1 GB file
    storage, 5 GB egress, 500,000 Edge Function invocations, no automatic backups;
  - Pro: from $25/month, including $10/month of compute credits (one Micro instance);
  - Micro compute: $10/month;
  - branching: $0.01344 per branch-hour (Pro and Team plans).
- Billing docs, https://supabase.com/docs/guides/platform/billing-on-supabase:
  - "You are granted two free projects. The project limit applies across all organizations where
    you are an Owner or Administrator... Paused projects do not count towards your free project
    limit."
  - Billing is per organization, and plans cannot be mixed within one organization.

**A separate organization does not give a separate free quota.** The two-project limit is per
user, across every organization where that user is an Owner or Administrator.

## Capacity, verified (read-only, through the session's Supabase connector, 2026-11-14)

| Organization | Plan | Projects |
|---|---|---|
| The account's only visible organization | **Free** | the live project: **ACTIVE**; a promo-validation project: **INACTIVE** (paused) |

- **One active free project is in use, so one free slot is available today.** Paused projects
  don't count, so resuming the paused project would use that slot.
- **Limit of this check:** it sees only the organizations of the account connected to this
  session. Any other organization where Julian is an Owner or Administrator under another login
  also counts toward the two. Julian should confirm there is none.
- **Observation for the production-launch tier:** the live project is on the Free plan, so it is
  subject to the inactivity pause. That is outside this proposal, but it matters before the
  apps depend on the catalog endpoint.

## Options

| Option | Cost (official prices) | Isolation | Availability |
|---|---|---|---|
| **A. New Free-plan project** (recommended, if the slot is confirmed free) | **$0** | Its own project, keys and Auth users. A new organization adds separate membership and settings, but not a separate quota | One slot today. It pauses after 1 week of inactivity (resume by hand; data is kept). No automatic backups, which is fine for fictional data |
| B. Branch of the live project | $0.01344 per branch-hour | Weak: tied to the live project | **Not available:** branching needs Pro or Team, and the organization is Free |
| C. New organization on Pro for this project | from $25/month (the $10 compute credit covers its one Micro instance) | Full, with separate billing | No free-slot constraint. Upgrading the **existing** organization instead would also change the live project's plan, so it is not proposed |

**Recommendation:** use A if Julian confirms the slot is free (no other organizations, and the
paused project stays paused); otherwise C.

## Setup steps (not executed)

1. **Project:** dashboard → new project `gear-admin-nonprod`, in its own organization (for
   separate membership) or in the existing one. The quota is the same either way. Use the region
   of the live project, `us-east-1`, so latency results carry over. Store the generated database
   password in Julian's password manager only.
2. **Auth:**
   - Email provider on; sign-ups **off**; TOTP MFA on;
   - JWT expiry 3600 s at first;
   - create two **fictional** users (publisher, editor) with auto-confirm, and enroll TOTP for
     each. They are never Julian's production account.
3. **Keys:**
   - a new secret key `gear-publisher-nonprod`, for this project only;
   - the publishable key, which is public by design.
4. **Schema:** apply `backend/deploy/package/migrations/` with `supabase link` and
   `supabase db push`, following **`ROLLOUT.md` path A** (fresh project), including its preflight
   and postflight queries. Then insert the two `gear_admins` rows. Optionally run
   `deploy/package/ops/schedule-cleanup.sql` after review.
5. **Functions:**
   - `supabase functions deploy gear-publish`, and `gear-catalog --no-verify-jwt`;
   - secrets:
     - `GEAR_PUBLISHER_USER_ID`;
     - `GEAR_PUBLISHER_SECRET_KEY` (entered at a prompt, never on a command line);
     - `GEAR_PUBLIC_API_KEY` (the publishable key);
     - `GEAR_ALLOWED_ORIGINS=http://127.0.0.1:4174` (where the admin UI runs);
     - `GEAR_IMAGE_PUBLIC_BASE=https://<ref>.supabase.co/storage/v1/object/public/recommended-gear-images/images/`.
   - Never set `GEAR_ALLOW_TEST_FAULTS`; the package has no fault code anyway.
6. **Admin UI against it:**
   ```sh
   GEAR_HOSTED_TEST_PROJECT_REF=<ref> GEAR_HOSTED_TEST_URL=https://<ref>.supabase.co GEAR_HOSTED_TEST_CONFIRM=<ref> \
   GEAR_PRODUCTION_PROJECT_REFS=<live ref> GEAR_HOSTED_TEST_PUBLISHABLE_KEY=<publishable key> \
   node server.mjs --backend=hosted-test
   ```
   It refuses the live project, refuses a mismatched or unconfirmed target, and refuses to start
   if a privileged key is in the environment (`backend/tools/hosted-target.mjs`).
7. **Hosted checks:** run `node --test backend/tests/hosted/run-hosted-checks.mjs` with the same
   variables, plus the fictional publisher's credentials and `GEAR_HOSTED_TEST_ADMIN_ORIGIN`.
   - It is read-only unless `GEAR_HOSTED_TEST_WRITES=staging`, and it never publishes to
     Production.
   - It never resets, seeds, runs SQL or uses a service key.

## Hosted checks still open (plan §12 B)

- **gear-catalog:**
  - a guest with no apikey (status and gateway behavior);
  - whether responses are compressed and ETags weakened;
  - the function's own preflight;
  - publishable-key-only access to the read RPC (`GEAR_PUBLIC_API_KEY`);
  - invocation latency.
- **gear-publish:**
  - whether the gateway passes the `OPTIONS` preflight through to the function with
    `verify_jwt = true`. Locally the runtime did; Kong hid this, so the local test goes direct;
  - hosted-issued JWTs (signing keys, `amr`);
  - whether processing continues after a client disconnects.
- **Auth:** PostgREST's clock skew on expired JWTs (about 30 s locally); revocation behavior.
- **Images:** dry-run RLS and `x-metadata`; TUS and S3-protocol refusal without a grant.
- **Scheduling:** `pg_cron` cleanup.
- **iOS:** a TestFlight build whose `SUPABASE_URL` points at the test project, which is Julian's
  Xcode configuration decision.

## Never in this environment

Production data, the live project's keys, Julian's production Auth account, or a route from
production app builds. Its Staging endpoint is public (D11), so it holds fictional content only.
