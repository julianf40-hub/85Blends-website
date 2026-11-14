#!/usr/bin/env node
// Builds the DEPLOYMENT package for the Recommended Gear admin backend (current design, D10 option 2):
//
//   deploy/package/
//     migrations/<squashed migration>.sql      from deploy/migrations/ (hand-written, current design only)
//     functions/gear-publish/index.ts          test-only regions removed
//     functions/gear-catalog/index.ts
//     functions/_shared/{validator,diff}.mjs
//     functions.toml                           verify_jwt per function
//     README.md                                from deploy/README.md
//     MANIFEST.json                            sha256 of every file above
//
// Only the allowlisted sources below are read, so nothing else (the legacy demo function, the
// experimental legacy fixtures, seeds, tests, local config) can enter the package. Test-only code
// is marked in the sources:
//   // @test-only:start … // @test-only:end   removed
//   // @deploy: <code>                        becomes <code>
// The build fails on unbalanced markers or if any forbidden string survives.
//
//   node tools/build-deploy-package.mjs          write deploy/package/
//   node tools/build-deploy-package.mjs --check  fail if deploy/package/ differs from a fresh build
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(BACKEND, 'deploy', 'package');

export const SOURCES = {
  migrations: join(BACKEND, 'deploy', 'migrations'),
  functions: { 'gear-publish': ['index.ts'], 'gear-catalog': ['index.ts'], _shared: ['validator.mjs', 'diff.mjs'] },
  readme: join(BACKEND, 'deploy', 'README.md'),
};

// Strings that must never appear in the package (test hooks, the superseded Storage path, local-only config).
export const FORBIDDEN = [
  'x-gear-test-fault', 'GEAR_ALLOW_TEST_FAULTS', 'TEST_FAULTS', '@test-only', 'pause_', 'response_lost', 'stall_body', 'faultParts', 'hasFault',
  'gear-legacy-storage-demo', 'legacy-storage-path', 'experimental',
  'gear_acquire_lease', 'gear_release_lease', 'gear_record_publication', 'gear_record_status', 'gear_record_drift_ack',
  'gear_prepare_write', 'gear_authorize_write', 'gear_consume_write', 'gear_write_grants', 'gear_catalog_write_allowed',
  'gear_catalog_version_matches', 'gear_catalog_commit_guard', 'gear_storage_drift_acks', 'lease_token', 'lease_expires_at',
  'local-only', 'service_role_key',
  // key-shaped values (a prefix check such as startsWith('sb_secret_') is fine; a key is not)
  /sb_secret_[A-Za-z0-9_-]{8,}/, /sb_publishable_[A-Za-z0-9_-]{8,}/, /eyJhbGciOi[A-Za-z0-9_-]{10,}/,
];
const matches = (content, bad) => (bad instanceof RegExp ? bad.test(content) : content.includes(bad));

export function stripTestOnly(text, file) {
  const out = [];
  let skipping = false;
  text.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('// @test-only:start')) {
      if (skipping) throw new Error(`${file}:${i + 1}: nested @test-only:start`);
      skipping = true; return;
    }
    if (t.startsWith('// @test-only:end')) {
      if (!skipping) throw new Error(`${file}:${i + 1}: @test-only:end without start`);
      skipping = false; return;
    }
    if (skipping) return;
    const deploy = /^(\s*)\/\/ @deploy: (.*)$/.exec(line);
    out.push(deploy ? deploy[1] + deploy[2] : line);
  });
  if (skipping) throw new Error(`${file}: unterminated @test-only:start`);
  return out.join('\n');
}

export function buildPackage() {
  const files = new Map(); // relative path -> content (string)
  for (const f of readdirSync(SOURCES.migrations).filter((n) => n.endsWith('.sql')).sort()) {
    files.set(`migrations/${f}`, readFileSync(join(SOURCES.migrations, f), 'utf8'));
  }
  for (const [fn, names] of Object.entries(SOURCES.functions)) {
    for (const name of names) {
      const src = readFileSync(join(BACKEND, 'supabase', 'functions', fn, name), 'utf8');
      files.set(`functions/${fn}/${name}`, name.endsWith('.ts') ? stripTestOnly(src, `${fn}/${name}`) : src);
    }
  }
  files.set('functions.toml', [
    '# Per-function gateway settings for the deployment (copy into the target project\'s supabase/config.toml).',
    '[functions.gear-publish]', 'verify_jwt = true', '',
    '# Public read-only catalog endpoint: guests and app users, no sign-in.',
    '[functions.gear-catalog]', 'verify_jwt = false', '',
  ].join('\n'));
  files.set('README.md', readFileSync(SOURCES.readme, 'utf8'));
  const problems = [];
  for (const [path, content] of files) {
    if (path === 'README.md') continue; // prose may name what is excluded
    for (const bad of FORBIDDEN) if (matches(content, bad)) problems.push(`${path}: contains forbidden "${bad}"`);
  }
  if (problems.length) throw new Error(`deployment package rejected:\n  ${problems.join('\n  ')}`);
  const manifest = { description: 'Recommended Gear admin deployment package (D10 option 2). Built by tools/build-deploy-package.mjs.',
    files: Object.fromEntries([...files].map(([p, c]) => [p, createHash('sha256').update(c).digest('hex')]).sort(([a], [b]) => a.localeCompare(b))) };
  files.set('MANIFEST.json', JSON.stringify(manifest, null, 2) + '\n');
  return files;
}

function listTree(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listTree(p, base, out); else out.push(relative(base, p));
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = buildPackage();
  if (process.argv.includes('--check')) {
    const committed = listTree(OUT).sort();
    const expected = [...files.keys()].sort();
    const diffs = [];
    if (JSON.stringify(committed) !== JSON.stringify(expected)) diffs.push(`file list differs:\n  committed ${committed.join(', ')}\n  expected  ${expected.join(', ')}`);
    for (const [p, c] of files) if (existsSync(join(OUT, p)) && readFileSync(join(OUT, p), 'utf8') !== c) diffs.push(`${p} differs from a fresh build`);
    if (diffs.length) { console.error(`deploy/package is stale:\n${diffs.join('\n')}\nRun: node tools/build-deploy-package.mjs`); process.exit(1); }
    console.log(`deploy/package matches a fresh build (${files.size} files)`);
  } else {
    rmSync(OUT, { recursive: true, force: true });
    for (const [p, c] of files) { mkdirSync(dirname(join(OUT, p)), { recursive: true }); writeFileSync(join(OUT, p), c); }
    console.log(`wrote deploy/package (${files.size} files)`);
  }
}
