const REDACTIONS: readonly [RegExp, string][] = [
  [/([?&](?:access_token|refresh_token|id_token|code|code_verifier)=)[^&\s]+/gi, '$1[REDACTED]'],
  [/(\bBearer\s+)[^\s,;]+/gi, '$1[REDACTED]'],
  [/("(?:accessToken|refreshToken|idToken|authorizationCode|codeVerifier|code)"\s*:\s*")[^"]+/gi, '$1[REDACTED]'],
  [/(\b(?:access_token|refresh_token|id_token|authorization_code|code_verifier)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]'],
];

const redact = (value: string): string => REDACTIONS.reduce(
  (current, [pattern, replacement]) => current.replace(pattern, replacement),
  value,
);

const describeError = (error: unknown, depth = 0): string => {
  if (!(error instanceof Error)) return String(error);
  const own = error.stack ?? `${error.name}: ${error.message}`;
  if (error.cause === undefined || depth >= 4) return own;
  return `${own}\nCaused by: ${describeError(error.cause, depth + 1)}`;
};

export const redactM365ActionErrorForLog = (error: unknown): string => redact(describeError(error));

export const logM365ActionFailure = (operation: string, error: unknown): void => {
  console.error(`${operation} failed\n${redactM365ActionErrorForLog(error)}`);
};
