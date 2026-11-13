// gear-catalog: the read-only endpoint apps use to fetch the current Recommended Gear catalog
// (decision D10, option 2). LOCAL implementation.
//
//   GET /functions/v1/gear-catalog/production   every app build, guests included (no sign-in)
//   GET /functions/v1/gear-catalog/staging      TestFlight / Xcode / Debug previews only (app-side rule)
//
// The body is the EXACT bytes of the current publication (the v1 catalog JSON contract, unchanged),
// read in one statement from the database pointer, so bytes, digest, revision and publishedAt always
// belong to the same publication. It needs no privileged key: it calls an anon-executable read RPC.
//
// Cache behavior (also documented in the plan, §6.2):
//   - ETag is the SHA-256 of the bytes, quoted. If-None-Match → 304 with no body.
//   - Production: Cache-Control: public, max-age=60 (the apps refresh at most every 60 s).
//     Staging: no-cache (always revalidated; testers see a publication immediately).
//   - 404 when nothing is published yet; apps keep bundled (Production) or nothing (Staging).
//     Errors are 503 and never cached. No status clears an app's saved catalog.
//   - Any cache (CDN, proxy) can only ever serve an OLDER complete publication, never a mixture.
//     The apps accept a document only if publishedAt is strictly newer than the last one they
//     accepted, so a delayed or cached older response cannot regress a client that has a newer one.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CACHE_CONTROL: Record<string, string> = { production: 'public, max-age=60', staging: 'no-cache' };

async function sha256(bytes: Uint8Array) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const etagMatches = (header: string | null, etag: string) =>
  !!header && header.split(',').map((t) => t.trim().replace(/^W\//, '')).some((t) => t === etag || t === '*');

Deno.serve(async (req) => {
  const base = { 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*' };
  const json = (status: number, body: unknown, cache = 'no-store') =>
    new Response(JSON.stringify(body), { status, headers: { ...base, 'Content-Type': 'application/json', 'Cache-Control': cache } });

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { ...base, Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } });
  }
  const target = /\/gear-catalog\/(production|staging)\/?$/.exec(new URL(req.url).pathname)?.[1];
  if (!target) return json(404, { error: 'unknown_catalog', message: 'Use /gear-catalog/production or /gear-catalog/staging' });

  let rows: any[];
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/gear_current_catalog`, {
      method: 'POST', body: JSON.stringify({ p_target: target }),
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
    });
    if (!res.ok) return json(503, { error: 'unavailable' });
    rows = await res.json();
  } catch {
    return json(503, { error: 'unavailable' });
  }
  if (!rows.length) return json(404, { error: 'not_published', message: `Nothing has been published to ${target} yet` }, CACHE_CONTROL[target]);

  const { document, digest, revision, published_at } = rows[0];
  const bytes = new TextEncoder().encode(document);
  // Integrity: never serve bytes that do not match their recorded digest.
  if ((await sha256(bytes)) !== digest) return json(503, { error: 'integrity', message: 'Stored bytes do not match their digest' });

  const etag = `"${digest}"`;
  const headers = {
    ...base, ETag: etag, 'Cache-Control': CACHE_CONTROL[target], 'X-Gear-Revision': String(revision), 'X-Gear-Published-At': String(published_at),
  };
  if (etagMatches(req.headers.get('If-None-Match'), etag)) return new Response(null, { status: 304, headers });
  return new Response(req.method === 'HEAD' ? null : bytes, {
    status: 200, headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) },
  });
});
