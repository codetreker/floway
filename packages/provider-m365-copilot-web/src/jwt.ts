import { normalizeM365ChatHubPath } from './config.ts';
import { M365ProtocolError } from './errors.ts';

export interface M365JwtIdentity {
  tenantId: string;
  objectId: string;
  username?: string;
  expiresAt: number;
}

const decodeBase64Url = (value: string): string => {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  try {
    const binary = atob(base64);
    return new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
  } catch (error) {
    throw new M365ProtocolError('M365 access token has an invalid JWT payload encoding', { cause: error });
  }
};

export const parseM365JwtIdentity = (accessToken: string): M365JwtIdentity | null => {
  const parts = accessToken.split('.');
  if (parts.length !== 3) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64Url(parts[1]!));
  } catch (error) {
    if (error instanceof M365ProtocolError) throw error;
    throw new M365ProtocolError('M365 access token has an invalid JWT payload', { cause: error });
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new M365ProtocolError('M365 access token JWT payload must be an object');
  }
  const claims = payload as Record<string, unknown>;
  if (typeof claims.tid !== 'string' || claims.tid.length === 0) throw new M365ProtocolError('M365 access token JWT is missing tid');
  if (typeof claims.oid !== 'string' || claims.oid.length === 0) throw new M365ProtocolError('M365 access token JWT is missing oid');
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) throw new M365ProtocolError('M365 access token JWT is missing exp');
  const username = typeof claims.preferred_username === 'string'
    ? claims.preferred_username
    : typeof claims.upn === 'string'
      ? claims.upn
      : undefined;
  return { tenantId: claims.tid, objectId: claims.oid, expiresAt: claims.exp * 1000, ...(username ? { username } : {}) };
};

// Sydney access tokens can be JWTs or opaque/JWE values. Account identity is
// established from the enrollment ID token; the ChatHub path is persisted and
// treated as opaque during data-plane calls.
// https://github.com/diegosouzapw/OmniRoute/blob/c0b2253f21c2e70c5d73581ae1be6f60a4ac5647/open-sse/executors/copilot-m365-connection.ts#L121-L198
export const resolveM365ChatHubPath = (configuredPath: string): string =>
  normalizeM365ChatHubPath(configuredPath);
