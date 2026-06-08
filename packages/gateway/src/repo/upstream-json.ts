// Canonical JSON encoding for upstream rows. saveState's optimistic-concurrency
// CAS (UPDATE ... WHERE state_json IS ?) and the in-memory repo's CAS fallback
// compare serialized forms, so key order must be stable. config_json shares
// the encoder for symmetry.

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .toSorted()
        .map(key => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
};

// state_json is nullable; null/undefined collapse to SQL NULL.
export const serializeStoredState = (value: unknown): string | null =>
  value === null || value === undefined ? null : JSON.stringify(canonicalize(value));

// config_json is NOT NULL; an absent value is stored as the JSON literal `null`.
export const serializeStoredConfig = (value: unknown): string =>
  JSON.stringify(canonicalize(value === undefined ? null : value));
