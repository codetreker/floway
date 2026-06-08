import { describe, expect, test } from 'vitest';

import { generateCodexPkce } from './pkce.ts';

describe('generateCodexPkce', () => {
  test('produces a verifier of expected length and url-safe alphabet', async () => {
    const { verifier } = await generateCodexPkce();
    // 64 bytes base64url-encoded with no padding → 86 chars.
    expect(verifier).toHaveLength(86);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test('produces a challenge that is sha256(verifier) in base64url', async () => {
    const { verifier, challenge } = await generateCodexPkce();
    // Independent recomputation; the test uses Web standards too so it works
    // in any runtime the package supports.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const expectedB64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
    const expected = expectedB64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(challenge).toBe(expected);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toContain('=');
  });

  test('successive calls yield different verifiers', async () => {
    const a = await generateCodexPkce();
    const b = await generateCodexPkce();
    expect(a.verifier).not.toBe(b.verifier);
  });
});
