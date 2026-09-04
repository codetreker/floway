// https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
export const M365_OAUTH_CLIENT_ID = '96ff4394-9197-43aa-b393-6a41652e21f8';
export const M365_OAUTH_REDIRECT_URI = 'https://login.microsoftonline.com/common/oauth2/nativeclient';
export const M365_OAUTH_AUTHORIZE_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
// https://github.com/cramt/m365-copilot-proxy/blob/d7c6d8080bf2bb769c1949c2dfbe60bb7ca929c3/packages/core/src/auth.ts#L16-L33
export const M365_CHAT_SCOPES = [
  'https://substrate.office.com/sydney/M365Chat.Read',
  'https://substrate.office.com/sydney/sydney.readwrite',
] as const;
export const M365_ENROLLMENT_MAX_AGE_MS = 5 * 60 * 1000;
export const M365_ENROLLMENT_CLOCK_SKEW_MS = 30 * 1000;

export interface M365EnrollmentBundle {
  schema: 'floway.m365-copilot-web-enrollment';
  version: 1;
  issuedAt: string;
  clientId: typeof M365_OAUTH_CLIENT_ID;
  redirectUri: typeof M365_OAUTH_REDIRECT_URI;
  authorizationCode: string;
  codeVerifier: string;
  nonce: string;
}

const exactKeys = new Set(['schema', 'version', 'issuedAt', 'clientId', 'redirectUri', 'authorizationCode', 'codeVerifier', 'nonce']);

export const buildM365AuthorizationUrl = (input: {
  state: string;
  codeChallenge: string;
  nonce: string;
  loginHint?: string;
}): string => {
  const url = new URL(M365_OAUTH_AUTHORIZE_URL);
  url.searchParams.set('client_id', M365_OAUTH_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', M365_OAUTH_REDIRECT_URI);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', [...M365_CHAT_SCOPES, 'openid', 'profile', 'offline_access'].join(' '));
  url.searchParams.set('state', input.state);
  url.searchParams.set('nonce', input.nonce);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (input.loginHint !== undefined) url.searchParams.set('login_hint', input.loginHint);
  return url.toString();
};

export function assertM365EnrollmentBundle(value: unknown, now = Date.now()): asserts value is M365EnrollmentBundle {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('M365EnrollmentBundle must be a plain object');
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) if (!exactKeys.has(key)) throw new TypeError(`M365EnrollmentBundle has unexpected key '${key}'`);
  if (object.schema !== 'floway.m365-copilot-web-enrollment' || object.version !== 1) throw new TypeError('M365 enrollment schema/version is unsupported');
  if (typeof object.issuedAt !== 'string' || !Number.isFinite(Date.parse(object.issuedAt))) throw new TypeError('M365 enrollment issuedAt is invalid');
  const issuedAt = Date.parse(object.issuedAt);
  if (issuedAt > now + M365_ENROLLMENT_CLOCK_SKEW_MS || issuedAt < now - M365_ENROLLMENT_MAX_AGE_MS) throw new TypeError('M365 enrollment bundle is expired or from the future');
  if (object.clientId !== M365_OAUTH_CLIENT_ID || object.redirectUri !== M365_OAUTH_REDIRECT_URI) throw new TypeError('M365 enrollment OAuth client is invalid');
  if (typeof object.authorizationCode !== 'string' || object.authorizationCode.length === 0 || object.authorizationCode.length > 16 * 1024) throw new TypeError('M365 enrollment authorizationCode is invalid');
  if (typeof object.codeVerifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(object.codeVerifier)) throw new TypeError('M365 enrollment codeVerifier is not RFC 7636 compliant');
  if (typeof object.nonce !== 'string' || object.nonce.length === 0 || object.nonce.length > 512) throw new TypeError('M365 enrollment nonce is invalid');
}
