#!/usr/bin/env bash
# Reproduces the GitHub Pages build of this repository locally and proves _admin-prototype/ is not
# in the deployed output. Read-only: builds into a temporary directory, deploys nothing.
#
#   _admin-prototype/tools/verify-pages-exclusion.sh [ref]     (default: HEAD)
#
# Why a reproduction: the live site is built by GitHub's "pages build and deployment" workflow
# with ghcr.io/actions/jekyll-build-pages:v1.0.13 (github-pages gem v232, Jekyll 3.10.0,
# "Configuration file: none"), source ".", from main. Jekyll excludes paths starting with "_"
# unless a _config.yml `include:` lists them, and the whole build is skipped (so "_" folders ARE
# served) if a .nojekyll file exists or Pages is switched to a custom Actions workflow. This script
# checks those conditions, builds `main` and the ref with the same gem set, and compares.
# Requires Ruby + Bundler; the gems install into the temporary directory.
set -euo pipefail
ref="${1:-HEAD}"
repo="$(git rev-parse --show-toplevel)"
work="$(mktemp -d)"
trap 'kill "${stub:-0}" 2>/dev/null || true; rm -rf "$work"' EXIT

fail() { echo "FAIL: $*"; exit 1; }
for r in origin/main "$ref"; do
  git -C "$repo" cat-file -e "$r:.nojekyll" 2>/dev/null && fail "$r has .nojekyll: Jekyll is skipped and _admin-prototype would be served"
  if git -C "$repo" cat-file -e "$r:_config.yml" 2>/dev/null; then
    git -C "$repo" show "$r:_config.yml" | grep -q "_admin-prototype" && fail "$r _config.yml mentions _admin-prototype"
  fi
  git -C "$repo" ls-tree -r --name-only "$r" | grep -q '^\.github/workflows/' && fail "$r has custom workflows: re-check how Pages is built"
done

cd "$work"
printf 'source "https://rubygems.org"\ngem "github-pages", "= 232", group: :jekyll_plugins\ngem "webrick"\n' > Gemfile
bundle config set --local path vendor >/dev/null
bundle install --quiet

# jekyll-github-metadata only fills site.github template variables; answer its API calls locally
# so the build does not depend on GitHub API access. File selection does not use these values.
node -e "require('http').createServer((q,s)=>{s.writeHead(200,{'Content-Type':'application/json'});s.end(q.url.endsWith('/pages')?'{\"html_url\":\"https://85blends.app/\",\"source\":{\"branch\":\"main\",\"path\":\"/\"}}':'{\"name\":\"85Blends-website\",\"owner\":{\"login\":\"julianf40-hub\"},\"private\":false}')}).listen(4999,'127.0.0.1')" &
stub=$!
sleep 0.5
export LANG=C.UTF-8 LC_ALL=C.UTF-8 PAGES_API_URL=http://127.0.0.1:4999 NO_PROXY=127.0.0.1 no_proxy=127.0.0.1 PAGES_REPO_NWO=julianf40-hub/85Blends-website JEKYLL_ENV=production

build() { # name ref
  mkdir -p "src-$1"
  git -C "$repo" archive "$2" | tar -x -C "src-$1"
  bundle exec github-pages build --source "src-$1" --destination "site-$1" > "build-$1.log" 2>&1 || { cat "build-$1.log"; fail "build of $2 failed"; }
  (cd "site-$1" && find . -mindepth 1 | sort) > "files-$1.txt"
}
build main origin/main
build ref "$ref"
grep -E "Configuration file|GitHub Pages:" build-ref.log | sort -u
[ -d "src-ref/_admin-prototype" ] || fail "$ref does not contain _admin-prototype (nothing to test)"
if grep -qi "admin-prototype" files-ref.txt; then fail "prototype files are in the Pages output"; fi
diff files-main.txt files-ref.txt > /dev/null || { diff files-main.txt files-ref.txt; fail "$ref changes the deployed file set"; }
echo "PASS: $(wc -l < files-ref.txt) output entries, identical to main; no _admin-prototype files in the Pages output"
