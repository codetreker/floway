import { describe, expect, it, vi } from 'vitest';

import { CONFIG, recordFixture, stateFixture } from './fixtures.ts';
import { ensureM365AccessToken, refreshM365Credential } from '../src/access-token.ts';
import { M365_OAUTH_CLIENT_ID, assertM365EnrollmentBundle, assertM365LoopbackRedirectUri } from '../src/enrollment.ts';
import { M365OAuthError } from '../src/errors.ts';
import { createM365ImportedCredential, exchangeM365EnrollmentBundle, refreshM365AccessToken } from '../src/oauth.ts';
import { initProviderRepo, type Fetcher } from '@floway-dev/provider';

const bundle = (issuedAt = new Date().toISOString()) => ({
  schema: 'floway.m365-copilot-web-enrollment' as const,
  version: 1 as const,
  issuedAt,
  clientId: M365_OAUTH_CLIENT_ID,
  redirectUri: 'http://localhost:49152/',
  authorizationCode: 'code',
  codeVerifier: 'v'.repeat(43),
  nonce: 'nonce',
});

describe('M365 OAuth', () => {
  it('validates the one-time system-browser loopback enrollment flow', () => {
    expect(() => assertM365EnrollmentBundle(bundle())).not.toThrow();
    expect(() => assertM365LoopbackRedirectUri('http://localhost:1024/')).not.toThrow();
    expect(() => assertM365LoopbackRedirectUri('http://localhost:65535/')).not.toThrow();
    expect(() => assertM365EnrollmentBundle(bundle(new Date(Date.now() - 10 * 60 * 1000).toISOString()))).toThrow('expired');
    expect(() => assertM365EnrollmentBundle({ ...bundle(), extra: true })).toThrow('unexpected key');
    for (const redirectUri of [
      'https://localhost:49152/',
      'http://127.0.0.1:49152/',
      'http://localhost/',
      'http://localhost:80/',
      'http://localhost:49152',
      'http://LOCALHOST:49152/',
      'http://user@localhost:49152/',
      'http://localhost:49152/callback',
      'http://localhost:49152/?query=1',
      'http://localhost:49152/#fragment',
    ]) {
      expect(() => assertM365EnrollmentBundle({ ...bundle(), redirectUri })).toThrow('redirectUri');
    }
  });

  it('exchanges the code with the exact validated dynamic redirect URI', async () => {
    const fetcher: Fetcher = vi.fn(async (_url, init) => {
      const parameters = new URLSearchParams(String(init.body));
      expect(parameters.get('client_id')).toBe(M365_OAUTH_CLIENT_ID);
      expect(parameters.get('redirect_uri')).toBe('http://localhost:49152/');
      return new Response(JSON.stringify({
        access_token: 'access', refresh_token: 'refresh', id_token: 'id', token_type: 'Bearer', expires_in: 3600,
      }));
    });
    await expect(exchangeM365EnrollmentBundle(bundle(), fetcher)).resolves.toMatchObject({
      accessToken: 'access', refreshToken: 'refresh', idToken: 'id',
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('refreshes only the chat audience at the tenant endpoint', async () => {
    const fetcher: Fetcher = vi.fn(async (url, init) => {
      expect(url).toContain(CONFIG.account.tenantId);
      expect(new URLSearchParams(String(init.body)).get('scope')).toContain('M365Chat.Read');
      return new Response(JSON.stringify({ access_token: 'access', refresh_token: 'rotated', token_type: 'Bearer', expires_in: 3600 }));
    });
    await expect(refreshM365AccessToken({ refreshToken: 'refresh', tenantId: CONFIG.account.tenantId, fetcher })).resolves.toMatchObject({ accessToken: 'access', refreshToken: 'rotated' });
  });

  it('preserves consent suberrors without exposing secrets', async () => {
    const fetcher: Fetcher = async () => new Response(JSON.stringify({ error: 'invalid_grant', suberror: 'consent_required', error_description: 'consent' }), { status: 400 });
    const error = await refreshM365AccessToken({ refreshToken: 'secret', tenantId: CONFIG.account.tenantId, fetcher }).catch(value => value);
    expect(error).toBeInstanceOf(M365OAuthError);
    expect(error).toMatchObject({ requiresInteraction: true, terminal: false, suberror: 'consent_required' });
    expect(error.message).not.toContain('secret');
  });

  it('bounds token responses and times out a hung OAuth request', async () => {
    const oversized: Fetcher = async () => new Response(JSON.stringify({ access_token: 'x'.repeat(64 * 1024 + 1), token_type: 'Bearer', expires_in: 3600 }));
    await expect(refreshM365AccessToken({ refreshToken: 'refresh', tenantId: CONFIG.account.tenantId, fetcher: oversized })).rejects.toThrow('invalid access_token');

    vi.useFakeTimers();
    try {
      const hung: Fetcher = async () => await new Promise<Response>(() => {});
      const pending = refreshM365AccessToken({ refreshToken: 'refresh', tenantId: CONFIG.account.tenantId, fetcher: hung });
      const rejected = expect(pending).rejects.toMatchObject({ oauthCode: 'oauth_timeout' });
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('atomically persists a rotated refresh token and access token', async () => {
    let state = stateFixture();
    state.credential = { ...state.credential, health: 'reauth_required', stateMessage: 'invalid_grant' };
    initProviderRepo(() => ({
      upstreams: {
        getById: async () => ({ ...recordFixture(state), state }),
        saveState: async (_id, mutate) => { state = mutate(state) as typeof state; },
      },
    }));
    const fetcher: Fetcher = vi.fn(async () => new Response(JSON.stringify({ access_token: 'access', refresh_token: 'rotated', token_type: 'Bearer', expires_in: 3600 })));
    await expect(ensureM365AccessToken('m365', fetcher)).resolves.toMatchObject({ token: 'access', credentialGeneration: 2 });
    expect(state.credential.refreshToken).toBe('rotated');
    expect(state.credential).toMatchObject({ health: 'active', stateMessage: undefined });
    expect(state.accessToken?.token).toBe('access');
  });

  it('clears stale credential health after a successful non-rotating refresh', async () => {
    let state = stateFixture();
    state.credential = { ...state.credential, health: 'refresh_failed', stateMessage: 'transient' };
    initProviderRepo(() => ({
      upstreams: {
        getById: async () => ({ ...recordFixture(state), state }),
        saveState: async (_id, mutate) => { state = mutate(state) as typeof state; },
      },
    }));
    const fetcher: Fetcher = async () => new Response(JSON.stringify({ access_token: 'access', token_type: 'Bearer', expires_in: 3600 }));
    await refreshM365Credential('m365', fetcher);
    expect(state.credential).toMatchObject({ refreshToken: 'refresh-token', generation: 1, health: 'active', stateMessage: undefined });
  });

  it('creates clean imported runtime state', () => {
    const imported = createM365ImportedCredential({
      tokens: { accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600 },
      identity: { tenantId: CONFIG.account.tenantId, objectId: CONFIG.account.objectId, username: CONFIG.account.username },
      locale: CONFIG.locale, timeZone: CONFIG.timeZone, timeZoneOffsetMinutes: CONFIG.timeZoneOffsetMinutes,
    });
    expect(imported.state).toMatchObject({ toneReceipts: {}, sessions: {}, accountLease: null });
  });

  it('singleflights concurrent forced refresh without rotating the winner twice', async () => {
    let state = stateFixture();
    initProviderRepo(() => ({
      upstreams: {
        getById: async () => ({ ...recordFixture(state), state }),
        saveState: async (_id, mutate) => { state = mutate(state) as typeof state; },
      },
    }));
    const fetcher: Fetcher = vi.fn(async () => new Response(JSON.stringify({ access_token: 'access', refresh_token: 'rotated', token_type: 'Bearer', expires_in: 3600 })));
    await Promise.all([refreshM365Credential('m365', fetcher), refreshM365Credential('m365', fetcher)]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(state.credential).toMatchObject({ refreshToken: 'rotated', generation: 2 });
  });

  it('persists only sanitized OAuth classification on invalid_grant', async () => {
    let state = stateFixture();
    initProviderRepo(() => ({
      upstreams: {
        getById: async () => ({ ...recordFixture(state), state }),
        saveState: async (_id, mutate) => { state = mutate(state) as typeof state; },
      },
    }));
    const fetcher: Fetcher = async () => new Response(JSON.stringify({
      error: 'invalid_grant', error_description: 'operator@example.com secret trace detail',
    }), { status: 400 });
    await expect(refreshM365Credential('m365', fetcher)).rejects.toThrow('invalid_grant');
    expect(state.credential.stateMessage).toBe('invalid_grant');
    expect(JSON.stringify(state)).not.toContain('operator@example.com');
  });

  it('does not let an old invalid_grant poison a concurrent successful refresh', async () => {
    let state = stateFixture();
    initProviderRepo(() => ({
      upstreams: {
        getById: async () => ({ ...recordFixture(state), state }),
        saveState: async (_id, mutate) => { state = mutate(state) as typeof state; },
      },
    }));
    const fetcher: Fetcher = async () => {
      const refreshedAt = new Date().toISOString();
      state = {
        ...state,
        credential: { ...state.credential, health: 'active', stateUpdatedAt: refreshedAt },
        accessToken: { token: 'winner', expiresAt: Date.now() + 3_600_000, refreshedAt, credentialGeneration: 1 },
      };
      return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'old request failed' }), { status: 400 });
    };
    await expect(refreshM365Credential('m365', fetcher)).resolves.toMatchObject({ token: 'winner' });
    expect(state.credential.health).toBe('active');
    expect(state.accessToken?.token).toBe('winner');
  });

  it('retries the winner when invalid_grant loses the persistence CAS', async () => {
    let state = stateFixture();
    let replaceBeforeSave = true;
    initProviderRepo(() => ({
      upstreams: {
        getById: async () => ({ ...recordFixture(state), state }),
        saveState: async (_id, mutate) => {
          if (replaceBeforeSave) {
            replaceBeforeSave = false;
            const refreshedAt = new Date(Date.now() + 1).toISOString();
            state = {
              ...state,
              credential: { ...state.credential, stateUpdatedAt: refreshedAt },
              accessToken: { token: 'winner', expiresAt: Date.now() + 3_600_000, refreshedAt, credentialGeneration: 1 },
            };
          }
          state = mutate(state) as typeof state;
        },
      },
    }));
    const fetcher: Fetcher = async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    await expect(refreshM365Credential('m365', fetcher)).resolves.toMatchObject({ token: 'winner' });
    expect(state.credential.health).toBe('active');
  });
});
