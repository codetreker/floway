// Render a multipart/form-data body as readable text. Binary parts collapse
// to a `[binary, N bytes, content-type=…]` marker followed by their own
// MIME-wrapped base64; text fields decode in place; the surrounding form
// structure (boundary markers, per-part headers) stays human-legible.

// Returns null when no boundary parameter is present or the body is not
// well-formed multipart — caller falls back to raw rendering.
export const renderMultipart = (b64: string, contentType: string): string | null => {
  const boundary = extractBoundary(contentType);
  if (boundary === null) return null;

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(b64);
  } catch {
    return null;
  }

  const delim = new TextEncoder().encode(`--${boundary}`);
  const positions: number[] = [];
  let cursor = indexOfSeq(bytes, delim, 0);
  while (cursor >= 0) {
    positions.push(cursor);
    cursor = indexOfSeq(bytes, delim, cursor + delim.length);
  }
  if (positions.length < 2) return null;

  const parts: ParsedPart[] = [];
  for (let i = 0; i < positions.length - 1; i++) {
    const start = positions[i]! + delim.length;
    // The terminating delimiter ends with `--` (0x2d 0x2d); everything past it is the multipart epilogue.
    if (bytes[start] === 0x2d && bytes[start + 1] === 0x2d) break;
    const end = positions[i + 1]!;
    let bodyStart = start;
    if (bytes[bodyStart] === 0x0d && bytes[bodyStart + 1] === 0x0a) bodyStart += 2;
    let bodyEnd = end;
    if (bodyEnd >= 2 && bytes[bodyEnd - 2] === 0x0d && bytes[bodyEnd - 1] === 0x0a) bodyEnd -= 2;
    const parsed = splitPartHeaderAndBody(bytes.slice(bodyStart, bodyEnd));
    if (parsed === null) return null;
    parts.push(parsed);
  }
  if (parts.length === 0) return null;

  return `--${boundary}\r\n${parts.map(renderPart).join(`\r\n--${boundary}\r\n`)}\r\n--${boundary}--\r\n`;
};

const TEXT_CONTENT_TYPE_RE = /^(text\/|application\/(json|x-?www-form-urlencoded|javascript|xml|xhtml\+xml|vnd\.api\+json)|.*\+json|.*\+xml)/i;

const isTextContentType = (ct: string): boolean => TEXT_CONTENT_TYPE_RE.test(ct.split(';')[0]!.trim());

const extractBoundary = (contentType: string): string | null => {
  // RFC 7578 allows the boundary parameter quoted (`boundary="abc"`) or bare
  // (`boundary=abc`). The regex captures either form into groups 2 / 3.
  const match = /;\s*boundary=("([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!match) return null;
  return match[2] ?? match[3]!;
};

const base64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

// Wire-format-style base64 wrapping at 76 chars per line — the MIME default
// in RFC 2045, matching what a `Content-Transfer-Encoding: base64` body
// would look like on a real HTTP wire trace; keeps a 2 MB PNG from
// rendering as one infinitely-wide line.
const wrapBase64 = (s: string): string => {
  if (s.length <= 76) return s;
  const out: string[] = [];
  for (let i = 0; i < s.length; i += 76) out.push(s.slice(i, i + 76));
  return out.join('\n');
};

// Linear scan for an exact byte sequence — boundaries are short (≤70 bytes)
// and most multipart bodies hold a handful of parts, so the naive scan is
// fine; bringing in a search library or building an indexer is overkill.
const indexOfSeq = (haystack: Uint8Array, needle: Uint8Array, from: number): number => {
  if (needle.length === 0) return from;
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
};

interface ParsedPart {
  rawHeaders: string;
  bodyBytes: Uint8Array;
  contentType: string;
}

const splitPartHeaderAndBody = (part: Uint8Array): ParsedPart | null => {
  // Header / body separator is the first `\r\n\r\n`. CRLF is required by
  // RFC 7578 — LF-only is malformed and we surface it as `null` so the
  // caller falls back to rendering the whole body as a single binary blob.
  const sep = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]);
  const idx = indexOfSeq(part, sep, 0);
  if (idx < 0) return null;
  const rawHeaders = new TextDecoder('utf-8', { fatal: false }).decode(part.slice(0, idx));
  const bodyBytes = part.slice(idx + sep.length);
  let contentType = '';
  for (const line of rawHeaders.split(/\r\n/)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    if (line.slice(0, colon).trim().toLowerCase() === 'content-type') {
      contentType = line.slice(colon + 1).trim();
      break;
    }
  }
  return { rawHeaders, bodyBytes, contentType };
};

// Binary parts keep their own base64 inline so the dump preserves the
// payload bytes; the rendered text is a reading view, not a replay source.
const renderPart = (part: ParsedPart): string => {
  const headerBlock = `${part.rawHeaders}\r\n`;
  if (part.bodyBytes.length === 0) return `${headerBlock}\r\n`;
  if (isTextContentType(part.contentType) || part.contentType === '') {
    // Empty content-type is the RFC default for form-data text fields.
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(part.bodyBytes);
    return `${headerBlock}\r\n${decoded}`;
  }
  const ctTag = part.contentType ? `, content-type=${part.contentType}` : '';
  const placeholder = `[binary, ${part.bodyBytes.length} bytes${ctTag}]`;
  const base64 = wrapBase64(bytesToBase64(part.bodyBytes));
  return `${headerBlock}\r\n${placeholder}\r\n${base64}`;
};
