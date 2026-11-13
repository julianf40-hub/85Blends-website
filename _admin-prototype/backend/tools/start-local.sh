#!/usr/bin/env bash
# Starts the LOCAL stack and hands gear-publish the local new-style secret key (sb_secret_…) through
# an environment variable, so no key is ever written to a committed file. Fictional data only.
set -euo pipefail
cd "$(dirname "$0")/.."
export SUPABASE_INTERNAL_IMAGE_REGISTRY="${SUPABASE_INTERNAL_IMAGE_REGISTRY:-docker.io}"
# Access-token lifetime in seconds (local only). The integration suite needs the default; the
# browser run sets 60 to exercise real expiry: GEAR_LOCAL_JWT_EXPIRY=60 tools/start-local.sh
export GEAR_LOCAL_JWT_EXPIRY="${GEAR_LOCAL_JWT_EXPIRY:-3600}"
supabase stop >/dev/null 2>&1 || true
# The local key is only known once the stack has started, so start once, read it, then restart.
GEAR_LOCAL_SECRET_KEY=unset supabase start >/dev/null
GEAR_LOCAL_SECRET_KEY="$(supabase status -o json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).SECRET_KEY))')"
export GEAR_LOCAL_SECRET_KEY
case "$GEAR_LOCAL_SECRET_KEY" in sb_secret_*) ;; *) echo "local SECRET_KEY is not an sb_secret_ key" >&2; exit 1 ;; esac
supabase stop >/dev/null
supabase start >/dev/null
echo "local stack running; gear-publish uses the local sb_secret_ key; access tokens last ${GEAR_LOCAL_JWT_EXPIRY} s"
