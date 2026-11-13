# Proposal: future-timestamp warning in `validate_catalog.py` (separate tooling change)

Status: **proposal only.** It targets `julianf40-hub/E85-Blends-App`
(`tools/remote-gear/validate_catalog.py` and its tests). Nothing in that repository has been
changed. It would ship as its own small PR there. It is not part of the admin prototype PR, and
the admin does not depend on it.

## Problem (verified 2026-11-13)

- `docs/remote-gear/catalog-v1.json` has `publishedAt: 1794960000` (2026-11-18T00:00Z).
- The supported publisher (`publish_catalog.py`, staging-only) ignores a template's
  `publishedAt` and stamps `max(now, live + 1)`, so it is not affected.
- A **raw upload** of the file (Supabase dashboard; the manual workflow in
  `docs/remote-gear/README.md` §4, currently the only route to Production) is accepted by
  `validate_catalog.py` with `OK`. Afterwards:
  - the publisher refuses to publish ("live publishedAt … more than 300 s in the future");
  - conforming clients that accepted it reject any later document stamped earlier than 2026-11-18 as stale.

## Proposed change

A **warning** (not a rejection): the apps accept future timestamps, and the validator must keep
mirroring the client acceptance rules exactly.

```python
FUTURE_WARNING_SECONDS = 300  # same bound as publish_catalog.MAX_FUTURE_SKEW

def timing_warnings(document: dict, now: float) -> list[str]:
    published = document.get("publishedAt")
    if timestamp(published) and published > now + FUTURE_WARNING_SECONDS:
        return [f"publishedAt {int(published)} is {int(published - now)} s in the future: after this is live, "
                "every publication stamped earlier is rejected by devices and refused by the publisher. "
                "Publish with publish_catalog.py (it stamps the time), or set publishedAt to the current time."]
    return []
```

- `main()` prints these after the existing warnings. `--strict-time` (optional) makes them exit 1,
  for CI and for the manual Production workflow.
- Exit status without `--strict-time` is unchanged, so existing callers and tests keep working.
- Tests: a document stamped `now + 301` warns; one stamped `now + 299` doesn't; the seed warns
  until 2026-11-18; and with `--strict-time` the future document exits 1.
- README §4 step 2: add `--strict-time` to the documented command.

The JS port in the admin (`lib/validator.mjs`) needs nothing extra. `gear-publish` already
refuses a live or acknowledged `publishedAt` more than 300 s ahead.
