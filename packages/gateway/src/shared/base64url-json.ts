// Plain base64url(JSON) codec used by both the Messages web-search shim and
// the Responses compact shim to round-trip private payloads through an
// opaque-string slot on the wire (`encrypted_content`, `encrypted_index`).
// No envelope or prefix marker — foreign upstream blobs are detected
// structurally by decode failure or shim-side schema mismatch, so the same
// slot remains forward-compatible with a native-compaction upstream's own
// opaque content.

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const base64UrlToBytes = (value: string): Uint8Array | null => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch {
    return null;
  }
};

export const encodeBase64UrlJson = (payload: unknown): string =>
  bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));

export const decodeBase64UrlJson = (value: string): unknown | null => {
  const bytes = base64UrlToBytes(value);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
};
