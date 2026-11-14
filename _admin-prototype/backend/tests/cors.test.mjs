// CORS handled by the functions THEMSELVES (current design). Locally the Kong gateway answers browser
// preflights on its own, which would hide a function that cannot; a hosted gateway may pass them
// through. So preflights here go straight to the local Edge Runtime container, bypassing Kong.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { ENV, mfa, resetLocalDatabase, sleep } from './helpers.mjs';

const ADMIN = 'http://127.0.0.1:4174';     // in GEAR_ALLOWED_ORIGINS (supabase/config.toml)
const OTHER = 'https://evil.example';
let runtime;
let publisher;
before(async () => {
  resetLocalDatabase();
  await sleep(3000);
  publisher = await mfa('publisher');
  const ip = execFileSync('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', 'supabase_edge_runtime_gear-admin-local'], { encoding: 'utf8' }).trim();
  runtime = `http://${ip}:8081`;
});
const preflight = (fn, origin, method, headers) => fetch(`${runtime}/${fn}`, { method: 'OPTIONS',
  headers: { Origin: origin, 'Access-Control-Request-Method': method, ...(headers ? { 'Access-Control-Request-Headers': headers } : {}) } });

test('gear-publish answers the admin origin\'s preflight itself, with exactly what the browser sends', async () => {
  const r = await preflight('gear-publish', ADMIN, 'POST', 'authorization, apikey, content-type, x-client-info');
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), ADMIN, 'the exact origin, never *');
  const allowed = r.headers.get('access-control-allow-headers').split(',').map((h) => h.trim());
  for (const h of ['authorization', 'apikey', 'content-type', 'x-client-info']) assert.ok(allowed.includes(h), h);
  assert.match(r.headers.get('access-control-allow-methods'), /POST/);
  assert.match(r.headers.get('vary') ?? '', /Origin/);
});

test('gear-publish refuses any other origin: no CORS headers on the preflight, and a 403 server-side', async () => {
  const r = await preflight('gear-publish', OTHER, 'POST', 'authorization, content-type');
  assert.equal(r.status, 403);
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  const post = await fetch(`${ENV.API_URL}/functions/v1/gear-publish`, { method: 'POST', body: JSON.stringify({ action: 'verify' }),
    headers: { Origin: OTHER, apikey: ENV.ANON_KEY, Authorization: `Bearer ${publisher}`, 'Content-Type': 'application/json' } });
  assert.equal(post.status, 403);
  assert.equal((await post.json()).error, 'bad_origin');
});

test('an allowed browser request gets its CORS headers on the actual response too (from the function, not the gateway)', async () => {
  // Direct to the runtime: local Kong rewrites CORS headers on responses (it sends *), which would hide the function's own.
  const r = await fetch(`${runtime}/gear-publish`, { method: 'POST', body: JSON.stringify({ action: 'inspect', target: 'staging' }),
    headers: { Origin: ADMIN, apikey: ENV.ANON_KEY, Authorization: `Bearer ${publisher}`, 'Content-Type': 'application/json' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), ADMIN);
});

test('gear-catalog: public preflight (If-None-Match) answered by the function; ETag and revision exposed to scripts', async () => {
  const r = await preflight('gear-catalog/production', OTHER, 'GET', 'if-none-match');
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.match(r.headers.get('access-control-allow-headers'), /if-none-match/);
  assert.match(r.headers.get('access-control-allow-methods'), /GET/);
  const get = await fetch(`${runtime}/gear-catalog/staging`, { headers: { Origin: OTHER } });
  assert.ok([200, 404].includes(get.status));
  assert.equal(get.headers.get('access-control-allow-origin'), '*');
  assert.match(get.headers.get('access-control-expose-headers'), /ETag/);
  // No credentials are needed or accepted as a reason to vary: the content is public.
  assert.equal(get.headers.get('access-control-allow-credentials'), null);
});
