import type { CodexAccessTokenCache } from '../access-token-cache.ts';
import type { CodexUpstreamConfig } from '../config.ts';
import type { CodexUpstreamState } from '../state.ts';
import { parseCodexIdTokenClaims } from './jwt.ts';
import { exchangeCodexAuthorizationCode } from './oauth.ts';

export interface CodexImportResult {
  config: CodexUpstreamConfig;
  state: CodexUpstreamState;
  accessToken: CodexAccessTokenCache;
}

// Path A — operator pasted ~/.codex/auth.json verbatim. The CLI's on-disk
// format wraps tokens under `.tokens`. We don't trust the file's
// account_id / email / plan fields; we re-derive identity from id_token so
// import semantics are uniform with Path B (which has only the OAuth response
// to work from).
export const importCodexFromAuthJson = async (authJson: unknown): Promise<CodexImportResult> => {
  const pickNonEmptyString = (record: Record<string, unknown>, key: string, prefix: string): string => {
    const value = record[key];
    if (typeof value !== 'string' || value === '') throw new TypeError(`${prefix}.${key} must be a non-empty string`);
    return value;
  };

  if (typeof authJson !== 'object' || authJson === null) throw new TypeError('auth.json must be a JSON object');
  const obj = authJson as Record<string, unknown>;
  const tokens = obj.tokens;
  if (typeof tokens !== 'object' || tokens === null) throw new TypeError('auth.json.tokens missing');
  const t = tokens as Record<string, unknown>;
  const accessToken = pickNonEmptyString(t, 'access_token', 'auth.json.tokens');
  const refreshToken = pickNonEmptyString(t, 'refresh_token', 'auth.json.tokens');
  const idToken = pickNonEmptyString(t, 'id_token', 'auth.json.tokens');

  const identity = parseCodexIdTokenClaims(idToken);
  const now = new Date().toISOString();
  const config: CodexUpstreamConfig = {
    accounts: [{
      email: identity.email,
      chatgptAccountId: identity.chatgptAccountId,
      chatgptUserId: identity.chatgptUserId,
      planType: identity.planType,
    }],
  };

  const state: CodexUpstreamState = {
    accounts: [{
      chatgptAccountId: identity.chatgptAccountId,
      refresh_token: refreshToken,
      state: 'active',
      state_updated_at: now,
    }],
  };

  // auth.json has no expires_in; conservative 7-day cache so the next request
  // refreshes via /oauth/token within the 5-min freshness gate.
  const sevenDaysSeconds = 7 * 24 * 60 * 60;
  return {
    config,
    state,
    accessToken: {
      access_token: accessToken,
      expires_at: Math.floor(Date.now() / 1000) + sevenDaysSeconds,
      refreshed_at: new Date().toISOString(),
    },
  };
};

// Accepts a full URL (`http://localhost:1455/auth/callback?...`) or a bare
// query string (with or without leading `?`). Returns the `code` + `state`
// query params or throws.
export const extractCodexCallbackParams = (input: string): { code: string; state: string } => {
  const trimmed = input.trim();
  let query: string;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      query = new URL(trimmed).search;
    } catch (cause) {
      throw new Error('Callback URL is malformed', { cause: cause as Error });
    }
  } else {
    query = trimmed.startsWith('?') ? trimmed : `?${trimmed}`;
  }
  const params = new URLSearchParams(query);
  const code = params.get('code');
  const state = params.get('state');
  if (!code) throw new Error('Callback URL is missing `code`');
  if (!state) throw new Error('Callback URL is missing `state`');
  return { code, state };
};

// Path B — exchange the authorization code for tokens, then derive identity
// from the returned id_token. The PKCE verifier was stored at PKCE-start time
// and supplied here.
export const importCodexFromCallback = async (opts: { code: string; codeVerifier: string }): Promise<CodexImportResult> => {
  const tokens = await exchangeCodexAuthorizationCode({ code: opts.code, codeVerifier: opts.codeVerifier });
  const identity = parseCodexIdTokenClaims(tokens.id_token);
  const now = new Date().toISOString();

  return {
    config: {
      accounts: [{
        email: identity.email,
        chatgptAccountId: identity.chatgptAccountId,
        chatgptUserId: identity.chatgptUserId,
        planType: identity.planType,
      }],
    },
    state: {
      accounts: [{
        chatgptAccountId: identity.chatgptAccountId,
        refresh_token: tokens.refresh_token,
        state: 'active',
        state_updated_at: now,
      }],
    },
    accessToken: {
      access_token: tokens.access_token,
      expires_at: Math.floor(Date.now() / 1000) + tokens.expires_in,
      refreshed_at: new Date().toISOString(),
    },
  };
};
