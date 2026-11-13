#!/usr/bin/env bash
# Serves the admin UI in LOCAL SUPABASE mode against the running local stack (tools/start-local.sh).
# Only the loopback API URL and the local PUBLISHABLE key reach the page; server.mjs refuses anything else.
set -euo pipefail
cd "$(dirname "$0")/.."
status="$(supabase status -o json)"
read_key() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s)[process.argv[1]]))' "$1" <<<"$status"; }
export GEAR_SUPABASE_URL="$(read_key API_URL)"
export GEAR_SUPABASE_PUBLISHABLE_KEY="$(read_key PUBLISHABLE_KEY)"
exec node ../server.mjs --backend=local-supabase
