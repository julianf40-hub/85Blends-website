// Static checks on the deployment package (no stack needed): it is exactly what the build produces
// from allowlisted sources, contains only the current design, and carries no test-only controls or
// superseded Storage-path code. The runtime check of the same package is tools/check-deploy-package.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPackage, stripTestOnly, FORBIDDEN } from '../tools/build-deploy-package.mjs';

const BACKEND = fileURLToPath(new URL('..', import.meta.url));
const PKG = join(BACKEND, 'deploy', 'package');
const tree = (d, b = d, out = []) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? tree(p, b, out) : out.push(relative(b, p)); } return out; };

test('the committed package equals a fresh build from the allowlisted sources', () => {
  const out = execFileSync(process.execPath, [join(BACKEND, 'tools', 'build-deploy-package.mjs'), '--check'], { encoding: 'utf8' });
  assert.match(out, /matches a fresh build/);
});

test('the package holds only the current design: an exact file allowlist', () => {
  assert.deepEqual(tree(PKG).sort(), [
    'MANIFEST.json', 'README.md', 'ROLLOUT.md', 'functions.toml', 'functions/_shared/diff.mjs', 'functions/_shared/validator.mjs',
    'functions/gear-catalog/index.ts', 'functions/gear-publish/index.ts', 'migrations/20261114130000_recommended_gear_admin.sql',
    'ops/schedule-cleanup.sql',
  ]);
  const manifest = JSON.parse(readFileSync(join(PKG, 'MANIFEST.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.files).sort(), tree(PKG).filter((f) => f !== 'MANIFEST.json').sort());
});

test('no test-only controls, legacy Storage path, local config or keys anywhere in the package code', () => {
  for (const f of tree(PKG).filter((p) => !p.endsWith('.md'))) {
    const text = readFileSync(join(PKG, f), 'utf8');
    for (const bad of FORBIDDEN) assert.ok(!(bad instanceof RegExp ? bad.test(text) : text.includes(bad)), `${f} contains ${bad}`);
  }
  const fn = readFileSync(join(PKG, 'functions/gear-publish/index.ts'), 'utf8');
  assert.match(fn, /const fault: string \| null = null;/, 'the only fault value in the package is a constant null');
  assert.ok(!/req\.headers\.get\('x-gear/.test(fn));
});

test('the build refuses unbalanced test-only markers instead of shipping half a region', () => {
  assert.throws(() => stripTestOnly('a\n// @test-only:start\nb\n', 'x.ts'), /unterminated/);
  assert.throws(() => stripTestOnly('// @test-only:end\n', 'x.ts'), /without start/);
  assert.throws(() => stripTestOnly('// @test-only:start\n// @test-only:start\n', 'x.ts'), /nested/);
  assert.equal(stripTestOnly('keep\n// @test-only:start\ndrop\n// @test-only:end\n  // @deploy: const x = 1;\n', 'x.ts'), 'keep\n  const x = 1;\n');
});

test('the deployment migration defines the current design and none of the superseded objects', () => {
  const sql = readFileSync(join(PKG, 'migrations/20261114130000_recommended_gear_admin.sql'), 'utf8');
  for (const needed of ['gear_commit_publication', 'gear_current_catalog', 'gear_prepare_intent', 'gear_find_operation', 'gear_operation_result',
    'gear_cleanup_operations', 'current_publication_id', 'request_digest', 'gear_publication_guard', 'save_gear_draft', 'gear_image_write_allowed']) {
    assert.ok(sql.includes(needed), `missing ${needed}`);
  }
  assert.ok(!/policy "gear catalog/i.test(sql), 'no Storage policy for catalog objects');
  assert.ok(!/on storage\.objects[^;]*for (update|delete)/i.test(sql), 'images are insert-only');
  assert.ok(!/create trigger[^;]*on storage\.objects/i.test(sql), 'no trigger on storage.objects');
  // The existing recommended-gear bucket (installed builds, current publisher) is never touched.
  assert.ok(!/'recommended-gear'/.test(sql), 'the migration never names the legacy recommended-gear bucket');
  const bucketStatements = sql.split(';').filter((st) => /storage\.buckets/i.test(st));
  assert.equal(bucketStatements.length, 1, 'one bucket statement');
  assert.ok(!/update/i.test(bucketStatements[0]), 'it creates the image bucket and never changes an existing bucket');
  assert.match(sql, /'recommended-gear-images'[\s\S]*on conflict \(id\) do nothing/);
});

test('the package functions are the sources minus only the marked test-only regions', () => {
  for (const fn of ['gear-publish', 'gear-catalog']) {
    const src = readFileSync(join(BACKEND, 'supabase/functions', fn, 'index.ts'), 'utf8');
    assert.equal(readFileSync(join(PKG, 'functions', fn, 'index.ts'), 'utf8'), stripTestOnly(src, fn));
  }
  for (const m of ['validator.mjs', 'diff.mjs']) {
    assert.ok(readFileSync(join(PKG, 'functions/_shared', m)).equals(readFileSync(join(BACKEND, '..', 'lib', m))), `${m} matches the prototype lib`);
  }
  assert.ok(existsSync(join(BACKEND, 'supabase/functions/gear-legacy-storage-demo')) && !existsSync(join(PKG, 'functions/gear-legacy-storage-demo')));
  assert.equal(buildPackage().size, tree(PKG).length);
});
