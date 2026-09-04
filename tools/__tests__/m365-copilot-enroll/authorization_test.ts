import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  createM365AuthorizationSecrets,
  createM365AuthorizationUrl,
} from '../../src/m365-copilot-enroll/authorization.ts';

const REDIRECT_URI = 'http://localhost:49152/';

describe('M365 MSAL system-browser authorization', () => {
  it('uses MSAL CryptoProvider-compatible PKCE material', async () => {
    const first = await createM365AuthorizationSecrets();
    const second = await createM365AuthorizationSecrets();
    expect(first.state).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.codeVerifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(first.codeChallenge).toBe(createHash('sha256').update(first.codeVerifier, 'ascii').digest('base64url'));
    expect(second.state).not.toBe(first.state);
    expect(second.nonce).not.toBe(first.nonce);
    expect(second.codeVerifier).not.toBe(first.codeVerifier);
  });

  it('builds the authorization URL through PublicClientApplication.getAuthCodeUrl', async () => {
    const getAuthCodeUrl = vi.fn(async request => {
      const url = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
      url.searchParams.set('client_id', '96ff4394-9197-43aa-b393-6a41652e21f8');
      url.searchParams.set('redirect_uri', request.redirectUri);
      url.searchParams.set('state', request.state!);
      url.searchParams.set('nonce', request.nonce!);
      url.searchParams.set('code_challenge', request.codeChallenge!);
      url.searchParams.set('code_challenge_method', request.codeChallengeMethod!);
      return url.toString();
    });
    const secrets = {
      state: '11111111-1111-4111-8111-111111111111',
      nonce: 'n'.repeat(43),
      codeVerifier: 'v'.repeat(43),
      codeChallenge: 'c'.repeat(43),
    };
    await expect(createM365AuthorizationUrl({
      redirectUri: REDIRECT_URI,
      secrets,
      loginHint: 'operator@example.com',
      client: { getAuthCodeUrl },
    })).resolves.toContain('/common/oauth2/v2.0/authorize');
    expect(getAuthCodeUrl).toHaveBeenCalledWith(expect.objectContaining({
      redirectUri: REDIRECT_URI,
      responseMode: 'query',
      codeChallenge: secrets.codeChallenge,
      codeChallengeMethod: 'S256',
      state: secrets.state,
      nonce: secrets.nonce,
      loginHint: 'operator@example.com',
      scopes: expect.arrayContaining([
        'https://substrate.office.com/sydney/M365Chat.Read',
        'https://substrate.office.com/sydney/sydney.readwrite',
      ]),
    }));
  });
});
