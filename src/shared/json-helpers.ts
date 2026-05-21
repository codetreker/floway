export type JsonObject = Record<string, unknown>;

export const asJsonObject = (value: unknown): JsonObject | null => (value !== null && typeof value === 'object' ? (value as JsonObject) : null);

export const readJsonNumber = (value: unknown): number | null => (typeof value === 'number' ? value : null);
