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
| `GEAR_IMAGE_PUBLIC_BASE` | `https://<project-ref>.supabase.co/storage/v1/object/public/recommended-gear/images/` |
| `GEAR_PRODUCTION_STEP_UP_SECONDS` | Must equal `gear_settings.production_step_up_seconds` (default 900; D5) |

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are provided by the platform.

## Apply (to a NON-production project first; plan §12 B, hosted-environment proposal)

```sh
supabase link --project-ref <non-production-ref>
cp deploy/package/migrations/*.sql supabase/migrations/   # in a clean checkout for that project
supabase db push
supabase functions deploy gear-publish
supabase functions deploy gear-catalog --no-verify-jwt
supabase secrets set GEAR_PUBLISHER_USER_ID=… GEAR_ALLOWED_ORIGINS=… GEAR_IMAGE_PUBLIC_BASE=… GEAR_PRODUCTION_STEP_UP_SECONDS=900
supabase secrets set GEAR_PUBLISHER_SECRET_KEY=…        # from the dashboard, never pasted into files
```

For the live project, this migration is reviewed in `E85-Blends-App` (plan §12 C). It is
idempotent toward the existing `recommended-gear` bucket, whose settings it does not change.

## Operations

- **Pending-operation cleanup:** call `gear_cleanup_operations()` hourly (service role; for
  example with `pg_cron` calling the function, or a scheduled function).
  - Pending intents that expired more than 1 hour ago are deleted. They never committed, so a
    retry simply prepares again under the same fingerprint.
  - Committed intents older than 7 days are deleted. Their replay protection stays, because
    retries are recognized from `gear_catalog_publications.operation_id` and `request_digest`,
    which are append-only.
- **Verifier:** `gear-publish` `{action: "verify"}` (on demand; scheduling and alert delivery
  are D1).
