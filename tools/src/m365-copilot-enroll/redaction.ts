const OAUTH_PARAMETER = /([?&](?:code|code_verifier|nonce|state)=)[^&\s"']+/giu;
const BUNDLE_JSON_FIELD = /("(?:authorizationCode|codeVerifier|nonce)"\s*:\s*")[^"]*/gu;

const errorText = (error: unknown): string => {
  if (error instanceof Error) {
    const cause = error.cause === undefined ? '' : `: ${errorText(error.cause)}`;
    return `${error.name}: ${error.message}${cause}`;
  }
  return String(error);
};

export const redactM365AuthText = (value: string, secrets: readonly string[] = []): string => {
  let redacted = value
    .replace(OAUTH_PARAMETER, '$1[REDACTED]')
    .replace(BUNDLE_JSON_FIELD, '$1[REDACTED]');
  for (const secret of [...new Set(secrets)].filter(secret => secret.length > 0).sort((left, right) => right.length - left.length)) {
    redacted = redacted.replaceAll(secret, '[REDACTED]');
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) redacted = redacted.replaceAll(encoded, '[REDACTED]');
  }
  return redacted;
};

export const formatM365AuthError = (error: unknown, secrets: readonly string[] = []): string =>
  redactM365AuthText(errorText(error), secrets);
