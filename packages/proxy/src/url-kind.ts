// Best-effort proxy-kind label derived from the URL scheme alone. Distinct
// from `parseProxyUri` because (a) it returns a `PROXY` fallback on garbled
// input instead of throwing, and (b) it does scheme-only discrimination —
// no required-field validation, no SS / VLESS userinfo decode beyond the
// minimum needed to pick the kind label.

export const kindFromUri = (url: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'PROXY';
  }
  switch (parsed.protocol) {
  case 'http:': return 'HTTP';
  case 'https:': return 'HTTPS';
  case 'socks5:': return 'SOCKS5';
  case 'ss:':
    // ss2022 userinfo is plaintext `method:base64key` whose prefix is the
    // literal cipher name (e.g. `2022-blake3-aes-128-gcm`). The discriminator
    // is ASCII letters/digits/hyphens — bytes the URL parser never percent-
    // encodes, so `parsed.username` already carries the literal prefix and
    // a percent-decode would only widen the throw surface.
    return parsed.username.startsWith('2022-blake3-') ? 'SS-2022' : 'SS';
  case 'trojan:': return 'TROJAN';
  case 'vless:': {
    // REALITY uses `security=reality`; vless-over-WS uses `type=ws`. Anything
    // else falls back to the bare protocol label.
    const security = parsed.searchParams.get('security');
    const transport = parsed.searchParams.get('type');
    if (security === 'reality') return 'REALITY';
    if (transport === 'ws') return 'VLESS-WS';
    return 'VLESS';
  }
  default: return parsed.protocol.replace(/:$/, '').toUpperCase();
  }
};
