import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CONFIG } from './fixtures.ts';
import { M365_OAUTH_CLIENT_ID } from '../src/enrollment.ts';
import { M365_OIDC_TIMEOUT_MS, resetM365OidcCacheForTesting, validateM365EnrollmentIdToken } from '../src/oidc.ts';
import type { Fetcher } from '@floway-dev/provider';

const base64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const signer = async (kid = 'kid') => {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey & { kid: string; use: string; alg: string; issuer?: string };
  Object.assign(publicJwk, { kid, use: 'sig', alg: 'RS256', key_ops: ['verify'] });
  publicJwk.issuer = 'https://login.microsoftonline.com/{tenantid}/v2.0';
  const sign = async (overrides: Record<string, unknown> = {}, headerOverrides: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', kid, ...headerOverrides })));
    const payload = base64Url(new TextEncoder().encode(JSON.stringify({
      aud: M365_OAUTH_CLIENT_ID,
      iss: `https://login.microsoftonline.com/${CONFIG.account.tenantId}/v2.0`,
      tid: CONFIG.account.tenantId,
      oid: CONFIG.account.objectId,
      preferred_username: CONFIG.account.username,
      nonce: 'nonce',
      ver: '2.0',
      sub: 'subject',
      iat: now,
      exp: now + 3600,
      ...overrides,
    })));
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${header}.${payload}`));
    return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
  };
  return { publicJwk, sign };
};

const fetcherFor = (keys: JsonWebKey[] | (() => JsonWebKey[]), issuer = `https://login.microsoftonline.com/${CONFIG.account.tenantId}/v2.0`): Fetcher => async url => {
  if (String(url).includes('openid-configuration')) {
    return new Response(JSON.stringify({ issuer, jwks_uri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys' }));
  }
  return new Response(JSON.stringify({ keys: typeof keys === 'function' ? keys() : keys }));
};

describe('M365 OIDC validation', () => {
  beforeEach(() => resetM365OidcCacheForTesting());

  it('verifies the complete enrollment claim set', async () => {
    const fixture = await signer();
    await expect(validateM365EnrollmentIdToken(await fixture.sign(), 'nonce', fetcherFor([fixture.publicJwk]))).resolves.toEqual({
      tenantId: CONFIG.account.tenantId,
      objectId: CONFIG.account.objectId,
      username: CONFIG.account.username,
    });
  });

  it('rejects wrong issuer, audience, nonce, version, and subject', async () => {
    const fixture = await signer();
    const cases = [
      [{ iss: 'https://attacker.example' }, 'issuer'],
      [{ aud: 'other' }, 'audience'],
      [{ nonce: 'wrong' }, 'nonce'],
      [{ ver: '1.0' }, 'version'],
      [{ sub: '' }, 'subject'],
    ] as const;
    for (const [claims, message] of cases) {
      resetM365OidcCacheForTesting();
      await expect(validateM365EnrollmentIdToken(await fixture.sign(claims), 'nonce', fetcherFor([fixture.publicJwk]))).rejects.toThrow(message);
    }
  });

  it('rejects expired/future issue windows, future nbf, and consumer tenant', async () => {
    const fixture = await signer();
    const now = Math.floor(Date.now() / 1000);
    for (const claims of [
      { exp: now - 60 },
      { iat: now - 600 },
      { iat: now + 60 },
      { nbf: now + 60 },
      { tid: '9188040d-6c67-4c5b-b112-36a304b66dad' },
    ]) {
      resetM365OidcCacheForTesting();
      await expect(validateM365EnrollmentIdToken(await fixture.sign(claims), 'nonce', fetcherFor([fixture.publicJwk]))).rejects.toBeInstanceOf(Error);
    }
  });

  it('rejects incompatible or ambiguous JWK metadata', async () => {
    const fixture = await signer();
    for (const patch of [
      { use: 'enc' },
      { key_ops: ['sign'] },
      { alg: 'RS512' },
      { issuer: 'https://attacker.example' },
    ]) {
      resetM365OidcCacheForTesting();
      await expect(validateM365EnrollmentIdToken(await fixture.sign(), 'nonce', fetcherFor([{ ...fixture.publicJwk, ...patch }]))).rejects.toThrow('signature');
    }
    resetM365OidcCacheForTesting();
    await expect(validateM365EnrollmentIdToken(await fixture.sign(), 'nonce', fetcherFor([fixture.publicJwk, { ...fixture.publicJwk }]))).rejects.toThrow('signature');
    resetM365OidcCacheForTesting();
    const { issuer: _issuer, ...issuerless } = fixture.publicJwk;
    await expect(validateM365EnrollmentIdToken(await fixture.sign(), 'nonce', fetcherFor([issuerless]))).rejects.toThrow('signature');
  });

  it('allows issuer-less keys only from tenant-specific JWKS metadata', async () => {
    const fixture = await signer();
    const { issuer: _issuer, ...issuerless } = fixture.publicJwk;
    const fetcher: Fetcher = async url => String(url).includes('openid-configuration')
      ? new Response(JSON.stringify({
          issuer: `https://login.microsoftonline.com/${CONFIG.account.tenantId}/v2.0`,
          jwks_uri: `https://login.microsoftonline.com/${CONFIG.account.tenantId}/discovery/v2.0/keys`,
        }))
      : new Response(JSON.stringify({ keys: [issuerless] }));
    await expect(validateM365EnrollmentIdToken(await fixture.sign(), 'nonce', fetcher)).resolves.toBeDefined();
  });

  it('force-refreshes JWKS for unknown kid and signature rollover', async () => {
    const first = await signer('shared');
    const second = await signer('second');
    let calls = 0;
    const unknownKidFetcher = fetcherFor(() => (++calls === 1 ? [first.publicJwk] : [second.publicJwk]));
    await expect(validateM365EnrollmentIdToken(await second.sign(), 'nonce', unknownKidFetcher)).resolves.toBeDefined();
    expect(calls).toBe(2);

    resetM365OidcCacheForTesting();
    const replacement = await signer('shared');
    calls = 0;
    const signatureFetcher = fetcherFor(() => (++calls === 1 ? [first.publicJwk] : [replacement.publicJwk]));
    await expect(validateM365EnrollmentIdToken(await replacement.sign(), 'nonce', signatureFetcher)).resolves.toBeDefined();
    expect(calls).toBe(2);
  });

  it('sanitizes failures without echoing the ID token', async () => {
    const token = 'secret-token-material';
    const error = await validateM365EnrollmentIdToken(token, 'nonce', fetcherFor([])).catch(value => value);
    expect(error.message).not.toContain(token);
  });

  it('uses one deadline for hung discovery fetches and JWKS body reads', async () => {
    const fixture = await signer();
    const token = await fixture.sign();
    vi.useFakeTimers();
    try {
      const hungFetch: Fetcher = async () => await new Promise<Response>(() => {});
      const fetchTimeout = validateM365EnrollmentIdToken(token, 'nonce', hungFetch);
      const fetchRejected = expect(fetchTimeout).rejects.toMatchObject({ oauthCode: 'oidc_timeout' });
      await vi.advanceTimersByTimeAsync(M365_OIDC_TIMEOUT_MS);
      await fetchRejected;

      resetM365OidcCacheForTesting();
      const hungBody: Fetcher = async url => String(url).includes('openid-configuration')
        ? new Response(JSON.stringify({
            issuer: `https://login.microsoftonline.com/${CONFIG.account.tenantId}/v2.0`,
            jwks_uri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
          }))
        : { ok: true, status: 200, text: async () => await new Promise<string>(() => {}) } as Response;
      const bodyTimeout = validateM365EnrollmentIdToken(token, 'nonce', hungBody);
      const bodyRejected = expect(bodyTimeout).rejects.toMatchObject({ oauthCode: 'oidc_timeout' });
      await vi.advanceTimersByTimeAsync(M365_OIDC_TIMEOUT_MS);
      await bodyRejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves the original OIDC transport error as the cause', async () => {
    const fixture = await signer();
    const transportError = new Error('socket failed');
    const error = await validateM365EnrollmentIdToken(await fixture.sign(), 'nonce', async () => { throw transportError; }).catch(value => value);
    expect(error).toMatchObject({ oauthCode: 'oidc_discovery_failed', cause: transportError });
  });
});
