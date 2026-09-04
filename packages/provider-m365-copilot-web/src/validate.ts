export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function assertPlainObject(value: unknown, where: string): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) throw new TypeError(`${where} must be a plain object`);
}

export const assertExactKeys = (value: Record<string, unknown>, allowed: ReadonlySet<string>, where: string): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${where} has unexpected key '${key}'`);
  }
};

export const readNonEmptyString = (value: unknown, where: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${where} must be a non-empty string`);
  return value;
};

export const readFiniteNumber = (value: unknown, where: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${where} must be a finite number`);
  return value;
};

export const readInteger = (value: unknown, where: string): number => {
  const number = readFiniteNumber(value, where);
  if (!Number.isInteger(number)) throw new TypeError(`${where} must be an integer`);
  return number;
};

export const readIsoDate = (value: unknown, where: string): string => {
  const text = readNonEmptyString(value, where);
  if (!Number.isFinite(Date.parse(text))) throw new TypeError(`${where} must be an ISO 8601 timestamp`);
  return text;
};

export const isSafeRecordKey = (key: string): boolean =>
  key !== '' && key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
