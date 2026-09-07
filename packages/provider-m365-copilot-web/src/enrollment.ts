// https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
export const M365_OAUTH_CLIENT_ID = '96ff4394-9197-43aa-b393-6a41652e21f8';
// https://github.com/cramt/m365-copilot-proxy/blob/d7c6d8080bf2bb769c1949c2dfbe60bb7ca929c3/packages/core/src/auth.ts#L16-L33
export const M365_CHAT_SCOPES = [
  'https://substrate.office.com/sydney/M365Chat.Read',
  'https://substrate.office.com/sydney/sydney.readwrite',
] as const;
export const M365_ENROLLMENT_MAX_AGE_MS = 5 * 60 * 1000;
export const M365_ENROLLMENT_CLOCK_SKEW_MS = 30 * 1000;
export const M365_LOOPBACK_MIN_PORT = 1024;
export const M365_LOOPBACK_MAX_PORT = 65_535;

export type M365LoopbackRedirectUri = `http://localhost:${number}/`;

export interface M365EnrollmentBundle {
  schema: 'floway.m365-copilot-web-enrollment';
  version: 1;
  issuedAt: string;
  clientId: typeof M365_OAUTH_CLIENT_ID;
  redirectUri: M365LoopbackRedirectUri;
  authorizationCode: string;
  codeVerifier: string;
  nonce: string;
}

const exactKeys = new Set(['schema', 'version', 'issuedAt', 'clientId', 'redirectUri', 'authorizationCode', 'codeVerifier', 'nonce']);

export function assertM365LoopbackRedirectUri(value: unknown): asserts value is M365LoopbackRedirectUri {
  if (typeof value !== 'string' || value.includes('?') || value.includes('#')) throw new TypeError('M365 enrollment redirectUri is invalid');
  let url: URL;
  try { url = new URL(value); } catch (error) {
    throw new TypeError('M365 enrollment redirectUri is invalid', { cause: error });
  }
  const port = Number(url.port);
  if (url.protocol !== 'http:'
    || url.hostname !== 'localhost'
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || url.port === ''
    || !Number.isInteger(port)
    || port < M365_LOOPBACK_MIN_PORT
    || port > M365_LOOPBACK_MAX_PORT
    || url.toString() !== value) {
    throw new TypeError('M365 enrollment redirectUri must be a canonical http://localhost:<port>/ loopback URI');
  }
}

export function assertM365EnrollmentBundle(value: unknown, now = Date.now()): asserts value is M365EnrollmentBundle {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('M365EnrollmentBundle must be a plain object');
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) if (!exactKeys.has(key)) throw new TypeError(`M365EnrollmentBundle has unexpected key '${key}'`);
  if (object.schema !== 'floway.m365-copilot-web-enrollment' || object.version !== 1) throw new TypeError('M365 enrollment schema/version is unsupported');
  if (typeof object.issuedAt !== 'string' || !Number.isFinite(Date.parse(object.issuedAt))) throw new TypeError('M365 enrollment issuedAt is invalid');
  const issuedAt = Date.parse(object.issuedAt);
  if (issuedAt > now + M365_ENROLLMENT_CLOCK_SKEW_MS || issuedAt < now - M365_ENROLLMENT_MAX_AGE_MS) throw new TypeError('M365 enrollment bundle is expired or from the future');
  if (object.clientId !== M365_OAUTH_CLIENT_ID) throw new TypeError('M365 enrollment OAuth client is invalid');
  assertM365LoopbackRedirectUri(object.redirectUri);
  if (typeof object.authorizationCode !== 'string' || object.authorizationCode.length === 0 || object.authorizationCode.length > 16 * 1024) throw new TypeError('M365 enrollment authorizationCode is invalid');
  if (typeof object.codeVerifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(object.codeVerifier)) throw new TypeError('M365 enrollment codeVerifier is not RFC 7636 compliant');
  if (typeof object.nonce !== 'string' || object.nonce.length === 0 || object.nonce.length > 512) throw new TypeError('M365 enrollment nonce is invalid');
}
