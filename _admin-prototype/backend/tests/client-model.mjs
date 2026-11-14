// A line-by-line JavaScript model of the iOS client's acceptance rule, used to check that delayed or
// cached responses from gear-catalog cannot regress an installed client. Source (read-only input):
// julianf40-hub/E85-Blends-App@e6c42ed, EightyFiveBlends/GearCatalog.swift
//   - GearCatalogDigest.of (FNV-1a 64 + "-" + byte count)      lines 338–347
//   - GearCatalogStore.refresh: 304 → notModified, 200 → accept, other → keep state   lines 1060–1077
//   - GearCatalogStore.accept: identical bytes unchanged; publishedAt older → stale; equal → conflict;
//     revision seen before → revisionReused; otherwise persist and apply         lines 1092–1124
// Schema validation is the shared validator's job (parity 166/166); this model takes it as given.

export function fnv1a(bytes) {
  let hash = 0xcbf29ce484222325n;
  for (const b of bytes) {
    hash ^= BigInt(b);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `${hash.toString(16)}-${bytes.length}`;
}

export class ClientModel {
  constructor() { this.state = { lastDigest: null, lastPublishedAt: null, revisions: [], document: null, etag: null }; this.log = []; }

  /** Applies one HTTP response exactly as GearCatalogStore.refresh/accept would. */
  receive({ status, body, etag }) {
    if (status === 304) return this.#out('notModified');
    if (status !== 200) return this.#out(`httpStatus(${status})`);
    const bytes = Buffer.from(body);
    const doc = JSON.parse(bytes.toString('utf8'));
    const digest = fnv1a(bytes);
    if (digest === this.state.lastDigest) {
      if (etag) this.state.etag = etag;
      return this.#out('unchanged');
    }
    if (this.state.lastPublishedAt !== null) {
      if (doc.publishedAt < this.state.lastPublishedAt) return this.#out('rejected(stale)');
      if (doc.publishedAt === this.state.lastPublishedAt) return this.#out('rejected(conflict)');
    }
    if (this.state.revisions.includes(doc.revision)) return this.#out('rejected(revisionReused)');
    this.state = { lastDigest: digest, lastPublishedAt: doc.publishedAt, revisions: [...this.state.revisions, doc.revision].slice(-100),
      document: doc, etag: etag ?? null };
    return this.#out('updated');
  }

  #out(outcome) { this.log.push(outcome); return outcome; }
}
