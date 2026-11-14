// Static guards: no credentials or network clients in the prototype, nothing privileged in browser code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.local-state' || name === 'node_modules' || name === 'images' || name === '.deploy-check' || name === '.deploy-check-results') continue; // local, gitignored outputs
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

test('browser code never talks to a hosted Supabase project or any hard-coded host', () => {
  for (const file of sources.filter((f) => f.includes('/public/') || f.includes('/lib/'))) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!/supabase\.co|createClient/i.test(text), file);
    // Only the local-supabase adapter sends an apikey header, and only the public key it got from /config.json.
    if (!file.endsWith('/public/backend.js')) assert.ok(!/apikey/i.test(text), file);
    for (const m of text.matchAll(/fetch\(([^)]*)\)/g)) assert.ok(!/https?:/.test(m[1]), `${file}: ${m[0]}`);
  }
});

test('the local-supabase adapter uses only the configured URL and the publishable key', () => {
  const text = readFileSync(join(ROOT, 'public', 'backend.js'), 'utf8');
  for (const m of text.matchAll(/fetch\(([^,)]*)/g)) assert.match(m[1], /^(path|`\$\{cfg\.supabaseUrl\}|url|'\/config\.json')/, m[0]);
  assert.ok(!/service_role|secret_key|sb_secret/i.test(text)); // (the TOTP enrollment secret is the user's own factor)
  assert.match(text, /apikey: cfg\.publishableKey/);
});

test('local-supabase mode refuses non-loopback URLs and secret keys', async () => {
  const { localSupabaseBackend, createAdminServer } = await import('../server.mjs');
  const key = ['sb', 'publishable', 'localtest'].join('_');
  assert.throws(() => localSupabaseBackend({ supabaseUrl: 'https://example.supabase.co', publishableKey: key }));
  assert.throws(() => localSupabaseBackend({ supabaseUrl: 'http://10.0.0.5:54321', publishableKey: key }));
  assert.throws(() => localSupabaseBackend({ supabaseUrl: 'http://127.0.0.1:54321', publishableKey: ['sb', 'secret', 'x'].join('_') }));
  assert.throws(() => localSupabaseBackend({ supabaseUrl: 'http://127.0.0.1:54321', publishableKey: 'eyJhbGciOiJIUzI1NiJ9.x.y' }));
  const backend = localSupabaseBackend({ supabaseUrl: 'http://127.0.0.1:54321', publishableKey: key });
  const { server } = createAdminServer({ backend });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const config = await (await fetch(`${base}/config.json`)).json();
    assert.deepEqual(Object.keys(config).sort(), ['mode', 'productionConfirmation', 'publishableKey', 'supabaseUrl']);
    assert.equal(config.mode, 'local-supabase');
    const api = await fetch(`${base}/api/state`);
    assert.equal(api.status, 404, 'the simulated API is disabled in local-supabase mode');
    assert.match(api.headers.get('content-security-policy'), /connect-src 'self' http:\/\/127\.0\.0\.1:54321;/);
  } finally { server.close(); }
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
