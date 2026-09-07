import { createM365Deadline, withM365Abort } from './deadline.ts';
import { M365_ENROLLMENT_CLOCK_SKEW_MS, M365_ENROLLMENT_MAX_AGE_MS, M365_OAUTH_CLIENT_ID } from './enrollment.ts';
import { M365OAuthError } from './errors.ts';
import type { M365ValidatedIdentity } from './oauth.ts';
import type { Fetcher } from '@floway-dev/provider';

type MicrosoftJwk = JsonWebKey & { kid?: string; use?: string; alg?: string; issuer?: string };
const CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const caches = new Map<string, { expiresAt: number; keys: MicrosoftJwk[] }>();
export const M365_OIDC_TIMEOUT_MS = 30_000;
const M365_OIDC_MAX_BODY_BYTES = 1024 * 1024;

const decodeBase64Url = (value: string): Uint8Array => {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  try {
    const binary = atob(base64);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch (error) {
    throw new M365OAuthError('invalid_id_token', 'M365 ID token contains invalid base64url', true, { cause: error });
  }
};

const arrayBufferOf = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const jsonPart = (value: string, label: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError(`${label} is not an object`);
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof M365OAuthError) throw error;
    throw new M365OAuthError('invalid_id_token', `M365 ID token ${label} is invalid`, true, { cause: error });
  }
};

const requestOidcJson = async (
  fetcher: Fetcher,
  url: string,
  signal: AbortSignal,
  oauthCode: 'oidc_discovery_failed' | 'jwks_failed',
  label: string,
): Promise<unknown> => {
  let response: Response;
  try {
    response = await withM365Abort(fetcher(url, { headers: { accept: 'application/json' }, signal }), signal);
  } catch (error) {
    if (error instanceof M365OAuthError && error.oauthCode === 'oidc_timeout') throw error;
    throw new M365OAuthError(oauthCode, `${label} request failed`, false, { cause: error });
  }
  if (!response.ok) throw new M365OAuthError(oauthCode, `${label} returned HTTP ${response.status}`, false);
  let raw: string;
  try {
    raw = await withM365Abort(response.text(), signal);
  } catch (error) {
    if (error instanceof M365OAuthError && error.oauthCode === 'oidc_timeout') throw error;
    throw new M365OAuthError(oauthCode, `${label} body read failed`, false, { cause: error });
  }
  if (new TextEncoder().encode(raw).byteLength > M365_OIDC_MAX_BODY_BYTES) {
    throw new M365OAuthError(oauthCode, `${label} response is too large`, false);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new M365OAuthError(oauthCode, `${label} response is not valid JSON`, false, { cause: error });
  }
};

const discovery = async (fetcher: Fetcher, tenantId: string, signal: AbortSignal): Promise<{ issuer: string; jwksUri: string; requireKeyIssuer: boolean }> => {
  const url = `https://login.microsoftonline.com/${tenantId}/v2.0/.well-known/openid-configuration`;
  const parsed = await requestOidcJson(fetcher, url, signal, 'oidc_discovery_failed', 'Microsoft OIDC discovery');
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new M365OAuthError('oidc_discovery_failed', 'Microsoft OIDC discovery response is invalid', false);
  const object = parsed as Record<string, unknown>;
  const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  if (object.issuer !== issuer || typeof object.jwks_uri !== 'string') throw new M365OAuthError('oidc_discovery_failed', 'Microsoft OIDC discovery metadata is inconsistent', false);
  const jwks = new URL(object.jwks_uri);
  const allowedPath = jwks.pathname === '/common/discovery/v2.0/keys' || jwks.pathname === `/${tenantId}/discovery/v2.0/keys`;
  if (jwks.protocol !== 'https:' || jwks.hostname !== 'login.microsoftonline.com' || !allowedPath || jwks.search || jwks.hash) {
    throw new M365OAuthError('oidc_discovery_failed', 'Microsoft OIDC discovery returned an untrusted JWKS URL', false);
  }
  return { issuer, jwksUri: jwks.toString(), requireKeyIssuer: jwks.pathname === '/common/discovery/v2.0/keys' };
};

const fetchKeys = async (fetcher: Fetcher, tenantId: string, now: number, force: boolean, signal: AbortSignal): Promise<{ issuer: string; keys: MicrosoftJwk[]; requireKeyIssuer: boolean }> => {
  const metadata = await discovery(fetcher, tenantId, signal);
  const cached = caches.get(tenantId);
  if (!force && cached !== undefined && cached.expiresAt > now) return { issuer: metadata.issuer, keys: cached.keys, requireKeyIssuer: metadata.requireKeyIssuer };
  const parsed = await requestOidcJson(fetcher, metadata.jwksUri, signal, 'jwks_failed', 'Microsoft JWKS');
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as Record<string, unknown>).keys)) throw new M365OAuthError('jwks_failed', 'Microsoft JWKS response is invalid', false);
  const keys = (parsed as { keys: unknown[] }).keys.filter((key): key is MicrosoftJwk => typeof key === 'object' && key !== null && !Array.isArray(key));
  caches.set(tenantId, { keys, expiresAt: now + 60 * 60 * 1000 });
  return { issuer: metadata.issuer, keys, requireKeyIssuer: metadata.requireKeyIssuer };
};

const usableKey = (key: MicrosoftJwk, kid: string, issuer: string, requireIssuer: boolean): boolean =>
  key.kid === kid
  && key.kty === 'RSA'
  && (key.use === undefined || key.use === 'sig')
  && (key.key_ops === undefined || key.key_ops.includes('verify'))
  && (key.alg === undefined || key.alg === 'RS256')
  && (!requireIssuer || key.issuer !== undefined)
  && (key.issuer === undefined || key.issuer === issuer || key.issuer === 'https://login.microsoftonline.com/{tenantid}/v2.0');

const verifyWithKeys = async (input: { keys: MicrosoftJwk[]; kid: string; issuer: string; requireKeyIssuer: boolean; signature: Uint8Array; signingInput: Uint8Array }): Promise<boolean> => {
  const candidates = input.keys.filter(key => usableKey(key, input.kid, input.issuer, input.requireKeyIssuer));
  if (candidates.length !== 1) return false;
  try {
    const key = await crypto.subtle.importKey('jwk', candidates[0]!, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, arrayBufferOf(input.signature), arrayBufferOf(input.signingInput));
  } catch {
    return false;
  }
};

export const resetM365OidcCacheForTesting = (): void => caches.clear();

export const validateM365EnrollmentIdToken = async (idToken: string, nonce: string, fetcher: Fetcher, now = Date.now(), signal?: AbortSignal): Promise<M365ValidatedIdentity> => {
  const deadline = createM365Deadline(signal, M365_OIDC_TIMEOUT_MS, () => new M365OAuthError('oidc_timeout', 'Microsoft OIDC validation timed out', false));
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new M365OAuthError('invalid_id_token', 'M365 ID token must be a signed JWT', true);
    const header = jsonPart(parts[0]!, 'header');
    const claims = jsonPart(parts[1]!, 'claims');
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length === 0) throw new M365OAuthError('invalid_id_token', 'M365 ID token must use RS256 with kid', true);
    if (typeof claims.tid !== 'string') throw new M365OAuthError('invalid_id_token', 'M365 ID token is missing tenant identity', true);
    const tenantId = claims.tid.toLowerCase();
    if (!UUID.test(tenantId) || tenantId === CONSUMER_TENANT) throw new M365OAuthError('invalid_id_token', 'M365 ID token tenant is invalid', true);
    const first = await fetchKeys(fetcher, tenantId, now, false, deadline.signal);
    const verifyInput = {
      kid: header.kid,
      issuer: first.issuer,
      requireKeyIssuer: first.requireKeyIssuer,
      signature: decodeBase64Url(parts[2]!),
      signingInput: new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    };
    const verified = await verifyWithKeys({ ...verifyInput, keys: first.keys })
    || await fetchKeys(fetcher, tenantId, now, true, deadline.signal).then(fresh => verifyWithKeys({ ...verifyInput, issuer: fresh.issuer, requireKeyIssuer: fresh.requireKeyIssuer, keys: fresh.keys }));
    if (!verified) throw new M365OAuthError('invalid_id_token', 'M365 ID token signature is invalid', true);
    const nowSeconds = Math.floor(now / 1000);
    const skewSeconds = Math.ceil(M365_ENROLLMENT_CLOCK_SKEW_MS / 1000);
    if (claims.ver !== '2.0' || typeof claims.sub !== 'string' || claims.sub.length === 0) throw new M365OAuthError('invalid_id_token', 'M365 ID token version or subject is invalid', true);
    if (claims.iss !== first.issuer || claims.aud !== M365_OAUTH_CLIENT_ID || claims.nonce !== nonce) throw new M365OAuthError('invalid_id_token', 'M365 ID token issuer, audience, or nonce is invalid', true);
    if (claims.azp !== undefined && claims.azp !== M365_OAUTH_CLIENT_ID) throw new M365OAuthError('invalid_id_token', 'M365 ID token authorized party is invalid', true);
    if (typeof claims.exp !== 'number' || claims.exp <= nowSeconds - skewSeconds) throw new M365OAuthError('invalid_id_token', 'M365 ID token is expired', true);
    if (typeof claims.nbf === 'number' && claims.nbf > nowSeconds + skewSeconds) throw new M365OAuthError('invalid_id_token', 'M365 ID token is not active', true);
    if (typeof claims.iat !== 'number' || claims.iat > nowSeconds + skewSeconds || claims.iat < nowSeconds - Math.ceil(M365_ENROLLMENT_MAX_AGE_MS / 1000) - skewSeconds) throw new M365OAuthError('invalid_id_token', 'M365 ID token issue time is invalid', true);
    if (typeof claims.oid !== 'string') throw new M365OAuthError('invalid_id_token', 'M365 ID token is missing object identity', true);
    const objectId = claims.oid.toLowerCase();
    if (!UUID.test(objectId)) throw new M365OAuthError('invalid_id_token', 'M365 ID token object identity is invalid', true);
    const username = typeof claims.preferred_username === 'string' ? claims.preferred_username : typeof claims.upn === 'string' ? claims.upn : null;
    if (username === null || username.length === 0 || username.length > 320) throw new M365OAuthError('invalid_id_token', 'M365 ID token username is invalid', true);
    return { tenantId, objectId, username };
  } finally {
    deadline.dispose();
  }
};
