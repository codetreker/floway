const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
  'x-goog-api-key',
]);

export const isSensitiveHeader = (key: string): boolean => SENSITIVE_HEADERS.has(key.toLowerCase());

// Keep prefix/suffix so an operator can recognize the credential shape
// (`sk-ant-…`) and match the tail against notes. Values short enough to have
// no middle collapse entirely — keeping any visible bytes would leak the lot.
const VISIBLE_PREFIX = 8;
const VISIBLE_SUFFIX = 8;
const SAFE_MIN_LENGTH = VISIBLE_PREFIX + VISIBLE_SUFFIX;

export const redactHeaderValue = (value: string): string => {
  if (value.length <= SAFE_MIN_LENGTH) return '•'.repeat(value.length);
  return `${value.slice(0, VISIBLE_PREFIX)}${'•'.repeat(value.length - SAFE_MIN_LENGTH)}${value.slice(-VISIBLE_SUFFIX)}`;
};
