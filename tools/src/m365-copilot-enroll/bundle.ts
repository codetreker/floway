import {
  M365_OAUTH_CLIENT_ID,
  assertM365EnrollmentBundle,
  type M365EnrollmentBundle,
  type M365LoopbackRedirectUri,
} from '@floway-dev/provider-m365-copilot-web/enrollment';

export { M365_ENROLLMENT_MAX_AGE_MS } from '@floway-dev/provider-m365-copilot-web/enrollment';
export { assertM365EnrollmentBundle, type M365EnrollmentBundle };

export const createM365EnrollmentBundle = (input: {
  authorizationCode: string;
  codeVerifier: string;
  nonce: string;
  redirectUri: M365LoopbackRedirectUri;
  issuedAt?: Date;
}): M365EnrollmentBundle => {
  const issuedAt = input.issuedAt ?? new Date();
  const bundle: M365EnrollmentBundle = {
    schema: 'floway.m365-copilot-web-enrollment',
    version: 1,
    issuedAt: issuedAt.toISOString(),
    clientId: M365_OAUTH_CLIENT_ID,
    redirectUri: input.redirectUri,
    authorizationCode: input.authorizationCode,
    codeVerifier: input.codeVerifier,
    nonce: input.nonce,
  };
  assertM365EnrollmentBundle(bundle, issuedAt.getTime());
  return bundle;
};
