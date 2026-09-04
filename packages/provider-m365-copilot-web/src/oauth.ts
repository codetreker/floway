import { assertM365CopilotWebUpstreamConfig, type M365CopilotWebUpstreamConfig } from './config.ts';
import { M365_CHAT_SCOPES, M365_OAUTH_CLIENT_ID, assertM365EnrollmentBundle, assertM365LoopbackRedirectUri, type M365LoopbackRedirectUri } from './enrollment.ts';
import { M365OAuthError } from './errors.ts';
import { validateM365EnrollmentIdToken } from './oidc.ts';
import { assertM365CopilotWebUpstreamState, type M365CopilotWebUpstreamState } from './state.ts';
import type { Fetcher } from '@floway-dev/provider';

// https://github.com/cramt/m365-copilot-proxy/blob/d7c6d8080bf2bb769c1949c2dfbe60bb7ca929c3/packages/core/src/auth.ts#L10-L19
export const M365_OAUTH_TOKEN_URL = (tenantId: string): string =>
  `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;

const BASE_SCOPES = ['openid', 'profile', 'offline_access'] as const;
const TERMINAL_OAUTH_CODES = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client', 'access_denied']);
const MAX_OAUTH_TOKEN_LENGTH = 64 * 1024;
const MAX_OAUTH_SCOPE_LENGTH = 8 * 1024;
const OAUTH_REQUEST_TIMEOUT_MS = 30_000;

export interface M365OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresIn: number;
  scope?: string;
}

export interface M365ValidatedIdentity {
  tenantId: string;
  objectId: string;
  username: string;
}

const parseTokenResponse = async (response: Response): Promise<M365OAuthTokens> => {
  const raw = await response.text();
  let parsed: unknown;
  try { parsed = raw.length === 0 ? {} : JSON.parse(raw); } catch (error) {
    throw new M365OAuthError('invalid_response', `M365 OAuth returned non-JSON data with status ${response.status}`, false, { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new M365OAuthError('invalid_response', 'M365 OAuth response must be an object', false);
  const object = parsed as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof object.error === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(object.error) ? object.error : 'oauth_request_failed';
    const suberror = typeof object.suberror === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(object.suberror) ? object.suberror : undefined;
    const requiresInteraction = code === 'interaction_required' || code === 'consent_required' || suberror === 'interaction_required' || suberror === 'consent_required';
    const classification = suberror === undefined ? code : `${code}:${suberror}`;
    throw new M365OAuthError(code, `M365 OAuth request failed with ${classification} (HTTP ${response.status})`, !requiresInteraction && TERMINAL_OAUTH_CODES.has(code), undefined, suberror);
  }
  if (typeof object.access_token !== 'string' || object.access_token.length === 0 || object.access_token.length > MAX_OAUTH_TOKEN_LENGTH) throw new M365OAuthError('invalid_response', 'M365 OAuth response has invalid access_token', false);
  if (object.token_type !== 'Bearer') throw new M365OAuthError('invalid_response', 'M365 OAuth response token_type must be Bearer', false);
  if (typeof object.expires_in !== 'number' || !Number.isFinite(object.expires_in) || object.expires_in <= 0) throw new M365OAuthError('invalid_response', 'M365 OAuth response has invalid expires_in', false);
  if (object.refresh_token !== undefined && (typeof object.refresh_token !== 'string' || object.refresh_token.length === 0 || object.refresh_token.length > MAX_OAUTH_TOKEN_LENGTH)) throw new M365OAuthError('invalid_response', 'M365 OAuth response has invalid refresh_token', false);
  if (object.id_token !== undefined && (typeof object.id_token !== 'string' || object.id_token.length === 0 || object.id_token.length > MAX_OAUTH_TOKEN_LENGTH)) throw new M365OAuthError('invalid_response', 'M365 OAuth response has invalid id_token', false);
  if (object.scope !== undefined && (typeof object.scope !== 'string' || object.scope.length > MAX_OAUTH_SCOPE_LENGTH)) throw new M365OAuthError('invalid_response', 'M365 OAuth response has invalid scope', false);
  return {
    accessToken: object.access_token,
    expiresIn: object.expires_in,
    ...(typeof object.refresh_token === 'string' && object.refresh_token.length > 0 ? { refreshToken: object.refresh_token } : {}),
    ...(typeof object.id_token === 'string' && object.id_token.length > 0 ? { idToken: object.id_token } : {}),
    ...(typeof object.scope === 'string' ? { scope: object.scope } : {}),
  };
};

const tokenRequest = async (url: string, body: URLSearchParams, fetcher: Fetcher, signal?: AbortSignal): Promise<M365OAuthTokens> => {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new M365OAuthError('oauth_timeout', 'M365 OAuth request timed out', false)), OAUTH_REQUEST_TIMEOUT_MS);
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(controller.signal.reason ?? new DOMException('Aborted', 'AbortError'));
  if (controller.signal.aborted) abort();
  else controller.signal.addEventListener('abort', abort, { once: true });
  try {
    const response = await Promise.race([
      fetcher(url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: controller.signal,
      }),
      aborted,
    ]);
    return await parseTokenResponse(response);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', abort);
    signal?.removeEventListener('abort', forwardAbort);
  }
};

export const exchangeM365AuthorizationCode = async (input: {
  code: string;
  codeVerifier: string;
  redirectUri: M365LoopbackRedirectUri;
  fetcher: Fetcher;
  signal?: AbortSignal;
}): Promise<M365OAuthTokens & { refreshToken: string; idToken: string }> => {
  assertM365LoopbackRedirectUri(input.redirectUri);
  const tokens = await tokenRequest(M365_OAUTH_TOKEN_URL('common'), new URLSearchParams({
    client_id: M365_OAUTH_CLIENT_ID,
    grant_type: 'authorization_code',
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
    scope: [...M365_CHAT_SCOPES, ...BASE_SCOPES].join(' '),
  }), input.fetcher, input.signal);
  if (tokens.refreshToken === undefined || tokens.idToken === undefined) throw new M365OAuthError('invalid_response', 'M365 OAuth enrollment exchange requires refresh_token and id_token', false);
  return { ...tokens, refreshToken: tokens.refreshToken, idToken: tokens.idToken };
};

export const exchangeM365EnrollmentBundle = async (bundle: unknown, fetcher: Fetcher, now = Date.now()) => {
  assertM365EnrollmentBundle(bundle, now);
  return await exchangeM365AuthorizationCode({ code: bundle.authorizationCode, codeVerifier: bundle.codeVerifier, redirectUri: bundle.redirectUri, fetcher });
};

export const completeM365Enrollment = async (input: {
  bundle: unknown;
  fetcher: Fetcher;
  locale: string;
  timeZone: string;
  timeZoneOffsetMinutes: number;
  now?: Date;
  signal?: AbortSignal;
}) => {
  const now = input.now ?? new Date();
  assertM365EnrollmentBundle(input.bundle, now.getTime());
  const tokens = await exchangeM365AuthorizationCode({
    code: input.bundle.authorizationCode,
    codeVerifier: input.bundle.codeVerifier,
    redirectUri: input.bundle.redirectUri,
    fetcher: input.fetcher,
    signal: input.signal,
  });
  const identity = await validateM365EnrollmentIdToken(tokens.idToken, input.bundle.nonce, input.fetcher, now.getTime(), input.signal);
  return createM365ImportedCredential({ ...input, tokens, identity, now });
};

export const refreshM365AccessToken = async (input: {
  refreshToken: string;
  tenantId: string;
  fetcher: Fetcher;
  signal?: AbortSignal;
}): Promise<M365OAuthTokens> => await tokenRequest(M365_OAUTH_TOKEN_URL(input.tenantId), new URLSearchParams({
  client_id: M365_OAUTH_CLIENT_ID,
  grant_type: 'refresh_token',
  refresh_token: input.refreshToken,
  scope: [...M365_CHAT_SCOPES, ...BASE_SCOPES].join(' '),
}), input.fetcher, input.signal);

export const createM365ImportedCredential = (input: {
  tokens: M365OAuthTokens & { refreshToken: string };
  identity: M365ValidatedIdentity;
  locale: string;
  timeZone: string;
  timeZoneOffsetMinutes: number;
  now?: Date;
}): { config: M365CopilotWebUpstreamConfig; state: M365CopilotWebUpstreamState } => {
  const now = input.now ?? new Date();
  const config: M365CopilotWebUpstreamConfig = {
    account: {
      tenantId: input.identity.tenantId.toLowerCase(),
      objectId: input.identity.objectId.toLowerCase(),
      username: input.identity.username,
      chatHubHost: 'substrate.office.com',
      chatHubPath: `${input.identity.objectId.toLowerCase()}@${input.identity.tenantId.toLowerCase()}`,
    },
    locale: input.locale,
    timeZone: input.timeZone,
    timeZoneOffsetMinutes: input.timeZoneOffsetMinutes,
  };
  assertM365CopilotWebUpstreamConfig(config);
  const state: M365CopilotWebUpstreamState = {
    credential: { credentialId: crypto.randomUUID(), refreshToken: input.tokens.refreshToken, generation: 1, health: 'active', stateUpdatedAt: now.toISOString() },
    accessToken: {
      token: input.tokens.accessToken,
      expiresAt: now.getTime() + input.tokens.expiresIn * 1000,
      refreshedAt: now.toISOString(),
      credentialGeneration: 1,
    },
    toneReceipts: {},
    sessions: {},
    accountLease: null,
  };
  assertM365CopilotWebUpstreamState(state);
  return { config, state };
};

export const sanitizeM365StateForBackupImport = (state: M365CopilotWebUpstreamState): M365CopilotWebUpstreamState => ({
  ...state,
  accessToken: null,
  toneReceipts: {},
  sessions: {},
  accountLease: null,
});
