// Shared helpers for the `flagOverrides` JSON column on upstreams.
//
// `normalizeFlagOverrides` returns a defensive copy of the input map with
// keys sorted lexicographically so stored / cloned records compare
// deterministically (tests do shape equality, and ordered keys also make
// generated SQL diff cleanly under `wrangler d1 execute`). It re-validates
// each value because the function sits at a layer below the wire-form
// validator and is called both on persistence paths (where a malformed
// `boolean` would have been rejected upstream) and on in-memory clone paths
// (where the validation is the only line of defense).
//
// JSON parsing for the D1 read path lives in `d1.ts::parseFlagOverrides`
// because the error chain there carries the row id and JSON-shape diagnostics
// specific to that path.
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
