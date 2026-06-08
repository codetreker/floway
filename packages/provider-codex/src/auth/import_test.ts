import { afterEach, describe, expect, test, vi } from 'vitest';

import { extractCodexCallbackParams, importCodexFromAuthJson, importCodexFromCallback } from './import.ts';

const encodeBase64Url = (input: string): string => {
  const b64 = btoa(input);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const makeJwt = (payload: unknown): string => {
  const header = encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = encodeBase64Url(JSON.stringify(payload));
  return `${header}.${body}.fake-signature`;
};

const identityPayload = {
  'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'acc', chatgpt_user_id: 'usr' },
  'https://api.openai.com/profile': { email: 'a@b.com' },
};

afterEach(() => vi.restoreAllMocks());

describe('importCodexFromAuthJson', () => {
  test('happy path returns identity + tokens', async () => {
    const authJson = {
      tokens: {
        access_token: 'at1',
        refresh_token: 'rt1',
        id_token: makeJwt(identityPayload),
        account_id: 'acc',
      },
    };
    const result = await importCodexFromAuthJson(authJson);
    expect(result.config.accounts).toEqual([{ email: 'a@b.com', chatgptAccountId: 'acc', chatgptUserId: 'usr', planType: 'plus' }]);
    expect(result.state.accounts[0].chatgptAccountId).toBe('acc');
    expect(result.state.accounts[0].refresh_token).toBe('rt1');
    expect(result.state.accounts[0].state).toBe('active');
    expect(result.accessToken.access_token).toBe('at1');
    // expires_at defaults from now + a conservative TTL if auth.json doesn't carry one.
    expect(result.accessToken.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test('rejects malformed payload', async () => {
    await expect(importCodexFromAuthJson(null)).rejects.toThrow();
    await expect(importCodexFromAuthJson({})).rejects.toThrow(/tokens/);
    await expect(importCodexFromAuthJson({ tokens: { refresh_token: 'r', id_token: makeJwt(identityPayload) } })).rejects.toThrow(/access_token/);
  });

  test('id_token must contain identity claims', async () => {
    await expect(importCodexFromAuthJson({
      tokens: { access_token: 'a', refresh_token: 'r', id_token: makeJwt({ /* empty */ }) },
    })).rejects.toThrow();
  });
});

describe('extractCodexCallbackParams', () => {
  test('parses a full localhost URL', () => {
    const params = extractCodexCallbackParams('http://localhost:1455/auth/callback?code=CODE&state=STATE');
    expect(params).toEqual({ code: 'CODE', state: 'STATE' });
  });

  test('parses a raw query string', () => {
    expect(extractCodexCallbackParams('code=CODE&state=STATE')).toEqual({ code: 'CODE', state: 'STATE' });
    expect(extractCodexCallbackParams('?code=CODE&state=STATE')).toEqual({ code: 'CODE', state: 'STATE' });
  });

  test('throws on missing code/state', () => {
    expect(() => extractCodexCallbackParams('http://localhost:1455/auth/callback')).toThrow();
    expect(() => extractCodexCallbackParams('http://localhost:1455/auth/callback?code=CODE')).toThrow(/state/);
  });
});

describe('importCodexFromCallback', () => {
  test('exchanges code → tokens, parses identity, returns config+state', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      access_token: 'at', refresh_token: 'rt', id_token: makeJwt(identityPayload), expires_in: 600,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const result = await importCodexFromCallback({ code: 'CODE', codeVerifier: 'VER' });
    expect(result.config.accounts[0].email).toBe('a@b.com');
    expect(result.state.accounts[0].refresh_token).toBe('rt');
    expect(result.accessToken.access_token).toBe('at');
  });
});
