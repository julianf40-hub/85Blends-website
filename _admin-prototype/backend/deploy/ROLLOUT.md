# Rollout: fresh project vs existing project

The same package (`deploy/package/`) is used for both paths. The migration creates only new
objects: `gear_*` tables and functions, the private schema objects, and a new public bucket,
`recommended-gear-images`. It never reads, alters or deletes the existing `recommended-gear`
bucket: not its settings, policies or objects. `tests/deploy_package.test.mjs` asserts that the
migration never names that bucket.

Nothing here has been run against any hosted project.

## A. Fresh project (the non-production test project)

1. Preflight (SQL editor, read-only):
   ```sql
   select to_regclass('public.gear_admins') is null as no_gear_schema;           -- expect true
   select count(*) = 0 as no_image_bucket from storage.buckets where id = 'recommended-gear-images';
   ```
2. Apply the migration and deploy the functions (`deploy/README.md`). `recommended-gear` does not
   exist there and is not needed.
3. Postflight:
   ```sql
   select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'recommended-gear-images';
   select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'gear%';  -- the 2 image policies
   ```

## B. Existing project (the live project; production-launch tier, plan §12 C)

It runs only after the prerequisites in plan §12 C, including verified credential revocation. It
is a **reviewed migration in `E85-Blends-App`**, not a dashboard edit.

1. **Preflight (read-only), and record the output:**
   ```sql
   select to_regclass('public.gear_admins') is null as no_gear_schema;           -- expect true; stop otherwise
   select count(*) = 0 as no_image_bucket from storage.buckets where id = 'recommended-gear-images';  -- expect true
   -- Snapshot of the existing bucket, to compare afterwards:
   select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'recommended-gear';
   select policyname, cmd, roles from pg_policies where schemaname = 'storage' and tablename = 'objects' order by 1;
   select name, metadata ->> 'size', updated_at from storage.objects where bucket_id = 'recommended-gear' order by name;
   ```
   Per `docs/remote-gear/STAGING_SETUP.md` (E85-Blends-App), the existing bucket is public, with
   5 MB and JSON/PNG/JPEG/HEIC/HEIF, and has **no** `storage.objects` policies.
2. Apply the migration and deploy the functions.
3. **Postflight:** run the three snapshot queries again. They must be identical to the
   preflight output. The only new policies are the two `gear images …` policies on
   `recommended-gear-images`.

## Compatibility

| Who | What they use | Effect of this rollout |
|---|---|---|
| **Installed app builds** (2.4.1 code) | `storage/v1/object/public/recommended-gear/{,staging/}catalog-v1.json` | None. The bucket and its objects are untouched. These builds never see database publications; a missing or unchanged object never clears the app. They keep bundled content or their last accepted copy until updated |
| **Updated app builds** (`docs/proposals/ios-gear-catalog-endpoint.patch`) | `functions/v1/gear-catalog/{production,staging}` | Read the database publication. Image URLs point at `recommended-gear-images`. The app accepts any `https` image URL (no host or bucket restriction), so this needs no app change |
| **Current publisher** (`tools/remote-gear/publish_catalog.py --upload`, service-role key) | Writes `recommended-gear/staging/catalog-v1.json` | Keeps working technically, because nothing in its bucket changes. It is **not** a publication channel for updated builds. Retiring it is a separate, explicit step before the first database publication (plan §12 C item 6). It is not done by this migration |
| **Images uploaded by the admin** | `recommended-gear-images/images/<brand>/<sha256>.<png|jpg>` | New, insert-only, PNG/JPEG only (HEIF stays disabled, D6) |

**During a transition both channels exist.** TestFlight builds without the endpoint change read
the old Storage object; builds with it read the database. Until the old publisher is retired,
avoid publishing different content to both, or testers will see different catalogs by build. The
verifier reports any object at the old paths as `legacy_storage_object` (information, not
authoritative).
