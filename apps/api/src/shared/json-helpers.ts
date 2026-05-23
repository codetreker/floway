export type JsonObject = Record<string, unknown>;

export const asJsonObject = (value: unknown): JsonObject | null => (value !== null && typeof value === 'object' ? (value as JsonObject) : null);

export const readJsonNumber = (value: unknown): number | null => (typeof value === 'number' ? value : null);

// Strict object guard: rejects arrays. Use when keying into an object as if
// it were a JSON dictionary.
export const isJsonObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

// Permissive guard: accepts arrays as well as plain objects. Use when the
// upstream wire format allows either ('arrays of …') and the next narrowing
// step distinguishes them.
export const isObjectLike = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null;
