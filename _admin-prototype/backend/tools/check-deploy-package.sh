#!/usr/bin/env bash
# Runtime check of the DEPLOYMENT package on a LOCAL stack built only from it (fictional data):
#   1. rebuild check: deploy/package must equal a fresh build;
#   2. stop the development stack; start .deploy-check/ = package migration + package functions,
#      plus the local fictional seed (test data only; not part of the package) and local config
#      WITHOUT the legacy function and WITHOUT the test-fault switch;
#   3. run the current-design tests against it (fault-dependent tests skip themselves; package-only
#      checks run), and record its schema inventory;
#   4. restore the development stack and record its inventory; write deploy/schema-comparison.md.
# Never touches a hosted project.
set -euo pipefail
cd "$(dirname "$0")/.."
BACKEND="$PWD"
export SUPABASE_INTERNAL_IMAGE_REGISTRY="${SUPABASE_INTERNAL_IMAGE_REGISTRY:-docker.io}" GEAR_LOCAL_JWT_EXPIRY=3600
node tools/build-deploy-package.mjs --check
W="$BACKEND/.deploy-check"
rm -rf "$W" && mkdir -p "$W/supabase/migrations" "$W/supabase/functions"
cp deploy/package/migrations/*.sql "$W/supabase/migrations/"
cp -R deploy/package/functions/. "$W/supabase/functions/"
cp supabase/seed.sql "$W/supabase/seed.sql"
# Local config without the legacy demo function and without GEAR_ALLOW_TEST_FAULTS.
node -e '
  const fs = require("fs");
  let c = fs.readFileSync("supabase/config.toml", "utf8");
  c = c.replace(/\n# Superseded Storage publication path[^\n]*\n\[functions\.gear-legacy-storage-demo\]\nenabled = true\nverify_jwt = true\n/, "\n");
  c = c.replace(/^GEAR_ALLOW_TEST_FAULTS = .*\n/m, "");
  if (/gear-legacy-storage-demo|^GEAR_ALLOW_TEST_FAULTS\s*=/m.test(c)) { console.error("config still enables the legacy function or test faults"); process.exit(1); }
  fs.writeFileSync(process.argv[1], c);' "$W/supabase/config.toml"
OUT="${1:-$BACKEND/.deploy-check-results}"; mkdir -p "$OUT"

supabase stop >/dev/null 2>&1 || true
( cd "$W"
  GEAR_LOCAL_SECRET_KEY=unset supabase start >/dev/null
  GEAR_LOCAL_SECRET_KEY="$(supabase status -o json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).SECRET_KEY))')"
  export GEAR_LOCAL_SECRET_KEY
  supabase stop >/dev/null && supabase start >/dev/null )
set +e
GEAR_PACKAGE_CHECK=1 GEAR_SUPABASE_WORKDIR="$W" node --test --test-concurrency=1 \
  tests/foundation.test.mjs tests/review_images.test.mjs tests/db_pointer.test.mjs tests/operations.test.mjs tests/package_mode.test.mjs > "$OUT/package-tests.tap" 2>&1
STATUS=$?
set -e
( cd "$W" && supabase db reset >/dev/null 2>&1 ) && node tools/schema-inventory.mjs "$W" > "$OUT/inventory-package.json"
( cd "$W" && supabase stop >/dev/null )
tools/start-local.sh >/dev/null
supabase db reset >/dev/null 2>&1 && node tools/schema-inventory.mjs "$BACKEND" > "$OUT/inventory-dev.json"
node tools/compare-inventories.mjs "$OUT/inventory-dev.json" "$OUT/inventory-package.json" > deploy/schema-comparison.md
grep -E '^# (tests|pass|fail|skipped)' "$OUT/package-tests.tap"
exit $STATUS
