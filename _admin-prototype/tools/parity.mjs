#!/usr/bin/env node
// Accept/reject parity between this JS port and the Python reference validator.
//
//   node _admin-prototype/tools/parity.mjs /path/to/E85-Blends-App
//
// Builds a corpus (seeds, the iOS staging fixtures, and targeted mutations), runs every document
// through tools/remote-gear/validate_catalog.py (validate_bytes) and through lib/validator.mjs
// (parseBytes), and fails on any disagreement. Also checks the vendored schema is byte-identical.
// Read-only: it does not modify the iOS repository.

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseBytes, RVP_SPONSOR_ID } from '../lib/validator.mjs';

const repo = process.argv[2];
if (!repo) {
  console.error('usage: node tools/parity.mjs /path/to/E85-Blends-App');
  process.exit(2);
}
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const tools = join(repo, 'tools/remote-gear');

const schemaOurs = readFileSync(join(ROOT, 'contract/catalog-v1.schema.json'));
const schemaTheirs = readFileSync(join(repo, 'docs/remote-gear/catalog-v1.schema.json'));
if (!schemaOurs.equals(schemaTheirs)) {
  console.error('MISMATCH: contract/catalog-v1.schema.json differs from the iOS repository copy');
  process.exit(1);
}

const seed = JSON.parse(readFileSync(join(repo, 'docs/remote-gear/catalog-v1.json')));
const live = JSON.parse(readFileSync(join(ROOT, 'data/fictional-live-production.json')));
const draft = JSON.parse(readFileSync(join(ROOT, 'data/fictional-draft.json')));
const doc = (brands, o = {}) => ({ schemaVersion: 1, revision: 'r', publishedAt: 1_800_000_000, brands, ...o });
const neutral = (o = {}) => ({ id: 'n', kind: 'brand', name: 'N', tagline: 'T', description: 'D', ctaTitle: 'C', destinationURL: 'https://example.com', ...o });
const offer = { amountOff: 5, eligibleProducts: 'e', code: 'C', terms: 't', disclosure: 'd' };

const corpus = [seed, live, doc(draft.catalog.brands), doc([]), doc([], { schemaVersion: 2 }), doc([], { schemaVersion: '1' }), doc([], { revision: '' }),
  doc([], { publishedAt: 0 }), doc([], { publishedAt: -1 }), doc([], { publishedAt: true }), doc('x'), [], 'x', null,
  doc([{ id: 'future', kind: 'video_card' }]), doc([{ kind: 'video_card' }]), doc([{ id: 'x' }]), doc([neutral(), neutral()])];
const urls = ['https://example.com', 'HTTPS://EXAMPLE.COM/a', 'https://example.com:443/x', 'https://example.com?q', 'https://example.com#f',
  'http://example.com', 'https:example.com', 'https:/example.com', 'https://', 'https://@x.com', 'https://u@x.com', 'https://u:p@x.com',
  'https://[::1]/x', 'https://[::1/x', 'https://x]y.com', 'https://:443', 'https:// x.com', 'https://x.com/a b', 'javascript:alert(1)',
  'e85blends://open', 'mailto:a@b.c', 'ftp://x.com', 'https://xn--bcher-kva.example/', 'https://bücher.example/', ' https://x.com', 42, null];
for (const url of urls) corpus.push(doc([neutral({ destinationURL: url })]), doc([neutral({ heroImageURL: url })]));
for (const [key, values] of Object.entries({
  name: ['', ' ', 'x'.repeat(60), 'x'.repeat(61), '🚗'.repeat(60), '🚗'.repeat(61), 'é'.repeat(60), 7],
  tagline: ['Official sponsor', 'PARTNER', 'Affiliated', 'endorsed', 'fine'],
  priceText: ['', 'From $1', 'x'.repeat(61), null],
  hidden: [true, false, 'yes', 0, null],
  more: [{}, { subtitle: '' }, { subtitle: 'Partner' }, { subtitle: 'ok' }, [], 'x', null],
  logo: [{ url: 'https://a.example/l.png' }, { darkURL: 'https://a.example/l.png' }, { url: 'https://a/l', darkURL: 'http://a/l' }, 'x', null],
  offer: [offer, { ...offer, amountOff: 0 }, { ...offer, amountOff: 10000 }, { ...offer, amountOff: 10001 }, { ...offer, amountOff: 2.5 },
    { ...offer, amountOff: true }, { ...offer, code: 'A B' }, { ...offer, code: 'x'.repeat(41) }, { ...offer, code: 'A\tB' },
    { ...offer, startsAt: 10, expiresAt: 10 }, { ...offer, startsAt: 10, expiresAt: 11 }, { ...offer, startsAt: 0 }, { ...offer, expiresAt: 'x' },
    { ...offer, terms: '' }, 'x', [], null],
  wheels: [[], null], homepageURL: ['https://x.com'], footnote: ['x'],
  accessibilityDescription: ['', 'ok', 'x'.repeat(501)],
})) for (const value of values) corpus.push(doc([neutral({ [key]: value })]));
corpus.push(doc([neutral({ id: RVP_SPONSOR_ID })]), doc([neutral({ id: 'A' })]), doc([neutral({ id: 'x'.repeat(65) })]));
const sponsor = structuredClone(seed.brands.find((b) => b.kind === 'rvp_wheels'));
for (const mutate of [
  (s) => s, (s) => { s.id = 'other'; }, (s) => { s.priceText = '$1'; }, (s) => { s.offer = offer; }, (s) => { s.logo = { url: 'https://x.com' }; },
  (s) => { delete s.homepageURL; }, (s) => { s.configuratorURL = 'http://x.com'; }, (s) => { s.footnote = ''; }, (s) => { s.wheels = {}; },
  (s) => { s.wheels = 'x'; }, (s) => { s.wheels.push({ id: 'new', displayName: 'N', accessibilityName: 'N', productURL: 'https://x.com' }); },
  (s) => { s.wheels.push({ id: 'new', displayName: 'N', accessibilityName: 'N', productURL: 'https://x.com', imageURL: 'https://x.com/i.png' }); },
  (s) => { s.wheels.push(structuredClone(s.wheels[0])); }, (s) => { s.wheels[0].hidden = 'no'; }, (s) => { s.wheels[0].id = 'Bad'; },
  (s) => { s.wheels[0] = 'x'; }, (s) => { s.wheels = Array.from({ length: 25 }, (_, i) => ({ id: `w${i}`, displayName: 'W', accessibilityName: 'W', productURL: 'https://x.com', imageURL: 'https://x.com/i.png' })); },
  (s) => { s.tagline = 'Official partner'; },
]) { const s = structuredClone(sponsor); mutate(s); corpus.push(doc([s])); }
corpus.push(doc([sponsor, structuredClone(sponsor)]), doc(Array.from({ length: 31 }, (_, i) => neutral({ id: `b${i}` }))));

const dir = mkdtempSync(join(tmpdir(), 'gear-parity-'));
const fixtures = spawnSync('python3', ['-I', join(tools, 'make_fixtures.py'), dir], { encoding: 'utf8' });
if (fixtures.status !== 0) throw new Error(fixtures.stderr);
for (const name of readdirSync(dir).sort()) corpus.push(JSON.parse(readFileSync(join(dir, name))));
rmSync(dir, { recursive: true, force: true });

const encoded = corpus.map((d) => JSON.stringify(d));
encoded.push('{"schemaVersion":1,"revision":"r","publishedAt":NaN,"brands":[]}', '﻿{}', '{', ' '.repeat(512_001));

const harness = `
import json, sys
sys.path.insert(0, sys.argv[1])
import validate_catalog as v
out = []
for text in json.load(sys.stdin):
    try:
        v.validate_bytes(text.encode('utf-8')); out.append('ok')
    except v.Unsupported: out.append('unsupported')
    except v.Invalid: out.append('invalid')
    except Exception as e: out.append('crash:' + type(e).__name__)
print(json.dumps(out))`;
const py = spawnSync('python3', ['-I', '-c', harness, tools], { input: JSON.stringify(encoded), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (py.status !== 0) throw new Error(py.stderr);
const reference = JSON.parse(py.stdout);

let mismatches = 0;
encoded.forEach((text, i) => {
  let ours;
  try { parseBytes(new TextEncoder().encode(text)); ours = 'ok'; } catch (e) { ours = e.unsupported ? 'unsupported' : 'invalid'; }
  const theirs = reference[i].startsWith('crash:') ? 'invalid' : reference[i];
  if (ours !== theirs) {
    mismatches += 1;
    console.log(`MISMATCH #${i}: python=${reference[i]} js=${ours}\n  ${text.slice(0, 300)}`);
  }
});
const crashes = reference.filter((r) => r.startsWith('crash:')).length;
console.log(`${encoded.length} documents, ${mismatches} mismatches${crashes ? `, ${crashes} Python crash(es) counted as rejections` : ''}; schema identical`);
process.exit(mismatches ? 1 : 0);
