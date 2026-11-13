# Recommended Gear Admin: plan for connecting it securely

Status: **plan only.** Nothing here has been migrated, deployed, published or configured. The
prototype in this folder is local, uses fictional data, and simulates sign-in, roles, MFA and publishing.
**The live implementation is planned for a new private repository, `85Blends-Admin`**. That
repository has not been created, and nothing has been moved. Every step that touches Supabase,
Cloudflare, DNS, credentials or another repository needs Julian's go-ahead. None of it starts
until the active credential migration has landed (§11).

Read-only inputs: `julianf40-hub/E85-Blends-App` `main` at `e6c42ed` (`docs/remote-gear/*`,
`tools/remote-gear/*`, `EightyFiveBlends/GearCatalog.swift`, `RecommendedGearView.swift`,
`MoreView.swift`, `supabase/config.toml`, `supabase/functions/_shared`), plus the branches
`fix/gear-publisher-secret-keys` and `feature/supabase-publishable-key-migration` (not changed).
Also public DNS for 85blends.app (§9). **The Android repository was not inspected.**

---

## 0. Operating model (confirmed by Julian, 2026-11-13)

| Rule | Where it is enforced in the real system (§4) | Prototype |
|---|---|---|
| **Julian is the only publisher** | A database constraint allows one publisher row. `gear-publish` also checks a pinned publisher user ID. A trigger on publication inserts rejects anyone else | One simulated publisher account |
| **Real MFA required** | TOTP, `aal2` checked by the gateway, by the function (verified with Auth, not decoded locally), and by RLS for reads and draft saves. Production also needs a recent TOTP verification (≤ 15 min) | A simulated `aal2` toggle |
| **Publisher-only Staging and Production** | `gear-publish` for every target, rollback, reconcile and drift acknowledgement. No write policy exists for anyone else | Enforced; the optional editor account can draft only |
| **No second approver** | Production needs passing server checks, recorded partner approvals, a reviewed summary and the typed confirmation, by one person | Enforced |

With one publisher, review relies on the change summary and on the iOS TestFlight Staging
preview. The Production panel warns when the exact draft version has not been on Staging.

## 1. Platform scope and the catalog contract (unchanged)

- **iOS:** the remote-catalog client is the 2.4.1 code on iOS `main`. Its README says it has not
  been built or tested in Xcode and is not release ready. I did not verify App Store
  availability. The admin's preview is a web approximation written from that SwiftUI source,
  not a build or a screenshot. Final check: an iOS TestFlight build with Staging selected.
- **Android does not read this catalog.** The iOS docs only list what an Android client would
  need. Nothing in the admin represents Android.
- The admin edits **data inside catalog v1**. `lib/validator.mjs` is a rule-for-rule port of
  `validate_catalog.py`: 166 / 166 documents agree (`tools/parity.mjs`), and the schema is
  byte-identical. Dashboard-only data (partner approvals, notes) is never published.
- **Image uploads: PNG and JPEG only.** HEIF/HEIC uploads are disabled in the browser, the upload
  endpoint and the storage naming pattern. They stay off until the backend can decode HEIF and
  validate its dimensions. (The v1 contract and the apps still accept HEIF URLs; only the admin's
  uploads are restricted.)

Changes that need an iOS release, and future Android work, are listed in the UI ("What this admin
can and cannot change") and in `lib/capabilities.mjs`: new kinds or layouts, a second sponsor,
fixed copy, styling, bundled artwork, other offer types, independent More order, targeting, rich
media, a ring with other than nine wheels, and non-https links.

## 2. Target architecture: Cloudflare Pages frontend, Supabase backend

```
Browser (Julian)
  │  HTTPS; Cloudflare Access gate (email OTP / SSO): defense in depth, not the boundary
  ▼
Cloudflare Pages: static files from the private 85Blends-Admin repo
  (public/*, lib/*, config.js with SUPABASE_URL + publishable key; _headers sets CSP/HSTS)
  │  supabase-js: Auth (magic link + TOTP), PostgREST under RLS, Functions with the user's JWT
  ▼
Supabase project (existing one; the recommended-gear bucket already exists there)
  ├─ Auth            invite-only users, TOTP MFA
  ├─ Postgres        gear_* tables + RLS + save_gear_draft() + publication trigger (§4)
  ├─ Edge Functions  gear-state, gear-publish, gear-upload-url, gear-upload-finalize, gear-verify
  └─ Storage         recommended-gear (public read; no write policies; writes only via gear-publish)
```

**What replaces the local Node server** (`server.mjs` is the executable spec; each route maps 1:1):

| Prototype | Real backend |
|---|---|
| `X-Prototype-User` / `X-Prototype-AAL` headers | Supabase Auth session JWT, verified server-side (§4) |
| `GET /api/state` | PostgREST selects under RLS, plus `gear-state` for the Storage inspection and the review baseline |
| `PUT /api/draft` + `If-Match` | `rpc('save_gear_draft', {expected_version, …})` |
| `POST /api/review` | `gear-publish` with `dryRun: true` |
| `POST /api/publish`, `/rollback`, `/reconcile`, `/drift/acknowledge` | `gear-publish` actions (§6) |
| `POST /api/uploads/sign` + `PUT` | `gear-upload-url` (Storage signed upload URL, `upsert: false`), then `gear-upload-finalize` |
| `history.jsonl`, `publication-status.jsonl`, `drift-acknowledgements.jsonl`, `audit.jsonl` | `gear_catalog_publications`, `gear_publication_status`, `gear_storage_drift_acks`, `gear_audit_log` |
| `.local-state/objects/<target>/catalog-v1.json` | `recommended-gear/catalog-v1.json` and `recommended-gear/staging/catalog-v1.json` |
| `/api/dev/*` fault injection | **Removed.** Fault tests run only against a Supabase branch, with test hooks that are not deployed to production |

**Hosting the frontend on Cloudflare Pages:**
- **Source:** the private `85Blends-Admin` repository holds `public/`, `lib/` and a `_headers`
  file. There is no build step.
- **Deploying, two options:**
  - (a) Cloudflare's GitHub integration, granted access to that one repository; or
  - (b) GitHub Actions direct upload with a Pages-only Cloudflare API token stored as an Actions
    secret.

  Either way, a new credential or integration is created later. **Not now.**
- **URL:** start on `<project>.pages.dev` with a Cloudflare Access application covering
  production **and preview** deployments. That needs no DNS change (§9). A custom
  `admin.85blends.app` would mean a CNAME at the current DNS host, and whether Access can protect
  that hostname without moving the zone must be confirmed with Cloudflare first.
- **Public config only:** the page holds just the project URL and the **publishable** key.
- **Cost:** $0 on Pages Free plus Zero Trust Free (≤ 50 users), per the vendors' pricing pages
  read 2026-11-13.

**Where the code lives:** the admin frontend, the shared `lib/` and the Edge Function source go in
`85Blends-Admin`. **SQL migrations stay in `E85-Blends-App/supabase/migrations/`**, because the
live project's migration history is reconstructed and tracked there (`MIGRATION_RECOVERY.md`).
Two repositories pushing migrations to one project would split that history. Functions deploy
independently of migrations, so they can come from the admin repository.

## 3. Authentication

- Supabase Auth, invite-only (`enable_signup = false` is in the checked-in config; confirm on the
  live project). The apps don't use Supabase Auth.
- Magic link plus **mandatory TOTP**. The admin UI requires enrollment before showing anything,
  and RLS returns nothing below `aal2`, so an account without MFA sees no data.
- 1 h access tokens with refresh rotation. Production publishing requires a TOTP verification
  within the last 15 minutes (step-up).
- Turn on MFA for Julian's Supabase **dashboard/organization** account too (§7: the dashboard is a
  privileged bypass).

## 4. Backend authorization that does not trust the UI (proposed; not applied)

Each layer below checks independently. None relies on the browser, on headers, or on
user-editable metadata (`user_metadata` is writable by the user and is **never** used for roles).

1. **Gateway:** `verify_jwt = true` for every `gear-*` function (unlike the existing functions
   that turn it off).
2. **Function identity:** `gear-publish` calls `supabase.auth.getUser(jwt)`, which asks Auth
   directly, so a revoked session or a deleted user fails. It then reads the claims and requires:
   - `aal = 'aal2'`;
   - for Production, an `amr` entry `{method: 'totp'}` no older than 15 minutes;
   - `sub` equal to the pinned `GEAR_PUBLISHER_USER_ID` (a function config value, not a secret);
   - that same user holding the `publisher` role in `gear_admins`, read over the database
     connection.

   All four must agree.
3. **Database constraints (independent of the function code):**

```sql
-- Exactly one publisher can exist.
create unique index gear_admins_single_publisher on public.gear_admins (role) where role = 'publisher';
-- Every publication row must be authored by the current publisher, whoever inserts it.
create or replace function private.gear_require_publisher() returns trigger language plpgsql
  security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.gear_admins a where a.user_id = new.published_by and a.role = 'publisher') then
    raise exception 'publications must be authored by the publisher' using errcode = '42501';
  end if;
  if new.auth_aal is distinct from 'aal2' then
    raise exception 'publications require MFA (aal2)' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger gear_publications_require_publisher before insert on public.gear_catalog_publications
  for each row execute function private.gear_require_publisher();
```

   `auth_aal` and `auth_amr` (the verified claims) are stored on every publication row for audit.
   **Limit, stated plainly:** Postgres cannot verify an MFA claim that the function hands it, so
   the MFA proof rests on Auth plus the function's `getUser` check. The database enforces identity
   and records the MFA evidence.
4. **RLS** for reads and draft saves, via `private.gear_role()`, which requires `aal2` in
   `auth.jwt()`. There are no INSERT/UPDATE/DELETE policies on any `gear_*` table or on the bucket.
   Changing the publisher takes owner SQL **and** a function config change, because two
   independent controls must agree.

Other tables are as drafted before: `gear_catalog_drafts` (version lock),
`gear_publication_head`, `gear_catalog_publications` (append-only exact bytes, plus
`auth_aal`/`auth_amr`), `gear_publication_status`, `gear_storage_drift_acks`
(+ `device_acceptable`, `validation_error`) and `gear_audit_log`.

## 5. Credentials

| Where | Holds | Never holds |
|---|---|---|
| Admin page | Project URL, publishable key, the user's own JWT | secret keys, service-role JWT, DB URL |
| `gear-publish` (and upload functions) | A **dedicated** publisher secret key (`sb_secret_…`, sent only as `apikey`, per `fix/gear-publisher-secret-keys`); `SUPABASE_DB_URL` | anything returned or logged |
| Apps | Publishable key; catalog reads send no key | any write path |
| Repos / CI | Nothing secret (later, possibly a Pages-only Cloudflare token as an Actions secret) | Supabase keys |

Creating, rotating or disabling keys is **not** part of this work. It follows the migration.

## 6. Publishing across the database and Storage

Storage has no compare-and-swap. A row lock serializes publishers that use `gear-publish` and
nothing else. The design, simulated in the prototype and covered by tests:

1. **Reconcile first, under the lock.** Lock the head row, read the **authenticated origin**
   (never the CDN), and compare it with the latest recorded publication:
   - it matches → `verified`;
   - a previous upload never landed → re-send the identical recorded bytes;
   - anything else → **drift**, which blocks publishing.
2. **Stamp and record.** `publishedAt = max(now, head + 1, acknowledged valid foreign + 1)`, with
   a ±300 s clock guard. Write history (exact bytes) with status `recorded`.
3. **Upload while still holding the lock**, then read the origin back with a bounded retry.
   Record `verified`, `uncertain` or `conflict`. The upload timeout is shorter than the
   transaction's idle timeout.

### Drift acknowledgement cannot bypass validation or accept a far-future timestamp

- The foreign document goes through the **same validator** the apps use.
  - **Invalid:** devices reject it and keep their previous document. It is recorded as
    "not on devices"; its `publishedAt` is **not** used as a floor and it is not the review baseline.
  - **Valid:** devices may hold it. It becomes the **review baseline** (the Changes view and
    server checks diff against it, per review finding 3), its `publishedAt` becomes the stamping
    floor, and its revision counts as used.
  - **Valid with `publishedAt` more than 300 s in the future:** acknowledgement is **refused**
    (`drift_future_timestamp`), audited, and publishing stays blocked. Devices that took it
    reject every normal publication until that time, and superseding it would push the future
    timestamp further. This is an incident with three options, and Julian decides:
    - (a) restore the last recorded bytes to stop new devices taking it, as an explicit,
      audited incident action;
    - (b) publish a corrective document stamped after it, only if the time is near;
    - (c) an app change that caps accepted future skew.
- Acknowledgement only records what is in Storage. The **next publication still passes every
  check**: full validation, the successor check, images, approvals for Production, the clock
  guard, and the publisher with MFA. Tests cover an invalid candidate being refused after an
  acknowledgement.

### Prevention vs detection for direct Storage writes

The 5-minute scheduled verifier (`gear-verify`) is **detection, not prevention**. It compares
origins with the database, checks Storage logs for writes to `recommended-gear` not made by
`gear-publish`, and alerts. Prevention comes from these layers:

1. **No write policies** on `storage.objects` for `recommended-gear` for `anon` or
   `authenticated` (RLS denies by default). The migration's tests prove that anonymous and
   ordinary signed-in writes fail.
2. **One routine writer:** `gear-publish`, with its own dedicated secret key. `publish_catalog.py
   --upload` is retired, or made to call `gear-publish`.
3. **Fewer keys:** after the credential migration, follow its plan for legacy JWT keys, and keep
   no personal or long-lived secret keys for this bucket.
4. **Fewer people:** Supabase organization and project membership limited to Julian, with MFA on
   the dashboard account.

**Remaining privileged bypasses, which policies cannot stop, and how each is handled:**

| Bypass | Handling |
|---|---|
| Supabase dashboard upload by an org member (today: Julian) | Policy: emergencies only, then acknowledge in the admin; verifier alert |
| Any holder of a secret or service-role key (incl. a leaked one) | Key minimization (above); rotation per the migration plan; verifier alert |
| **Other Edge Functions in the same project** (price alerts, promo, referral, RevenueCat). Supabase injects default service keys into functions | To check: whether default key injection can be limited per function. If not, treat these functions as privileged writers: code review plus a CI check that no other function references `recommended-gear` |
| Direct SQL as `postgres` on `storage.objects` metadata | Same membership controls; audit logs |
| Supabase platform operators | Out of scope; accepted provider risk |

**Residual risk:** between a bypassing write and its detection (≤ 5 min plus alert latency), new
devices can receive that document. If it is valid, they keep it until the next publication. If it
is far-future, see the incident options above. The only real prevention against privileged writers
would be **signed catalogs**: `gear-publish` signs with a key no other writer has, and the apps
verify with a bundled public key. That is an iOS app change (and later Android), proposed as a
future option rather than part of this work.

## 7. Drafts, history, images

- **Drafts:** integer version lock, plus two review fixes:
  - edits typed while a save is in flight are kept;
  - retained edits keep their original base, so the next save shows the conflict instead of
    overwriting.

  There is no merge. With one publisher, conflicts come from two tabs or devices.
- **History:** append-only exact bytes, a separate append-only status log, and rollback as a new
  publication.
- **Images:** content-addressed, `upsert: false`, finalized with type sniffing and a dimension
  check, PNG/JPEG only (§1).

## 8. Future-dated seed and the proposed validator warning

Verified against the publisher's code: the supported publisher restamps `publishedAt`. The risk is
only a **raw upload** of `docs/remote-gear/catalog-v1.json` (stamped 2026-11-18). The
future-timestamp warning for `validate_catalog.py` stays a **separate proposed tooling change**
in the iOS repository. See `docs/proposals/validator-future-timestamp.md`. It is not part of this
PR, and nothing in the iOS repository was changed.

## 9. Public DNS for 85blends.app (read 2026-11-13; no changes made)

Queried over DNS-over-HTTPS through two independent resolvers (Google, Cloudflare). They agree.
The only differences were TXT quoting and DS hex case. All answers are DNSSEC-validated (AD).

| Record | Value |
|---|---|
| NS | `nse1`–`nse4.squarespacedns.com` |
| SOA | `nse1.squarespacedns.com`, contact `cloud-dns-hostmaster.google.com` |
| DS (in `.app`) | `56890 8 2 3FFC…2A13`: the zone is **DNSSEC-signed** |
| A (apex) | `185.199.108–111.153` (GitHub Pages addresses); no AAAA, no CAA |
| `www` | CNAME `julianf40-hub.github.io` |
| MX | `1 smtp.google.com` |
| TXT | `v=spf1 include:_spf.google.com ~all`, `google-site-verification=…` |
| `_dmarc` TXT | `v=DMARC1; p=none; pct=100` |
| `admin.85blends.app` | NXDOMAIN (unused) |
| `_github-pages-challenge-julianf40-hub` | NXDOMAIN |

**What this establishes:**
- The zone is **served by Squarespace's DNS service**.
- The site is **served by GitHub Pages**.
- Mail for the domain is **routed to Google**.
- The zone is signed (DNSSEC).
- `admin.` is free.

**What it does not establish:** the **registrar**, the **account owner**, or who controls the
Squarespace, Google or GitHub accounts. Those come from RDAP/WHOIS and the accounts themselves,
not from DNS.

**Implications for the plan:**
- The Pages `.pages.dev` URL needs **no DNS change**.
- Moving the zone to Cloudflare would mean coordinating the DS record (DNSSEC); done wrong, the
  whole domain fails to resolve. It is **not proposed**.
- A custom `admin.` name needs a CNAME at the current host. That is a DNS change and Julian's call.

**Observations outside this PR's scope**, reported only, with nothing changed:
- No GitHub Pages domain-verification TXT record is visible. GitHub recommends verifying custom
  domains, to prevent takeover if the Pages site is ever removed. It may be verified another way
  that I can't see from DNS.
- There is no CAA record and DMARC is `p=none`.

## 10. Review findings on PR #7 (Codex), all addressed

| Finding | Fix | Test |
|---|---|---|
| Edits typed while a save is in flight were replaced by the submitted snapshot | Send a snapshot; keep later edits (still "Unsaved"); disable double-submit | `tools/ui-regression.cjs` #1 |
| Retained edits took the newer base, so the next save overwrote another session | Keep the original base and show the remote-change notice; the save then gets 409 and the conflict dialog | #2 |
| After acknowledged drift, review and Changes compared against the recorded publication | A validated, acknowledged Storage document is the review baseline, labeled in the Changes view | #3 and `tests/server.test.mjs` |

All three were reproduced (failing) before the fix and pass after it.

## 11. Isolation and sequencing

This PR touches only `_admin-prototype/` on `claude/85blends-admin-gear-prototype-9v827z`. I
did not connect to, read or change any Supabase project, Cloudflare account, DNS record, key or
catalog, and no repository was created or moved.

Sequence:
1. The credential migration merges, and keys follow its plan.
2. Julian creates the private `85Blends-Admin` repository.
3. The §4 SQL is reviewed as a migration in `E85-Blends-App`.
4. It is applied to a **Supabase branch** only.
5. The functions are built and fault-tested there.
6. Staging, then Production.

## 12. Remaining blockers before any deployment

1. **Credential migration** (`feature/supabase-publishable-key-migration`,
   `fix/gear-publisher-secret-keys`) merged, and its key steps done. Only then create the
   dedicated publisher key.
2. **`85Blends-Admin` private repository** created by Julian. The prototype is moved there
   deliberately, not by this PR.
3. **Migration review and a Supabase branch.** Branching is Pro/Team only, at $0.01344 per
   branch-hour; the current plan was not checked.
4. **Real Auth:** TOTP enrolled for Julian, MFA on the Supabase dashboard account, and
   `enable_signup` confirmed off on the live project.
5. **`gear-publish`, upload, finalize and verify functions** built and fault-tested against real
   Storage on a branch: uncertain uploads, origin read-back delay, lock timeouts.
6. **Default Edge Function key exposure** checked (§6). The other functions in the project
   are reviewed or isolated.
7. **Far-future incident policy** decided (§6, options a–c).
8. **Alert channel** for the verifier chosen.
9. **Hosting set up by Julian:** a Cloudflare account, the Pages project, an Access policy that
   covers previews, and the choice between `.pages.dev` and a custom domain (DNS change).
10. **The iOS client ships.** The remote-catalog code is not release-ready per its README.
    Production publishing reaches users only once a build containing it is installed. App Store
    availability is unverified.
11. **Never upload the seed raw** (§8). The first Production publication goes through `gear-publish`.
12. Optional, not blocking: HEIF support (needs server-side decoding), signed catalogs (an app
    change), and the validator warning proposal.

## 13. Verification in this session

- `node --test _admin-prototype/tests/*.test.mjs`: **51 pass**. Covers the ported validator,
  model, simulated auth/MFA/Origin, the draft lock, publisher-only publishing, the approval gate,
  stale reviews, serialized publishing, rollback, the clock guard, uploads (incl. HEIF refusal),
  headers, crash / uncertain / bypass / older-file failure modes, and drift acknowledgement
  (invalid, valid baseline, far-future refused).
- `node _admin-prototype/tools/ui-regression.cjs`: 4 / 4 pass in Chromium. The 3 review findings
  and HEIF all failed before the fixes.
- `node _admin-prototype/tools/parity.mjs <E85-Blends-App>`: 166 / 166 agree.
- `_admin-prototype/tools/verify-pages-exclusion.sh`: PASS on this branch.
- Site checks unchanged: `node --test tests/fuel-math.test.cjs`, `python3 tests/check-site.py`.
- **Not run:** anything against Supabase, Cloudflare, Deno, a CDN, real Storage or the apps.
