// Defensive copy of `flagOverrides` with keys sorted lexicographically so
// stored and cloned records compare deterministically. Re-validates each
// value because this is the only line of defense on the in-memory clone path.
export const normalizeFlagOverrides = (overrides: Record<string, boolean>): Record<string, boolean> => {
  const result: Record<string, boolean> = {};
  for (const id of Object.keys(overrides).sort()) {
    const value = (overrides as Record<string, unknown>)[id];
    if (typeof value !== 'boolean') {
      throw new Error(`flagOverrides[${JSON.stringify(id)}] must be a boolean, got ${typeof value}`);
    }
    result[id] = value;
  }
  return result;
};
