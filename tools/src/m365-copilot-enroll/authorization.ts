import { randomBytes } from 'node:crypto';

import {
  CryptoProvider,
  LogLevel,
  PublicClientApplication,
  ResponseMode,
  type AuthorizationUrlRequest,
} from '@azure/msal-node';
import open from 'open';

import {
  M365_CHAT_SCOPES,
  M365_OAUTH_CLIENT_ID,
  type M365LoopbackRedirectUri,
} from '@floway-dev/provider-m365-copilot-web/enrollment';

// MSAL resolves the common Microsoft identity authority before constructing
// the public-client authorization URL.
// https://learn.microsoft.com/en-us/entra/identity-platform/msal-client-applications
const M365_AUTHORITY = 'https://login.microsoftonline.com/common';
const M365_AUTHORIZE_PATH = '/common/oauth2/v2.0/authorize';

export interface M365AuthorizationSecrets {
  state: string;
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
}

export interface M365AuthorizationUrlClient {
  getAuthCodeUrl(request: AuthorizationUrlRequest): Promise<string>;
}

export interface M365PkceProvider {
  createNewGuid(): string;
  generatePkceCodes(): Promise<{ verifier: string; challenge: string }>;
}

export const createM365AuthorizationSecrets = async (
  cryptoProvider: M365PkceProvider = new CryptoProvider(),
): Promise<M365AuthorizationSecrets> => {
  const { verifier, challenge } = await cryptoProvider.generatePkceCodes();
  const secrets = {
    state: cryptoProvider.createNewGuid(),
    nonce: randomBytes(32).toString('base64url'),
    codeVerifier: verifier,
    codeChallenge: challenge,
  };
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(secrets.codeVerifier)) throw new Error('MSAL generated an invalid PKCE verifier');
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(secrets.codeChallenge)) throw new Error('MSAL generated an invalid PKCE challenge');
  if (secrets.state.length === 0 || secrets.nonce.length === 0) throw new Error('MSAL authorization state and nonce must not be empty');
  return secrets;
};

const createPublicClient = (): M365AuthorizationUrlClient => new PublicClientApplication({
  auth: {
    clientId: M365_OAUTH_CLIENT_ID,
    authority: M365_AUTHORITY,
  },
  system: {
    loggerOptions: {
      loggerCallback: () => undefined,
      logLevel: LogLevel.Error,
      piiLoggingEnabled: false,
    },
  },
});

export const createM365AuthorizationUrl = async (input: {
  redirectUri: M365LoopbackRedirectUri;
  secrets: M365AuthorizationSecrets;
  loginHint?: string;
  client?: M365AuthorizationUrlClient;
}): Promise<string> => {
  const request: AuthorizationUrlRequest = {
    scopes: [...M365_CHAT_SCOPES],
    redirectUri: input.redirectUri,
    responseMode: ResponseMode.QUERY,
    codeChallenge: input.secrets.codeChallenge,
    codeChallengeMethod: 'S256',
    state: input.secrets.state,
    nonce: input.secrets.nonce,
    ...(input.loginHint === undefined ? {} : { loginHint: input.loginHint }),
  };
  const authorizationUrl = await (input.client ?? createPublicClient()).getAuthCodeUrl(request);
  const parsed = new URL(authorizationUrl);
  if (parsed.origin !== new URL(M365_AUTHORITY).origin
    || parsed.pathname !== M365_AUTHORIZE_PATH
    || parsed.searchParams.get('client_id') !== M365_OAUTH_CLIENT_ID
    || parsed.searchParams.get('redirect_uri') !== input.redirectUri
    || parsed.searchParams.get('state') !== input.secrets.state
    || parsed.searchParams.get('nonce') !== input.secrets.nonce
    || parsed.searchParams.get('code_challenge') !== input.secrets.codeChallenge
    || parsed.searchParams.get('code_challenge_method') !== 'S256') {
    throw new Error('MSAL generated an authorization URL that does not match the enrollment attempt');
  }
  return authorizationUrl;
};

export const openM365SystemBrowser = async (authorizationUrl: string): Promise<void> => {
  await open(authorizationUrl, { wait: false });
};
