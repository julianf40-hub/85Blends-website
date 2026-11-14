# Proposal: hosted non-production environment (plan §12 B, decision D4)

Status: **recommendation only. Nothing has been created.** Every step below is for Julian to run,
or to approve before anyone runs it.

## Recommendation: a separate Free-plan project in its own organization

| Option | Cost | Isolation from production | Notes |
|---|---|---|---|
| **A. New Free-plan project in a new, separate organization (recommended)** | **$0/month** | Full: own org, own keys, own Auth users, no shared billing or Git integration | Free limits: 2 active projects per account (paused projects don't count); paused after 1 week without activity (resume by hand; data kept); 500 MB database, 1 GB file storage, 5 GB egress, 500,000 Edge Function invocations; no automatic backups. All are ample for fictional data |
| B. Branch of the live project (Pro/Team only) | $0.01344 per branch-hour ≈ $0.32/day, about $9.81 for 30 days left on | Weaker: same org and billing, created from the live project's Git integration, next to production credentials | Only if the live project is already on Pro and Git-integrated |
| C. New project in a paid organization | Micro compute $10/month (Pro from $25/month includes $10 compute credit, usually used by the live project) | Full | Pay only if A's limits block something |

Prices are from supabase.com/pricing, read 2026-11-14. Re-check before creating anything.

**Why A:**
- It costs nothing.
- It shares nothing with production: keys, users, billing or Git integration. Credential
  remediation therefore proceeds independently and is untouched.
- Its limits fit a fictional-data test project.

**Caveat:** if the account already has two active Free projects, pause one or use option C.

## Exact setup steps (not executed)

Names below are suggestions. Use a region close to the live project's, so latency results carry
over.

1. **Organization and project** (dashboard):
   - New organization `85Blends Non-Production`, plan **Free**;
   - New project `gear-admin-nonprod` with a generated database password, stored in Julian's
     password manager only;
   - Record the project ref.
2. **Auth** (dashboard → Authentication):
   - Providers: Email on; **Allow new users to sign up: off**;
   - Multi-Factor: TOTP enabled (on by default on hosted projects);
   - JWT expiry: 3600 s at first, to compare with local; then the D5 value;
   - Users → Add user → Create new user, with auto-confirm: two **fictional** accounts (publisher,
     editor) using an address domain you control or `example.test`. Never Julian's production
     account. Save their IDs.
3. **Keys** (Settings → API Keys): create a **new secret key** `gear-publisher-nonprod`.
   - It exists only in this project and is never copied into a file or chat.
   - The publishable key is public by design.
4. **Schema** (CLI, in a clean working copy):
   ```sh
   supabase login                                   # Julian's own CLI session
   supabase link --project-ref <nonprod-ref>
   mkdir -p supabase/migrations && cp <backend>/deploy/package/migrations/*.sql supabase/migrations/
   supabase db push
   ```
   Then in the SQL editor:
   - `insert into public.gear_admins (user_id, role) values ('<publisher-id>', 'publisher'), ('<editor-id>', 'editor');`
   - `update public.gear_settings set production_step_up_seconds = 900;` (or a shorter value for
     the expiry tests).
5. **Functions:**
   ```sh
   mkdir -p supabase/functions && cp -R <backend>/deploy/package/functions/. supabase/functions/
   supabase functions deploy gear-publish
   supabase functions deploy gear-catalog --no-verify-jwt
   supabase secrets set GEAR_PUBLISHER_USER_ID=<publisher-id> GEAR_ALLOWED_ORIGINS=<admin-origin> \
     GEAR_IMAGE_PUBLIC_BASE=https://<nonprod-ref>.supabase.co/storage/v1/object/public/recommended-gear/images/ \
     GEAR_PRODUCTION_STEP_UP_SECONDS=900
   supabase secrets set GEAR_PUBLISHER_SECRET_KEY        # prompts; paste the step-3 key there, never on the command line
   ```
   - Never set `GEAR_ALLOW_TEST_FAULTS`. The package has no fault code anyway.
   - Confirm that `deploy/package/MANIFEST.json` hashes match the deployed sources.
6. **Cleanup schedule** (SQL editor):
   - enable `pg_cron`;
   - `select cron.schedule('gear-cleanup-operations', '17 * * * *', $$select public.gear_cleanup_operations()$$);`
7. **Admin UI access:**
   - `server.mjs` local-supabase mode deliberately accepts only loopback URLs, so it cannot point
     at this project as is.
   - Hosted testing needs a separate, explicit mode bound to this one project ref. That is a small
     reviewed change and has **not** been made.
   - Until then, the hosted checks below run from scripts with the fictional accounts.

## Hosted checks to run there (from plan §12 B)

- **gear-catalog:**
  - a guest with no apikey gets 200 or 404 from a `verify_jwt = false` function;
  - compression, and whether the ETag stays strong or is weakened;
  - `Cache-Control` and 304 through any CDN;
  - latency at one request per device per 60 s.
- **gear-publish:**
  - the commit RPC with hosted-issued JWTs (asymmetric signing keys, `amr` contents);
  - the Production step-up window;
  - whether a request keeps running after the client disconnects (the design is safe either
    way);
  - CORS for the admin origin;
  - the names of the injected secrets.
- **Images:** that Storage's dry-run RLS and `x-metadata` behave as locally; that TUS and
  S3-protocol uploads are refused for paths without a grant.
- **Auth:**
  - PostgREST's accepted clock skew on expired JWTs (about 30 s locally);
  - that a revoked session is refused by the function;
  - magic-link delivery (if adopted) and rate limits.
- **Scheduling:** the `pg_cron` cleanup and the verifier.
- **iOS:** a TestFlight build with the endpoint change, reading Staging from this project. That
  needs a build whose `SUPABASE_URL` points at the non-production project, which is an Xcode
  configuration decision for Julian; nothing in this proposal changes app configuration.

The test helpers currently assume local Docker and a superuser `psql` connection, so they need a
hosted adapter: service key and database URL from the environment, and no superuser-only steps.
That adapter has **not** been written.

## What this environment must never have

Production data, the live project's keys, Julian's production Auth account, or a route from the
apps' production builds. The non-production Staging endpoint is public (D11), like production
Staging, so it gets fictional or approved-for-public content only.
