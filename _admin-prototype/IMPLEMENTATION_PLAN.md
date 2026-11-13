# Recommended Gear Admin: plan for connecting it securely

Status: **plan only.** Nothing here has been migrated, deployed, published or configured. The
prototype in this folder is local, uses fictional data, and simulates sign-in, roles, MFA and publishing.
Every step that touches Supabase, credentials, hosting or another repository needs Julian's
go-ahead. None should start until the active credential migration has landed (§10).

Inputs, read-only, from `julianf40-hub/E85-Blends-App` `main` at `e6c42ed`:
`docs/remote-gear/{README,PUBLISHING_DASHBOARD,STAGING_SETUP}.md`, `catalog-v1.schema.json`,
`catalog-v1.json`, `tools/remote-gear/*` and tests, `EightyFiveBlends/GearCatalog.swift`,
`RecommendedGearView.swift`, `MoreView.swift`, `supabase/config.toml` and `supabase/functions/_shared`.
I also read `fix/gear-publisher-secret-keys` and `feature/supabase-publishable-key-migration` and
did not change them. **The Android repository was not inspected.**

---

## 0. Proposed initial operating model

| Rule | Prototype behavior |
|---|---|
| Julian is the only publisher | One simulated publisher account. An optional "editor" account exists only to show that non-publishers can draft but not publish |
| MFA required | Every write requires a simulated `aal2`. Untick "Simulated MFA" and writes are refused |
| Publishers only for Staging | Staging **and** Production publishing, rollback, reconcile and drift acknowledgement require the publisher role |
| Single-person Production approval | Production needs: server checks pass, every visible card's partner approval recorded, "I reviewed the before/after summary" ticked, and `PUBLISH PRODUCTION` typed. No second approver |

With a single publisher, review relies on the change summary and the Staging preview on an iOS
TestFlight build. The Production panel warns when the exact draft version has not been on Staging.
Adding a second person later only needs a role row and an approval step in `gear-publish`.

## 1. Platform scope and the catalog contract (unchanged)

- **iOS:** the remote catalog client is the 2.4.1 code on iOS `main`. Its own README says "not
  built or tested in Xcode ... not release ready", and I did not verify App Store availability.
  The admin's preview is a web approximation of those SwiftUI screens, written from source: it is
  not a screenshot, a build, or a guarantee. It does not reproduce SF fonts and Dynamic Type
  metrics, exact spacing, bundled artwork, eFlexFuel/RVP styling, VoiceOver, image limits and
  fallbacks, carousel behavior, or the app's caching and ordering rules. The final check is an
  iOS TestFlight build with Staging selected (iOS `STAGING_SETUP.md` §5).
- **Android does not read this catalog.** The iOS docs list what an Android client *would* have
  to implement. Nothing in the admin represents Android, and no Android layout is designed. The
  UI says this in the preview, the publish panels and the capability list.
- The admin edits **data inside catalog v1**: no schema change, no new fields or kinds.
  `lib/validator.mjs` ports `validate_catalog.py` rule for rule. `tools/parity.mjs` runs both on
  166 documents with **0 mismatches**, and the vendored schema is byte-identical. Dashboard-only
  data (approvals, notes) is stored beside the catalog and never published.

### Requires an iOS release (and Android work once Android supports the catalog)

| Request | Why the admin can't do it |
|---|---|
| New card layout or kind | v1 apps skip unknown kinds; needs SwiftUI (and future Compose) work, then an optional v1 field or `catalog-v2.json` alongside v1 |
| Second sponsor or a different sponsor layout | One `rvp_wheels`, reserved id |
| Badges, "Sponsored by …", empty state, section titles | Fixed app copy |
| Colors, fonts, per-brand themes, eFlexFuel-style treatment for others | Native styling keyed by stable ID |
| Bundled artwork for a new ID | App assets; until then use remote images |
| Percent-off, non-USD, several offers, sponsor offers | v1 offer is one whole-USD amount on a `brand` |
| Separate More order or More-only entries | More follows catalog order |
| Sections, search, targeting, per-platform content | Every device gets the same document |
| Rich text, video, animation | Plain text; PNG/JPEG/HEIF |
| Ring with other than nine wheels | Ring is designed for nine; others use the grid |
| In-app deep links, non-https links | https only |

## 2. GitHub Pages: verified exclusion, and why the real admin is hosted elsewhere

**Evidence:**

| Check | Result |
|---|---|
| How the live site is built | GitHub's built-in "pages build and deployment" from `main` (run 39396525694, 2026-10-20). Builder `ghcr.io/actions/jekyll-build-pages:v1.0.13` = github-pages gem **v232**, Jekyll **3.10.0**, `Configuration file: none`, `source: .` |
| Repo conditions | No `.nojekyll`, no `_config.yml`, no `.github/workflows`. All three are checked on `main` and on the branch |
| Control: local build of `main` with the same gem set | **Identical** to the 54-entry file list of the live artifact in that run's log |
| Local build of this branch | **Identical** output to `main`; **0** `_admin-prototype` files |
| Negative control: the same folder without the `_` | **37 files published**, including `server.mjs`, `IMPLEMENTATION_PLAN.html` and `index.html` (rendered from README) |

`tools/verify-pages-exclusion.sh` repeats the whole check. Note what the live log also shows:
every folder Jekyll keeps is deployed, including today's `tests/`, `scripts/` and `docs/`.

**Limits of this evidence:**
- Exclusion depends on Jekyll staying on. Adding `.nojekyll`, adding a `_config.yml` `include:` for
  the folder, or switching to a custom Actions workflow that uploads the repository would publish
  it. The script fails on all three.
- After merge, confirm with `curl -sI https://85blends.app/_admin-prototype/README.md` (expect 404).
  That isn't meaningful before merge.
- This repository is **public**: the prototype source is readable on GitHub whether or not Pages
  serves it. That is acceptable only because it holds no secrets and only fictional data.
- Private Pages sites require GitHub Enterprise Cloud, so the real admin cannot be a private
  Pages site of this repo (§9).

## 3. Authentication (proposed)

- Supabase Auth on the existing project, invite-only. The apps don't use Supabase Auth, and the
  checked-in `supabase/config.toml` has `enable_signup = false` (confirm on the live project before
  relying on it). Authorization never depends on being signed in, only on `gear_admins`.
- Email magic link + **mandatory TOTP MFA**. TOTP is included on all Supabase plans; phone MFA is a
  paid add-on and not needed. `aal2` is checked in RLS **and** in every function.
- 1 h access tokens with refresh rotation. Re-authenticate before Production publishing if the
  session is older than ~15 min.
- The JWT goes in `Authorization: Bearer` (no cookies). Functions also check `Origin`.

## 4. Authorization (proposed SQL, for review only: not applied anywhere)

```sql
create table public.gear_admins (
  user_id uuid primary key references auth.users on delete cascade,
  role text not null check (role in ('editor', 'publisher')),
  added_by uuid references auth.users, added_at timestamptz not null default now()
);
create or replace function private.gear_role() returns text language sql stable security definer
  set search_path = '' as $$
  select a.role from public.gear_admins a
  where a.user_id = auth.uid() and coalesce(auth.jwt() ->> 'aal', '') = 'aal2' $$;

create table public.gear_catalog_drafts (
  id text primary key default 'main', catalog jsonb not null, meta jsonb not null default '{}',
  version integer not null default 1,
  updated_by uuid not null references auth.users, updated_at timestamptz not null default now());

-- Monotonic stamping floor per target; may run ahead of Storage until an upload is verified (§6).
create table public.gear_publication_head (
  target text primary key check (target in ('staging', 'production')),
  revision uuid, published_at bigint, digest text);

-- Append-only history: exact bytes, never updated.
create table public.gear_catalog_publications (
  id uuid primary key default gen_random_uuid(),
  target text not null check (target in ('staging', 'production')),
  revision uuid not null unique, published_at bigint not null,
  document text not null, digest text not null, summary text not null,
  draft_version integer, rollback_of uuid references public.gear_catalog_publications,
  validator_version text not null, published_by uuid not null references auth.users,
  created_at timestamptz not null default now(), unique (target, published_at));

-- Storage outcome is a separate append-only log: recorded | verified | uncertain | conflict.
create table public.gear_publication_status (
  id bigserial primary key, publication_id uuid not null references public.gear_catalog_publications,
  status text not null check (status in ('recorded', 'verified', 'uncertain', 'conflict')),
  note text, at timestamptz not null default now());

-- A publisher's acknowledgement of Storage contents that no publication recorded (§6).
create table public.gear_storage_drift_acks (
  id bigserial primary key, target text not null, digest text not null, foreign_revision text,
  foreign_published_at bigint, acknowledged_by uuid not null references auth.users,
  at timestamptz not null default now());

create table public.gear_audit_log (id bigserial primary key, at timestamptz not null default now(),
  actor uuid, event text not null, detail jsonb not null default '{}');

-- RLS on every table above; admins (aal2) may SELECT drafts, history, status, heads, acks.
-- No INSERT/UPDATE/DELETE policies for anon or authenticated anywhere: drafts are saved via
-- save_gear_draft(); everything else is written only by the gear-publish function.
```

`save_gear_draft(expected_version, catalog, meta)` (security definer; caller must have an
aal2 role) does `UPDATE … WHERE id = 'main' AND version = expected_version`. Zero rows means 409
with the current draft. Revision and `publishedAt` are never accepted from the browser.

| Action | editor (optional, future) | publisher (Julian) | Enforced by |
|---|---|---|---|
| Read draft, history, status | ✓ aal2 | ✓ aal2 | RLS |
| Save draft, upload images | ✓ | ✓ | RPC / `gear-upload-url` |
| Publish Staging or Production, roll back, reconcile, acknowledge drift | — | ✓ (+ typed confirmation for Production) | `gear-publish` |
| Manage admins | — | owner via SQL only | no API |

The `recommended-gear` bucket keeps public read and **no** write policies for `anon` or
`authenticated` (as `STAGING_SETUP.md` documents).

## 5. Credentials (proposed)

| Where | Holds | Never holds |
|---|---|---|
| Admin page (browser) | Project URL, **publishable key** (public by design, for Auth), the user's own JWT | secret keys, service-role JWT, DB URL |
| `gear-publish`, `gear-upload-url` | A **dedicated** publisher secret key (`sb_secret_…`, function secret), sent only as `apikey` (the convention on `fix/gear-publisher-secret-keys`); `SUPABASE_DB_URL` (already used by existing functions) | anything returned or logged |
| Apps | publishable key; catalog reads send **no** key | any write path |
| Repos / CI | nothing secret; secret scanning on | keys |

A dedicated key can be revoked on its own. **Creating or rotating keys is not part of this work.**
It happens after the migration lands, by its procedure. `tests/security.test.mjs` already fails on
key-shaped strings, Supabase hosts in browser code, or a network client in the prototype server.

## 6. The publish lock across the database and Storage: review

### What a database lock does and does not give

Supabase Storage has no compare-and-swap. A row lock serializes **publishers that go through
`gear-publish`**. It does not make the Storage write atomic with the database commit, does not
stop writers that never take the lock, and does not tell us what Storage holds after an uncertain
upload. The earlier proposal (commit history and head, release, then upload) has these failure
modes:

| # | Scenario | What goes wrong with "commit, then upload" |
|---|---|---|
| F1 | Function crashes after commit, before upload | Head says B, Storage still holds A. Nothing notices until someone looks |
| F2 | Upload times out / connection drops | B may or may not be stored. Retrying "later" without the lock races the next publish |
| F3 | Two publishes; A's upload is slow, B commits and uploads, then A's upload lands | Storage reverts to older A ("zombie" write). New devices get A; devices holding B reject A as stale (safe for them) |
| F4 | Stale reads | Reading the **public** URL can return a CDN copy up to `max-age` old. Right after an overwrite, Storage's own origin can briefly serve the previous object (the reason for the read-back retries on `fix/gear-publisher-secret-keys`) |
| F5 | Writers that bypass the lock: `publish_catalog.py --upload` (staging), a Supabase-dashboard upload, a future script | Storage holds bytes no publication recorded. Next stamp may not be newer than what devices accepted, or a withdrawal may be undone |
| F6 | Lock released by a timeout while the holder is still uploading | Same as F3 |

### Revised design (proposed; simulated in the prototype)

1. **Reconcile first, under the lock.** `gear-publish` opens a transaction on `SUPABASE_DB_URL`
   and locks the `gear_publication_head` row (`FOR UPDATE`, `lock_timeout` 5 s). It then reads the
   **authenticated origin** (never the public CDN URL) and compares digests with the latest
   recorded publication:
   - match → `verified`;
   - latest is `recorded`/`uncertain` and origin still holds the previous publication (or
     nothing) → the upload never landed: **re-send the identical recorded bytes** (devices treat
     identical bytes as "unchanged") and verify;
   - anything else → **drift** (F3, F5, F6): publishing is blocked. Reconcile never overwrites
     drift by itself; a person decides.
2. **Drift acknowledgement.** The publisher reviews the foreign document. Acknowledging records
   its digest, revision and `publishedAt`. The next publication must be stamped **newer than the
   foreign `publishedAt`**, must not reuse its revision, and is successor-checked against it,
   because devices may already hold it.
3. **Stamp and record.** `publishedAt = max(now, head + 1, acknowledged foreign + 1)`, with the
   ±300 s clock guard. Insert history (exact bytes) and status `recorded`, advance the head. The
   head is the monotonic floor even if Storage lags, so a crash can't cause a timestamp reuse.
4. **Upload while still holding the lock**, then read back the origin with the bounded retry from
   the secret-keys branch. Record `verified`, `uncertain` (timeout or ambiguous) or `conflict`.
   Commit, which releases the lock.
5. **Bound the lock.** The upload uses an abort timeout (e.g. 20 s) **shorter** than the
   transaction's `idle_in_transaction_session_timeout` (e.g. 60 s). A crashed function's connection
   closes and Postgres releases the lock. The residual zombie window (F6: a write still in flight
   after its connection died) is caught by step 1 of the next publish and by step 6.
6. **Scheduled verifier.** Every 5 minutes, read each origin, compare it with the latest
   recorded publication, and alert on `uncertain` older than 5 minutes or any drift. Read-only.
7. **One writer path per target.** Retire `publish_catalog.py --upload` once `gear-publish`
   handles Staging, or make it call the function. Keep the publisher secret key only in function
   secrets. Treat dashboard uploads as an emergency procedure that is followed by an
   acknowledgement. Detection (1, 6) is the backstop, because Storage can't refuse these writers.

**Residual risk:** between a bypassing write (or zombie) and the next reconcile or verifier run (up
to 5 minutes), new devices can receive the wrong document. Devices that already hold a newer
publication reject an older one as stale, and every reconcile restores consistency. A
device-side fix (e.g. a signed document) would be an app change and is out of scope.

**Simulated in the prototype:** status log, reconcile, drift detection and acknowledgement,
upload under the lock, and injectable faults (*Prototype tools*: crash after commit, upload
timeout, lost response, CLI publish, older file re-uploaded). Covered by `tests/server.test.mjs`.

## 7. Drafts, history, images

- **Drafts:** an integer version lock. On conflict the UI shows "their changes" and "your
  changes", with "load theirs" or "save mine over theirs". There is no merge. With one publisher,
  conflicts come from two tabs or devices. Polling every 10 s, or Supabase Realtime later.
- **History:** append-only exact bytes, plus a separate append-only status log. Rollback is a
  new publication of old content (new revision, newer `publishedAt`, approvals re-checked).
- **Images:** content-addressed `images/<brand>/<sha256>.<ext>`, created with `upsert: false`, never
  overwritten. A finalize step sniffs the type and reads dimensions. HEIF needs a real decoder
  server-side, or should be disallowed until one exists.

## 8. The future-dated seed: verified against the publisher

`docs/remote-gear/catalog-v1.json` has `publishedAt: 1794960000` (2026-11-18T00:00Z), about 4.6
days after 2026-11-13. I ran `publish_catalog.prepare()` from `main` **and**
`fix/gear-publisher-secret-keys` offline, with simulated responses and no network calls:

| Path | Result |
|---|---|
| **Supported publisher**, seed as template, nothing live | `stamp()` **ignores** the template's `publishedAt` and stamps `max(now, live + 1)` = now. **No problem.** |
| **Raw upload** of the unchanged seed (e.g. Supabase dashboard, iOS README §4 manual workflow) | Allowed: `validate_catalog.py` has no future-time check, so it prints OK |
| …then the supported publisher | Refuses: "live publishedAt … is more than 300 s in the future" |
| …then a manual upload stamped "now" | Validator and devices reject it: "publishedAt is older than the live publication" |

The risk is therefore limited to **raw uploads**. The supported publisher is safe, but it is
**staging-only**. Production has no supported publisher today, so its first publication would
follow the manual iOS README §4 workflow, which tells the operator to set `publishedAt` by hand.
Mitigations: never upload the seed file as-is; publish through the (future) `gear-publish`; and
optionally add a future-time warning to `validate_catalog.py` (a small change in the iOS repo,
not made here).

## 9. Hosting options and costs (proposed; nothing set up)

The admin is a static page. Security comes from Supabase Auth, RLS and the functions, so the host
only needs HTTPS, custom headers (CSP) and ideally an access gate in front of the page.

| Option | Access gate in front of the page | Cost for one admin | Notes |
|---|---|---|---|
| **A. Cloudflare Pages + Cloudflare Access** (recommended) | Yes: email/OTP or SSO before the page loads | **$0** (Pages Free: 500 builds/mo; Zero Trust Free up to 50 users; $7/user/mo beyond) | Gating a custom domain normally requires that domain's DNS to be on Cloudflare; otherwise gate the `*.pages.dev` URL. Check where 85blends.app DNS lives |
| B. Netlify | Basic site password on **Pro ($20/mo)**; not on Free/Personal; team login is Enterprise | $0 without gate, $20/mo with password | Fine as a plain static host |
| C. Vercel | Password Protection is a Pro add-on (**$20/project/mo** on top of Pro **$20/seat/mo**) | $40/mo with gate | Hobby is limited to personal/non-commercial use, so not suitable |
| D. GitHub Pages (this or a new repo) | Private Pages only on GitHub Enterprise Cloud | — | Not suitable: public |
| E. Local only (`node server.mjs` on Julian's Mac) for real use | n/a | $0 | Workable for one person, but needs a real backend anyway; no gain over A |

Supabase (existing project; current plan not checked, by design):
- Edge Function invocations: 500k on Free, 2M on Pro ($25/mo). Admin usage is negligible.
- TOTP MFA is included on all plans.
- Branching is Pro/Team only, at **$0.01344 per branch-hour** (about $2.26 for a week-long test branch).
- Catalog and image egress is small. Pro includes 250 GB; Free includes 5 GB cached egress.

**Recommendation: option A** (expected incremental cost about $0/month), with Supabase Auth + MFA
as the real boundary and Access as defense in depth. Plus short-lived branch hours during
testing, if the project is on Pro. Prices are from the vendors' pricing pages, read 2026-11-13.
Re-check them before committing.

## 10. Isolation and sequencing

- This work touched only `_admin-prototype/` in the website repository, on
  `claude/85blends-admin-gear-prototype-9v827z`. I did not connect to, read or change any Supabase
  project, bucket, key, Auth setting, function or catalog. The iOS repository was cloned read-only.
- Sequence: the migration PRs merge and keys follow their plan → review the §4 SQL as a migration
  in `E85-Blends-App/supabase/migrations/` → apply it to a **Supabase branch** only → create the
  dedicated publisher key there → only then consider the live project.

## 11. Rollout (each step needs Julian's go-ahead)

| Phase | Work | Exit gate |
|---|---|---|
| 0 (this PR) | Simulated prototype + plan | Review |
| 1 | Choose hosting (§9) and where the UI code lives | Decision recorded |
| 2 | Migration + RLS + `save_gear_draft` on a Supabase branch | Clean replay; non-admin writes fail |
| 3 | `gear-publish` (§6), `gear-upload-url`/finalize, verifier, on the branch | Fault tests (§6) pass against real Storage on the branch |
| 4 | Private hosting against the branch, then Staging on the live project; retire CLI `--upload` | Staging shows on an iOS TestFlight build |
| 5 | Production (first publication through `gear-publish`, never a raw seed upload; §8) | Rollback and drift rehearsed on Staging |
| — | Android | Separate project: implement the client per the iOS docs first |

## 12. Decisions for Julian

1. Hosting: option A (recommended) or another; where 85blends.app DNS is managed.
2. Where the admin UI code lives long-term (a private repo is recommended; this PR is review-only).
3. Confirm the operating model in §0, including no second approver for Production.
4. HEIF uploads before a server-side decoder exists: allow or not.
5. Whether to add a future-time warning to `validate_catalog.py` (iOS repo).

## 13. Verification in this session

- `node --test _admin-prototype/tests/*.test.mjs`: validator (ported), model, server rules
  (simulated auth/MFA/Origin, If-Match, publisher-only publishing, approval gate, stale reviews,
  serialized publishing, rollback, clock guard, uploads, headers) and the §6 failure modes.
- `node _admin-prototype/tools/parity.mjs <E85-Blends-App>`: 166 documents, 0 mismatches.
- `_admin-prototype/tools/verify-pages-exclusion.sh`: PASS (54 entries, identical to `main`).
- Site checks unchanged: `node --test tests/fuel-math.test.cjs`, `python3 tests/check-site.py`.
- A headless Chromium walkthrough produced the screenshots in `docs/screenshots/`.
- **Not run:** anything against Supabase, Deno, a CDN, a real Storage bucket or the apps.
