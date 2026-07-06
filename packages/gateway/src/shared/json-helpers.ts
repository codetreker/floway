export { isJsonObject, type JsonObject } from '@floway-dev/protocols/common';

export const asJsonObject = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null);

export const readJsonNumber = (value: unknown): number | null => (typeof value === 'number' ? value : null);

// Permissive guard: accepts arrays as well as plain objects. Use when the
// upstream wire format allows either ('arrays of …') and the next narrowing
// step distinguishes them.
export const isObjectLike = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
