# Proposal: read Recommended Gear from the gear-catalog endpoint (iOS; future Android)

Status: **prepared, not yet natively tested, not pushed.**
- The change is one commit on an isolated local branch, `feature/gear-catalog-endpoint`, on
  `origin/main` `e6c42ed`. It is saved here as `ios-gear-catalog-endpoint.patch`. Nothing in
  `E85-Blends-App` on GitHub has been changed.
- **Why it isn't pushed:** that repo's `CLAUDE.md` says Xcode Cloud start conditions live in App
  Store Connect, so a branch push could start a build, and Xcode Cloud builds are not to be
  started.
- **Why it hasn't run:** the native tests need a Mac with Xcode. None was attached to the session
  that prepared them. The JavaScript model in `backend/tests/client-model.mjs` is **not** native
  validation.

To apply and run on a Mac, in a clean checkout of `E85-Blends-App` at `main`. The live project
ref in the existing test literals is replaced by `<project-ref>` in the saved patch; this restores
it from the checkout:

```sh
git checkout -b feature/gear-catalog-endpoint origin/main
REF=$(grep -o 'https://[a-z0-9]*\.supabase\.co/rest/v1/' EightyFiveBlends.xcodeproj/EightyFiveBlendsTests/GearCatalogTests.swift | head -1 | cut -d/ -f3 | cut -d. -f1)
sed "s/<project-ref>/$REF/g" <path>/ios-gear-catalog-endpoint.patch | git am
xcodebuild test -project EightyFiveBlends.xcodeproj -scheme EightyFiveBlends \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  -only-testing:EightyFiveBlendsTests/GearCatalogEndpointTests \
  -only-testing:EightyFiveBlendsTests/GearCatalogTests \
  -only-testing:EightyFiveBlendsTests/GearCatalogSourceTests
```

Round-trip verified: restoring the ref and applying onto `e6c42ed` gives a tree identical to the
prepared commit.

The native tests in `GearCatalogEndpointTests.swift` drive the real `GearCatalogStore` with an
injected fetch:
- URL construction for both sources and all four `SUPABASE_URL` shapes; no source still points
  at Storage;
- a catalog accepted from the old Storage path is shown after the update and revalidated against
  the endpoint (old ETag sent, same bytes → unchanged, new ETag kept, then 304);
- ordering state survives the update;
- a gateway-weakened `W/"…"` ETag is sent back as received, and 304 keeps the content;
- no credentials are sent;
- a delayed older publication is rejected, and the rejected response does not replace the ETag;
  a rollback is accepted;
- 404 and 503 never clear a published catalog (also after relaunch), and Production keeps its
  bundled content before the first publication. This follows decision D10,
option 2: the database is the publication channel, and apps read the current publication through a
read-only endpoint. Source inspected: `julianf40-hub/E85-Blends-App@e6c42ed`,
`EightyFiveBlends/GearCatalog.swift`.

## What the app does today

- `GearCatalogSource.objectPath` (lines 522–528) names two **Storage** objects:
  - `storage/v1/object/public/recommended-gear/catalog-v1.json`
  - `storage/v1/object/public/recommended-gear/staging/catalog-v1.json`
- `GearCatalogStore.defaultEndpoints()` (lines 834–841) joins them to the project root derived from
  `SUPABASE_URL` (`storageObjectURL`, lines 849–855; a trailing `rest/v1` is stripped).
- `refresh` (lines 1021–1078):
  - sends `Accept: application/json` and, once a publication was accepted, `If-None-Match` with
    the stored ETag;
  - sends no apikey or Authorization header;
  - uses an ephemeral session with no HTTP cache, a 15 s timeout, and a byte limit while
    receiving;
  - refreshes at most every 60 s.
- Status handling: `304` → not modified; `200` → `accept`; anything else (404 included) keeps
  what the app has.
- `accept` (lines 1092–1124):
  - byte-identical documents are "unchanged";
  - otherwise `publishedAt` must be strictly newer (older → `stale`, equal → `conflict`), and the
    revision must be new;
  - ordering state is kept per source.

All of this already matches the endpoint's contract.

## Smallest change

Only the two paths change. The JSON contract, headers, status handling, ordering, caching and
UserDefaults keys stay the same.

```diff
     /// Public object path, relative to the Supabase project URL.
     var objectPath: String {
         switch self {
-        case .production: return "storage/v1/object/public/recommended-gear/catalog-v1.json"
-        case .staging: return "storage/v1/object/public/recommended-gear/staging/catalog-v1.json"
+        // Read-only gear-catalog endpoint: the current publication from the database (D10).
+        case .production: return "functions/v1/gear-catalog/production"
+        case .staging: return "functions/v1/gear-catalog/staging"
         }
     }
```

Then update the expected literals in `GearCatalogTests.swift` lines 219–238 (production and
staging endpoint tests) to `…/functions/v1/gear-catalog/production` and `…/staging`. Optionally,
rename `storageObjectURL` to `catalogURL`; its root-stripping rule is unchanged and still
required.

What does not change, and why it is safe:

- **Keys and ordering state.** `keyPrefix` is unchanged, so an updated install keeps its accepted
  publication, `lastPublishedAt` and revision history. The monotonic rule continues across the
  switch.
- **ETag format.** The endpoint's ETag is the SHA-256 of the bytes; Storage's was its own value.
  The first request after the update sends the old ETag and gets a `200`. If the bytes are the
  same publication, `accept` reports "unchanged" (same FNV digest). Nothing visible changes.
- **No credentials.** The endpoint is public for both sources (`verify_jwt = false`). Staging
  stays gated in the app by `previewEligibility`, as today. Hosted check: confirm the hosted
  functions gateway serves a `verify_jwt = false` function to a request with no apikey header.
- **Weak ETags.** The local gateway returns the ETag as `W/"…"`. The app stores whatever it
  receives and sends it back; the endpoint compares ignoring `W/`. Verified locally (`304` for
  both forms).

## Cache behavior (server side)

| | Production | Staging |
|---|---|---|
| `Cache-Control` | `public, max-age=60` | `no-cache` |
| `ETag` | `"<sha256 of the bytes>"` | same |
| `If-None-Match` | `304`, no body | same |
| Nothing published | `404` (the app keeps bundled content) | `404` (the app shows nothing) |
| Error | `503`, `no-store` (the app keeps its copy) | same |

A cache can only hold an older **complete** publication: the bytes, digest, revision and
publishedAt come from one row, read in one statement. The app accepts only strictly newer
`publishedAt`, so a delayed or cached older response cannot regress a device that already has a
newer one. This is verified with a line-by-line model of `accept` in
`backend/tests/client-model.mjs`: a delayed v1 after v2 is `rejected(stale)`; 304, 404 and 503
change nothing; a rollback (new revision, newer timestamp) is accepted. What it cannot do, and no
server design can: a device that never received the newer publication accepts the cached older
one until the cache expires (at most 60 s for Production).

## Installed builds

- **Builds with the 2.4.1 remote-gear code read the Storage paths.** The new design never writes
  them: the Storage write policies are removed, and `publish_catalog.py --upload` is to be
  retired. Those builds therefore never see a database publication. They keep their bundled
  content (Production) or their last accepted copy, because a missing or unchanged object never
  clears the app.
- **Recommendation:** ship this change in the iOS release that first relies on remote Recommended
  Gear, before the first Production publication. Then no installed build depends on the Storage
  path. Whether any App Store build already contains the 2.4.1 code is not verified here; if one
  does, its users keep bundled content until they update.
- **No mirror:** keeping the Storage object updated "for old builds" would recreate a second,
  mutable publication channel with the ordering problem D10 removed (plan §6.1). This proposal
  does not do that.
- **Existing Storage objects:** leave any existing `catalog-v1.json` objects untouched (deleting
  them does not clear devices). The verifier reports them as not authoritative. Delete the
  staging object once testers are on the updated build, if wanted.

## Android (future)

- The Android reader should use `functions/v1/gear-catalog/{production|staging}` from the start
  and never the Storage paths.
- It must implement the same acceptance rules: strictly newer `publishedAt`; identical bytes are
  unchanged; reused revisions are rejected; nothing is cleared on 404 or errors. It must also
  pass the ported validator cases (plan §1, unchanged requirement).
- It must send `If-None-Match` with the stored ETag and treat `304` as not modified.
- It must keep separate state for Staging and Production.

## Hosted checks before relying on this

- Anonymous access to a `verify_jwt = false` function with no apikey header.
- Whether hosted responses are compressed and whether ETags are weakened.
- Function invocation limits and latency at the expected request rate: each device makes at most
  one request per 60 s while the screen refreshes.
- Whether any CDN in front of functions honors `Cache-Control` and `ETag`.
