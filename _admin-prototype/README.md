# 85Blends Admin — Recommended Gear (local prototype)

A private-admin prototype for editing the Recommended Gear catalog. **Local only. Fictional data.
Sign-in, roles, MFA and publishing are all simulated.** It never contacts Supabase or any other
host, holds no keys, and does not change any catalog the apps read. The preview approximates the
**iOS** screens from source; **Android does not read this catalog yet.**

```sh
node _admin-prototype/server.mjs            # http://127.0.0.1:4174  (PORT=… to change)
node _admin-prototype/server.mjs --reset    # start again from the fictional seed
node --test _admin-prototype/tests/*.test.mjs
node _admin-prototype/tools/parity.mjs /path/to/E85-Blends-App   # JS port vs Python reference
_admin-prototype/tools/verify-pages-exclusion.sh                  # reproduce the Pages build; prove exclusion
node _admin-prototype/tools/ui-regression.cjs                     # browser checks (Playwright), server running
```

The live implementation is planned for a separate **private** repository, `85Blends-Admin`
(not created yet; see `IMPLEMENTATION_PLAN.md`). This folder is for review only.

Node 20+ and a modern browser. No dependencies or build step, like the rest of this repository.
State (draft, simulated publications, history, uploads, audit log) is written to
`_admin-prototype/.local-state/`, which git ignores. **The folder name starts with `_` on purpose:**
GitHub Pages (Jekyll) skips it. This was verified by reproducing the live Pages build
(`tools/verify-pages-exclusion.sh`; evidence in `IMPLEMENTATION_PLAN.md` §2). The repository is
public, so the source is still readable on GitHub. The real admin must be hosted separately.

## What you can try

1. Choose a **simulated** account. The proposed operating model has one publisher (Julian); the
   optional editor account can draft but not publish. Untick **Simulated MFA (aal2)** to see
   writes refused.
2. Edit cards: copy, links, logo and product images (PNG/JPEG upload; HEIF/HEIC is disabled), price, offer and its
   window, visibility, order (drag or arrows), More placement and subtitle, and the sponsor's
   links and wheels. Errors appear inline with the same rules the apps apply.
3. **Preview**: Recommended Gear and More in light/dark/OLED, narrow, accessibility text size, at
   any device time (offer windows), for the draft or either live catalog.
4. **Changes**: a before/after summary against live Production or Staging.
5. **Save draft** (Ctrl/⌘ S). *Prototype tools → Simulate a draft save from another tab or
   device*, then save your own edit to see the conflict dialog.
6. **Publish**: Staging and Production are separate panels, and both are publisher-only. Production
   also needs every visible card's partner approval, a reviewed summary and a typed
   confirmation. Northwind Sensors starts as `pending`, so Production is blocked until you approve it.
7. **Failure modes** (*Prototype tools*): crash after the database commit, upload timeout,
   lost upload response, a CLI publish that bypasses the lock, an older file re-uploaded, an
   invalid file, and a far-future file. See the Storage line in each publish panel, **Reconcile
   now** and **Acknowledge drift**. Acknowledgement validates the Storage document first and
   refuses a far-future `publishedAt`.
8. **History**: every simulated publication with its Storage status, and rollback as a new publication.
9. **JSON**: the exact document layout the publisher would write.

## Layout

| Path | Purpose |
|---|---|
| `lib/validator.mjs` | JS port of `tools/remote-gear/validate_catalog.py` (E85-Blends-App `e6c42ed`). One module for browser, server and future Edge Functions. |
| `lib/resolve.mjs` | What each screen shows for a catalog at a time (mirrors `GearCatalog.content(at:)`). |
| `lib/diff.mjs` | Before/after change summary. |
| `lib/capabilities.mjs` | What the admin can change vs. what needs an iOS release (and future Android work). |
| `lib/images.mjs` | Content-addressed image naming. |
| `server.mjs` | Stand-in for the planned Supabase Auth + RLS + Edge Functions; enforces every server-side rule. |
| `public/` | The editor UI (vanilla ES modules, strict CSP, no inline scripts or styles). |
| `contract/catalog-v1.schema.json` | Byte-identical copy of the v1 schema; `tools/parity.mjs` checks it. |
| `data/` | Fictional seed catalogs and placeholder images (`tools/make_fictional_data.py`). |
| `tests/` | Validator cases ported from Python, model, server-rule and static security tests. |

The only real identifier in the data is `rvp-supply-oem-beadlocks`: the v1 contract reserves it for
the sponsor layout, so the sponsor entry uses it with placeholder copy and example.com links.
Bundled wheel IDs are used so the ring layout can be previewed; the preview never shows real artwork.
