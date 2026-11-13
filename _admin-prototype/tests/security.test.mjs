// Static guards: no credentials or network clients in the prototype, nothing privileged in browser code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.local-state' || name === 'node_modules' || name === 'images') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, out);
    else if (/\.(m?js|html|css|json|py)$/.test(name)) out.push(path);
  }
  return out;
}
const sources = files(ROOT).filter((f) => !f.includes(`${'tests'}/`));

test('no keys or key-shaped secrets anywhere in the prototype', () => {
  const patterns = [/sb_secret_[A-Za-z0-9]/, /sb_publishable_[A-Za-z0-9]/, /eyJhbGciOi[A-Za-z0-9_-]{10,}/, /service_role["'\s]*[:=]/i, /SUPABASE_(SERVICE_ROLE|SECRET)_KEY\s*=/, /zefkbtscieokkdenvnkg/];
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    for (const p of patterns) assert.ok(!p.test(text), `${file} matches ${p}`);
  }
});

test('browser code never talks to Supabase or any other host', () => {
  for (const file of sources.filter((f) => f.includes('/public/') || f.includes('/lib/'))) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!/supabase\.co|createClient|apikey/i.test(text), file);
    for (const m of text.matchAll(/fetch\(([^)]*)\)/g)) assert.ok(!/https?:/.test(m[1]), `${file}: ${m[0]}`);
  }
});

test('the local server imports no network client', () => {
  const text = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  assert.ok(!/from 'node:(https|net|tls|dgram|child_process)'/.test(text));
  assert.ok(!/\bfetch\(|http\.request|http\.get\(/.test(text));
  assert.match(text, /listen\(port, '127\.0\.0\.1'/);
});

test('the prototype stays out of the public GitHub Pages build', () => {
  // Jekyll (the Pages default for this repo) skips directories that start with "_".
  assert.ok(ROOT.replace(/\/$/, '').split('/').at(-1).startsWith('_'));
});
