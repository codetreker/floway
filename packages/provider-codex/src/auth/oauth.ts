import {
  CODEX_CLIENT_ID,
  CODEX_OAUTH_SCOPE,
  CODEX_OAUTH_TOKEN_URL,
  CODEX_OAUTH_USER_AGENT,
  CODEX_REDIRECT_URI,
} from '../constants.ts';

export interface CodexOAuthTokens {
  access_token: string;
  refresh_token: string;
  id_token: string;
  // Lifetime in seconds; the server's clock + this number define expires_at.
  expires_in: number;
}

// Terminal error: refresh_token is dead, operator must re-import. Distinct from
// generic OAuth 4xx so the request lifecycle can mark the upstream
// `refresh_failed` instead of merely surfacing the upstream message.
export class CodexOAuthSessionTerminatedError extends Error {
  constructor(public readonly upstreamMessage: string) {
    super(`Codex OAuth session terminated: ${upstreamMessage}`);
    this.name = 'CodexOAuthSessionTerminatedError';
  }
}

const codexTokenRequest = async (body: URLSearchParams, terminalCodes: ReadonlySet<string>): Promise<CodexOAuthTokens> => {
  const response = await fetch(CODEX_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': CODEX_OAUTH_USER_AGENT,
      accept: 'application/json',
    },
    body: body.toString(),
  });

  const rawText = await response.text();
  let parsed: unknown;
  try {
    parsed = rawText.length > 0 ? JSON.parse(rawText) : {};
  } catch {
    parsed = { _nonJsonBody: rawText };
  }

  const root = (typeof parsed === 'object' && parsed !== null) ? (parsed as Record<string, unknown>) : null;

  if (!response.ok) {
    let code: string | null = null;
    let message: string | null = null;
    if (typeof root?.error === 'string') {
      code = root.error;
      message = code;
    } else if (root && typeof root.error === 'object' && root.error !== null) {
      const err = root.error as Record<string, unknown>;
      if (typeof err.code === 'string') code = err.code;
      if (typeof err.message === 'string') message = err.message;
    }
    // Some OpenAI errors put the human-readable text under top-level `.detail`.
    if (message === null && typeof root?.detail === 'string') message = root.detail as string;
    message ??= rawText.slice(0, 256);
    if (code && terminalCodes.has(code)) {
      throw new CodexOAuthSessionTerminatedError(message);
    }
    throw new Error(`Codex OAuth /token returned ${response.status}: ${message}`);
  }

  if (root === null) throw new Error('Codex OAuth /token response is not an object');
  for (const key of ['access_token', 'refresh_token', 'id_token'] as const) {
    if (typeof root[key] !== 'string' || root[key] === '') {
      throw new Error(`Codex OAuth /token response missing ${key}`);
    }
  }
  if (typeof root.expires_in !== 'number' || !Number.isFinite(root.expires_in)) {
    throw new Error('Codex OAuth /token response missing expires_in');
  }
  return {
    access_token: root.access_token as string,
    refresh_token: root.refresh_token as string,
    id_token: root.id_token as string,
    expires_in: root.expires_in as number,
  };
};

export const exchangeCodexAuthorizationCode = async (opts: { code: string; codeVerifier: string }): Promise<CodexOAuthTokens> => {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CODEX_CLIENT_ID,
    code: opts.code,
    redirect_uri: CODEX_REDIRECT_URI,
    code_verifier: opts.codeVerifier,
  });
  // Only `app_session_terminated` is terminal here — `invalid_grant` on
  // exchange typically means the operator pasted a stale or wrong callback
  // URL, which is recoverable by restarting the PKCE flow rather than
  // re-importing.
  return await codexTokenRequest(body, new Set(['app_session_terminated']));
};

export const refreshCodexAccessToken = async (refreshToken: string): Promise<CodexOAuthTokens> => {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CODEX_CLIENT_ID,
    scope: CODEX_OAUTH_SCOPE,
  });
  // OAuth `invalid_grant` on the refresh path is unambiguous — the
  // refresh_token has been replayed, revoked, or expired. Same recovery as
  // `app_session_terminated`: the operator must re-import a fresh auth.json.
  // The error text varies ("Your refresh token has already been used to
  // generate a new access token", "Token is no longer valid", etc.); the code
  // is the stable signal.
  return await codexTokenRequest(body, new Set(['app_session_terminated', 'invalid_grant']));
};
