# Recommended Gear admin: deployment package (current design, D10 option 2)

Built by `tools/build-deploy-package.mjs` from allowlisted sources only. **Do not edit
`deploy/package/` by hand.** Edit the sources and rebuild; `--check` fails if the package is
stale. Nothing here has been applied to any hosted project.

## Contents

| Path | What |
|---|---|
| `migrations/20261114130000_recommended_gear_admin.sql` | Squashed schema: current design only |
| `functions/gear-publish/index.ts` | Review, publish, rollback, inspect, verify, image upload (test-only code removed) |
| `functions/gear-catalog/index.ts` | Public read-only catalog endpoint |
| `functions/_shared/{validator,diff}.mjs` | Contract modules (byte-identical to the prototype `lib/`) |
| `functions.toml` | `verify_jwt`: `true` for gear-publish, `false` for gear-catalog |
| `MANIFEST.json` | SHA-256 of every file |

## Never in this package (enforced by the build and `tests/deploy_package.test.mjs`)

- the superseded Storage publication path:
  - `gear-legacy-storage-demo`;
  - `supabase/experimental/legacy-storage-path/` (the catalog Storage policies, lease and grant
    RPCs, and the commit-guard trigger);
  - leases, catalog write grants and drift acknowledgements;
- test-only fault controls (the `x-gear-test-fault` header, pauses, simulated lost responses)
  and the `GEAR_ALLOW_TEST_FAULTS` switch;
- seeds, fixtures, tests, local config and keys.

## Required function secrets (set per project; values never committed)

| Name | Value |
|---|---|
| `GEAR_PUBLISHER_USER_ID` | The publisher's Auth user ID in that project |
| `GEAR_PUBLISHER_SECRET_KEY` | A dedicated `sb_secret_…` key for that project (acts as `service_role` project-wide, plan §5) |
| `GEAR_ALLOWED_ORIGINS` | The admin page origin(s), comma-separated |
| `GEAR_IMAGE_PUBLIC_BASE` | `https://<project-ref>.supabase.co/storage/v1/object/public/recommended-gear-images/images/` |
| `GEAR_IMAGE_BUCKET` | Optional; defaults to `recommended-gear-images` |
| `GEAR_PUBLIC_API_KEY` | That project's **publishable** key (`sb_publishable_…`). Used as `apikey` for anon reads and user-JWT calls, so nothing depends on the legacy JWT anon key |

`SUPABASE_URL` is provided by the platform. The Production step-up window has a single source:
`gear_settings.production_step_up_seconds` (default 900; D5), read by both the function and the commit RPC.

## Apply (to a NON-production project first; plan §12 B, hosted-environment proposal)

```sh
supabase link --project-ref <non-production-ref>
cp deploy/package/migrations/*.sql supabase/migrations/   # in a clean checkout for that project
supabase db push
supabase functions deploy gear-publish
supabase functions deploy gear-catalog --no-verify-jwt
supabase secrets set GEAR_PUBLISHER_USER_ID=… GEAR_ALLOWED_ORIGINS=… GEAR_IMAGE_PUBLIC_BASE=… GEAR_PUBLIC_API_KEY=…
supabase secrets set GEAR_PUBLISHER_SECRET_KEY=…        # from the dashboard, never pasted into files
```

**Fresh project vs existing project:** see `ROLLOUT.md`, which has preflight and postflight
queries for each. The migration creates the new image bucket `recommended-gear-images` and never
touches the existing `recommended-gear` bucket. For the live project it is reviewed in
`E85-Blends-App` (plan §12 C).

## Operations

- **Pending-operation cleanup:** call `gear_cleanup_operations()` hourly. `ops/schedule-cleanup.sql`
  is a separate, optional script that enables `pg_cron` and schedules it; review and run it
  after the migration.
  - Pending intents that expired more than 1 hour ago lose their document but keep a tombstone
    (operation ID, publisher, target, fingerprint) in `private.gear_retired_operations`.
    Afterwards, a same-request retry gets `operation_expired`, as it did before cleanup; any other
    use of that ID gets `operation_conflict`.
  - Committed intents older than 7 days are deleted. Their replay protection stays, because
    retries are recognized from `gear_catalog_publications.operation_id` and `request_digest`,
    which are append-only.
- **Verifier:** `gear-publish` `{action: "verify"}` (on demand; scheduling and alert delivery
  are D1).
