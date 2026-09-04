import { createHash, randomBytes } from 'node:crypto';

export interface M365PkceAuthorization {
  state: string;
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
}

const base64Url = (value: Uint8Array): string => Buffer.from(value).toString('base64url');

export const createM365PkceAuthorization = (): M365PkceAuthorization => {
  const codeVerifier = base64Url(randomBytes(64));
  return {
    state: base64Url(randomBytes(32)),
    nonce: base64Url(randomBytes(32)),
    codeVerifier,
    codeChallenge: createHash('sha256').update(codeVerifier, 'ascii').digest('base64url'),
  };
};
