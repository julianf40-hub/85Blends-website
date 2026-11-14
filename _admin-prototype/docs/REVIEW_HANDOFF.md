# Review handoff: Recommended Gear admin backend (2026-11-14)

Local scope is frozen here. Nothing below has been deployed, merged, published live or applied to
any hosted project, and no credentials were changed.

## 1. Heads

| Ref | SHA | What it is |
|---|---|---|
| PR #7, `claude/85blends-admin-gear-prototype-9v827z` | `1d92336d07761d79c06bb021f8f8690ee4c55787` | Simulated admin prototype (website repo) |
| **PR #8 (draft)**, `claude/admin-backend-local`, base: PR #7's branch | `1f6898c5a639e9d5aef0c3184f05453ef6f39e6b` | The local backend as first reviewed: database publication channel (D10), deployment package, operation binding |
| **Candidate**, `claude/admin-backend-hosted-prep` (no PR) | `c56e281a92a9c0ce7af0007108fbeb26d6bb625e` | PR #8 plus the 4 commits below: hosted preparation and review fixes |

The candidate is a fast-forward of PR #8: `1f6898c → 3b135bd → d0c02eb → 7aca7c0 → c56e281`.
Compare: `https://github.com/julianf40-hub/85Blends-website/compare/1f6898c...c56e281`.

**Decision for Julian:**
- (a) review the candidate through that compare view, keeping PR #8 at `1f6898c`; or
- (b) authorize a normal (fast-forward) push of `c56e281` to `claude/admin-backend-local`, which
  updates PR #8.

Nothing is merged either way.

## 2. Changes since PR #8 (44 files, +1387 −268), grouped for review

### Deployment-affecting (review first)

These are what a hosted project receives, under `backend/deploy/package/`:
- **Migration** (`migrations/20261114130000_recommended_gear_admin.sql`):
  - images in a new bucket, `recommended-gear-images`; the existing `recommended-gear` bucket is
    never named or changed;
  - tombstones (`private.gear_retired_operations`) so cleaned-up operation IDs stay bound;
  - `gear_prepare_intent` returns an existing intent first (the duplicate-request race fix), and
    refuses retired or already-published IDs only when no intent exists;
  - `gear_current_catalog` checks the publication's target;
  - `gear_find_operation` also reports retired operations.
- **`functions/gear-publish/index.ts`:**
  - identity is checked first; a committed operation is replayed before the Production step-up
    check;
  - the step-up window is read from `gear_settings` (one source);
  - the retired-operation answer;
  - the prepare-race fallback (re-read the operation, replay if it's the same request, otherwise
    conflict);
  - `GEAR_PUBLIC_API_KEY` (publishable key) instead of the legacy anon key;
  - the image bucket is configurable.
- **`functions/gear-catalog/index.ts`:** a publishable-key read path; it answers its own `OPTIONS`
  preflight and exposes ETag and revision headers.
- **`ROLLOUT.md` (new):** fresh project vs existing project, with preflight and postflight
  snapshots proving the old bucket is unchanged, and a compatibility table (installed builds,
  updated builds, the current publisher).
- **`ops/schedule-cleanup.sql` (new):** optional, reviewed separately; enables `pg_cron`.
- **`README.md`:** secrets (`GEAR_PUBLIC_API_KEY` added, the step-up variable removed).

### Development history (local only)

These migrations are never deployed; the squashed deployment migration above replaces them:
- `supabase/migrations/20261114150000_gear_images_bucket.sql`
- `20261114160000_gear_operation_tombstones.sql`
- `20261114170000_gear_prepare_race.sql`

The earlier `20261114140000_gear_images_only_bucket.sql` (the images-only restriction) is removed.
The legacy fixture restores the old image setup only for the old-design demonstrations.

### Hosted-test preparation (prepared, never used)

- `backend/tools/hosted-target.mjs` is the one guard for hosted access. It requires an explicit
  ref, the exact URL and a typed confirmation, and it refuses:
  - targets listed in `GEAR_PRODUCTION_PROJECT_REFS` (from the environment, never committed);
  - any non-publishable key;
  - any privileged key present in the environment.
- `server.mjs --backend=hosted-test`, with UI wording and banner for that mode.
- `backend/tests/hosted/run-hosted-checks.mjs`: opt-in only. It never resets, seeds, runs SQL or
  uses a service key. It is read-only unless `GEAR_HOSTED_TEST_WRITES=staging`, and never writes
  Production.

### Tests and tools (local; never in the package)

- **Test files:**
  - `tests/cors.test.mjs`: CORS from the function itself, bypassing local Kong;
  - `tests/hosted_guard.test.mjs`;
  - `tests/replay_boundaries.test.mjs`: environment and fingerprint races, intent present and after
    cleanup; the publisher boundary at the database;
  - additions to `operations` and `db_pointer`.
- **Tools:**
  - `tools/ui-diagnostics-selftest.mjs`, test-only, with `GEAR_UI_INJECT_FAILURE` in the browser
    script;
  - finer phases and a failure snapshot in `tools/ui-local-supabase.mjs`;
  - `check-deploy-package.sh` and `start-local.sh` pass the local publishable key.

### Docs

- `IMPLEMENTATION_PLAN.md`: review round 2; D4 updated.
- `docs/proposals/hosted-nonprod-environment.md`: official sources and verified capacity.
- `docs/proposals/ios-catalog-endpoint.md`: the Xcode Cloud wording corrected.

## 3. Validation, by head (each run once; nothing re-run for a pass)

| Head | Run | Result |
|---|---|---|
| `d0c02eb` | full `tests/*.test.mjs` | 57 tests: 54 pass, **1 fail** (a real duplicate-request race, fixed in `7aca7c0`), 2 skipped |
| `7aca7c0` | full `tests/*.test.mjs` | **59 tests: 57 pass, 0 fail, 2 skipped** (package-only checks) |
| `7aca7c0` | `tools/check-deploy-package.sh` | **36 pass, 8 skipped (fault-dependent), 0 fail**; schema comparison: no unexpected differences |
| `c56e281` | **affected checks only** (not a full run): `replay_boundaries` + `deploy_package` | 11/11 |
| `c56e281` | `tools/ui-diagnostics-selftest.mjs` | 3/3 deliberate failures classified correctly |
| `c56e281` | browser run, normal | 19/19 |
| all | legacy failure demonstrations (`tests/legacy-storage/`) | 54/54 (last run on `3b135bd`) |

**Unresolved:**
- the two original browser timeouts (the rollback step; the lost-response step). The diagnostics
  now classify a recurrence, but their causes are unknown;
- the iOS native tests have not been run.

## 4. iOS endpoint patch: apply and test on the Mac

Patch: `docs/proposals/ios-gear-catalog-endpoint.patch`. It is one commit on `E85-Blends-App`
`main` at `e6c42ed`, and changes:
- `GearCatalogSource.objectPath`;
- two test literals in `GearCatalogTests.swift`;
- a new file, `GearCatalogEndpointTests.swift`.

The live project ref in the existing test literals is replaced by `<project-ref>` in the saved
file; step 2 restores it from your checkout. Run in a clean clone of `E85-Blends-App`:

```sh
# 1. Branch from current main. If main has moved past e6c42ed, apply anyway and resolve, or tell me.
git fetch origin && git checkout -b feature/gear-catalog-endpoint origin/main
# 2. Restore the ref and apply
REF=$(grep -o 'https://[a-z0-9]*\.supabase\.co/rest/v1/' EightyFiveBlends.xcodeproj/EightyFiveBlendsTests/GearCatalogTests.swift | head -1 | cut -d/ -f3 | cut -d. -f1)
sed "s/<project-ref>/$REF/g" /path/to/ios-gear-catalog-endpoint.patch | git am
# 3. Simulator smoke build (repo CLAUDE.md)
xcodebuild -project EightyFiveBlends.xcodeproj -scheme EightyFiveBlends \
  -destination 'generic/platform=iOS Simulator' -configuration Debug build | tail -40
# 4. Tests: pick an installed simulator
xcrun simctl list devices available | grep iPhone
xcodebuild -project EightyFiveBlends.xcodeproj -scheme EightyFiveBlends \
  -destination 'platform=iOS Simulator,name=<installed iPhone>' \
  -only-testing:EightyFiveBlendsTests/GearCatalogEndpointTests \
  -only-testing:EightyFiveBlendsTests/GearCatalogTests \
  -only-testing:EightyFiveBlendsTests/GearCatalogSourceTests test | tail -40
# 5. Optional: the whole test target
xcodebuild -project EightyFiveBlends.xcodeproj -scheme EightyFiveBlends \
  -destination 'platform=iOS Simulator,name=<installed iPhone>' test | tail -40
```

**Expected:** `BUILD SUCCEEDED` and `TEST SUCCEEDED`. The new suite covers:
- URL construction (both sources, four `SUPABASE_URL` shapes);
- a catalog accepted from the old Storage path being kept and revalidated (old ETag sent, new ETag
  kept, then 304);
- ordering state surviving the update;
- weak ETags with 304;
- no credentials sent;
- a delayed older response rejected without replacing the ETag;
- 404 and 503 never clearing content (also after relaunch);
- bundled content kept before the first publication.

**Not done here:** the branch is not pushed, and no Xcode Cloud workflow is started. The workflows
you previously confirmed are manual-only; current App Store Connect settings were not re-checked
from this environment.

## 5. Isolated hosted-test setup

Full steps: `docs/proposals/hosted-nonprod-environment.md` and
`backend/deploy/ROLLOUT.md` path A.

**Cost (official: supabase.com/pricing and the billing docs, read 2026-11-14):**
- **Recommended:** a new Free-plan project, **$0**. Limits: paused after 1 week of inactivity; no
  automatic backups; 500 MB database, 1 GB storage, 5 GB egress, 500,000 function invocations.
- **If no free slot is available:** a separate organization on Pro, **from $25/month**. Its $10
  compute credit covers the project's Micro instance.
- **Not available:** branching needs Pro or Team.

**Capacity:** checked read-only through this session's connected account. One Free organization;
the live project is active; "85Blends Promo Validation" is paused and doesn't count. That leaves
one free slot. The free limit is two projects **per user, across all organizations** where you're
an Owner or Administrator, so a new organization does not add capacity.

**Account actions for Julian (none done):**
1. Confirm you are not an Owner or Administrator of any other Supabase organization, and that
   "85Blends Promo Validation" stays paused, or choose the Pro option.
2. Create the project, for example `gear-admin-nonprod` in `us-east-1`. Keep the database
   password in your password manager.
3. Auth:
   - sign-ups off, TOTP on;
   - create two fictional users (publisher, editor), auto-confirmed, and enroll TOTP for each.
     Never your production account.
4. Create a secret key `gear-publisher-nonprod` for that project only, and note its publishable
   key.
5. Apply `deploy/package/migrations/` (`supabase link` + `supabase db push`), with the ROLLOUT
   path A pre- and postflight queries. Insert the two `gear_admins` rows. Deploy `gear-publish`,
   and `gear-catalog` with `--no-verify-jwt`.
6. Set the function secrets:
   - `GEAR_PUBLISHER_USER_ID`;
   - `GEAR_PUBLISHER_SECRET_KEY`, entered at a prompt;
   - `GEAR_PUBLIC_API_KEY`;
   - `GEAR_ALLOWED_ORIGINS=http://127.0.0.1:4174`;
   - `GEAR_IMAGE_PUBLIC_BASE`.

   Never set `GEAR_ALLOW_TEST_FAULTS`.
7. Then, locally, with the guard variables (the test ref, its exact URL, the ref typed again, your
   production ref(s) to refuse, the publishable key):
   - the admin UI: `node server.mjs --backend=hosted-test`;
   - the checks: `node --test backend/tests/hosted/run-hosted-checks.mjs`, read-only first, then
     `GEAR_HOSTED_TEST_WRITES=staging` if wanted.

**Hosted checks this unlocks** (plan §12 B):
- guest access and ETags through the hosted gateway;
- whether `OPTIONS` reaches a `verify_jwt` function;
- hosted-issued JWTs (`amr`, signing keys);
- disconnect behavior;
- the PostgREST expiry skew;
- Storage upload paths (TUS, S3);
- `pg_cron` cleanup;
- a TestFlight build pointed at the test project (your Xcode configuration decision).

## 6. Independent of this review

- **Credential remediation** proceeds on its own; verified revocation must precede any live admin
  publishing.
- **Open decisions:**
  - D1: alert delivery;
  - D5: step-up window and JWT lifetime;
  - D9: image retention;
  - retiring `publish_catalog.py --upload` before the first database publication.
