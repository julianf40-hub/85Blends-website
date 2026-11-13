export function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export const clone = (v) => (v === undefined ? v : structuredClone(v));

export function formatTime(seconds) {
  if (seconds == null) return '—';
  return new Date(seconds * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/** "2026-11-13T09:30" (UTC) <-> Unix seconds, for datetime-local inputs that are labeled UTC. */
export function toUTCInput(seconds) {
  if (seconds == null) return '';
  return new Date(seconds * 1000).toISOString().slice(0, 16);
}
export function fromUTCInput(value) {
  if (!value) return undefined;
  const ms = Date.parse(`${value}:00Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Sets a dotted path; `undefined` deletes the key and prunes nothing else. */
export function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (o[k] == null || typeof o[k] !== 'object') o[k] = /^\d+$/.test(k) ? [] : {};
    o = o[k];
  }
  const last = keys.at(-1);
  if (value === undefined) delete o[last];
  else o[last] = value;
}

export async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
