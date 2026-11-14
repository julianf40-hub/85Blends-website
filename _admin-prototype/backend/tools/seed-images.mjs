#!/usr/bin/env node
// LOCAL ONLY: uploads the fictional placeholder images (../data/images) to the local stack at the
// content-addressed paths the fictional draft references. Uses the local service key from
// `supabase status`; refuses any non-local API URL.
import { readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
const backend = new URL('..', import.meta.url).pathname;
const env = JSON.parse(execSync('supabase status -o json', { cwd: backend, encoding: 'utf8', env: { GEAR_LOCAL_JWT_EXPIRY: '3600', ...process.env } }));
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(env.API_URL)) throw new Error('seed-images only runs against a local stack');
const draft = readFileSync(new URL('../../data/fictional-draft.json', import.meta.url), 'utf8');
const prefix = 'https://storage.example.invalid/recommended-gear/images/'; // the fictional canonical URL prefix in the draft
// The current design keeps images in recommended-gear-images; the legacy demonstrations pass recommended-gear.
const bucket = process.env.GEAR_SEED_IMAGE_BUCKET ?? 'recommended-gear-images';
if (!/^recommended-gear(-images)?$/.test(bucket)) throw new Error(`unexpected bucket ${bucket}`);
const names = [...new Set([...draft.matchAll(/https:\/\/storage\.example\.invalid\/recommended-gear\/images\/([a-z0-9-]+\/[a-f0-9]{64}\.png)/g)].map((m) => m[1]))];
let uploaded = 0;
for (const name of names) {
  const file = name.split('/')[1];
  const bytes = readFileSync(new URL(`../../data/images/${file}`, import.meta.url));
  const res = await fetch(`${env.API_URL}/storage/v1/object/${bucket}/images/${name}`, {
    method: 'POST', body: bytes, headers: { apikey: env.SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SERVICE_ROLE_KEY}`, 'Content-Type': 'image/png', 'x-upsert': 'true' },
  });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${await res.text()}`);
  uploaded += 1;
}
console.log(`seeded ${uploaded} fictional images into ${bucket} (${prefix}…)`);
