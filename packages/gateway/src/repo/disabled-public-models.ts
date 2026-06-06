// Defensive copy of `disabledPublicModelIds`: trimmed, with empty entries
// dropped and duplicates removed while preserving first-seen order. The
// re-validation of element types is the only line of defense on the
// in-memory clone path (the SQL read and import paths validate first).
export const normalizeDisabledPublicModelIds = (ids: readonly string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of ids) {
    if (typeof raw !== 'string') {
      throw new Error(`disabledPublicModelIds entries must be strings, got ${typeof raw}`);
    }
    const id = raw.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
};

// Wire-form parser for the import path. An absent field means "nothing
// disabled" (older exports predate the column). A present value must be a
// string array.
export const parseDisabledPublicModelIdsWire = (value: unknown): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('disabled_public_model_ids must be an array of strings');
  for (const entry of value) {
    if (typeof entry !== 'string') throw new Error('disabled_public_model_ids entries must be strings');
  }
  return normalizeDisabledPublicModelIds(value as string[]);
};
