import type { StoredResponsesItemPayload } from './types.ts';
import { getFileProvider } from '../runtime/file-provider.ts';

type StoredResponsesPayloadJson =
  | {
    version: 1;
    storage: 'inline';
    payload: StoredResponsesItemPayload;
  }
  | {
    version: 1;
    storage: 'file';
    key: string;
    sha256: string;
    byteLength: number;
  };

const INLINE_PAYLOAD_LIMIT_BYTES = 512 * 1024;
// Read only by the scheduled cleanup (payload-file sweep + descriptor clear).
// Lookups intentionally do NOT filter by this TTL: a row stays referenceable
// until cleanup actually removes it, so expiry is driven by the sweeper alone.
export const RESPONSES_ITEM_PAYLOAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// Root under which every stored-payload file lives, regardless of expiry hour.
// The replace path deletes this whole tree alongside the D1 rows it clears.
const RESPONSES_ITEMS_FILE_ROOT = 'responses-items/v1/expires/';

const encoder = new TextEncoder();

export const serializeStoredResponsesPayload = async (
  id: string,
  apiKeyId: string | null,
  createdAt: number,
  payload: StoredResponsesItemPayload | null,
): Promise<string | null> => {
  if (payload === null) return null;

  const inlineJson = JSON.stringify({ version: 1, storage: 'inline', payload } satisfies StoredResponsesPayloadJson);
  if (encoder.encode(inlineJson).byteLength <= INLINE_PAYLOAD_LIMIT_BYTES) return inlineJson;

  // File body holds the raw payload only. The descriptor in D1's
  // `payload_json` column carries version, storage discriminator, key,
  // sha256, and byteLength; the body itself does not repeat them.
  const fileBody = encoder.encode(JSON.stringify(payload));
  const sha256 = await sha256Hex(fileBody);
  const expiresAt = createdAt + RESPONSES_ITEM_PAYLOAD_TTL_MS;
  const apiKeyHashPrefix = (await sha256Hex(encoder.encode(apiKeyId ?? ''))).slice(0, 16);
  const key = `${responsesItemsExpiryBucketPrefix(expiresAt)}${apiKeyHashPrefix}/${id}/${sha256}.json`;
  await getFileProvider().put(key, fileBody);
  return JSON.stringify({
    version: 1,
    storage: 'file',
    key,
    sha256,
    byteLength: fileBody.byteLength,
  } satisfies StoredResponsesPayloadJson);
};

export const parseStoredResponsesPayload = async (
  id: string,
  raw: string | null,
): Promise<StoredResponsesItemPayload | null> => {
  if (raw === null) return null;

  const descriptor = parseDescriptor(id, raw);
  if (descriptor.storage === 'inline') return clonePayload(descriptor.payload);

  const body = await getFileProvider().get(descriptor.key);
  if (body === null) throw new Error(`Stored Responses payload file missing for id=${id}`);
  if (body.byteLength !== descriptor.byteLength) {
    throw new Error(`Stored Responses payload file size mismatch for id=${id}`);
  }
  const actualHash = await sha256Hex(body);
  if (actualHash !== descriptor.sha256) {
    throw new Error(`Stored Responses payload file hash mismatch for id=${id}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch (cause) {
    throw new Error(`Malformed stored Responses payload file JSON for id=${id}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }

  return clonePayload(assertPayloadObject(id, parsed));
};

const parseDescriptor = (id: string, raw: string): StoredResponsesPayloadJson => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Malformed responses_items.payload_json JSON for id=${id}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }

  if (!isRecord(parsed) || parsed.version !== 1) throw new Error(`Invalid responses_items.payload_json for id=${id}`);
  if (parsed.storage === 'inline') return { version: 1, storage: 'inline', payload: assertPayloadObject(id, parsed.payload) };
  if (
    parsed.storage === 'file'
    && typeof parsed.key === 'string'
    && typeof parsed.sha256 === 'string'
    && typeof parsed.byteLength === 'number'
    && Number.isSafeInteger(parsed.byteLength)
    && parsed.byteLength >= 0
  ) {
    return { version: 1, storage: 'file', key: parsed.key, sha256: parsed.sha256, byteLength: parsed.byteLength };
  }
  throw new Error(`Invalid responses_items.payload_json for id=${id}`);
};

const assertPayloadObject = (id: string, value: unknown): StoredResponsesItemPayload => {
  if (!isRecord(value) || !Object.hasOwn(value, 'item')) throw new Error(`Invalid stored Responses payload for id=${id}`);
  const payload: StoredResponsesItemPayload = { item: value.item };
  if (Object.hasOwn(value, 'private')) payload.private = value.private;
  return payload;
};

const clonePayload = (payload: StoredResponsesItemPayload): StoredResponsesItemPayload => ({
  ...payload,
  item: structuredClone(payload.item),
  ...(Object.hasOwn(payload, 'private') ? { private: structuredClone(payload.private) } : {}),
});

// Files live under their expiry hour. A bucket whose hour is strictly before
// the current hour is fully past its TTL, so the sweep enumerates the existing
// bucket prefixes under the expiry root and deletes every expired one. Bucket
// prefixes use UTC YYYY/MM/DD/HH, so lexical order matches chronological order.
// This is resilient to missed cron runs: a skipped hour is revisited on the
// next run rather than leaking into R2.
export const sweepExpiredResponsesItemPayloadFiles = async (now: number): Promise<void> => {
  const currentHourPrefix = responsesItemsExpiryBucketPrefix(startOfUtcHour(now));
  const provider = getFileProvider();
  const keys = await provider.listKeys(RESPONSES_ITEMS_FILE_ROOT);
  const expiredBuckets = new Set<string>();
  for (const key of keys) {
    const pathParts = key.slice(RESPONSES_ITEMS_FILE_ROOT.length).split('/');
    if (pathParts.length < 4) continue;
    const bucket = `${RESPONSES_ITEMS_FILE_ROOT}${pathParts.slice(0, 4).join('/')}/`;
    if (bucket < currentHourPrefix) expiredBuckets.add(bucket);
  }
  for (const bucket of expiredBuckets) await provider.deletePrefix(bucket);
};

// Drop every spilled payload file. Paired with a `deleteAll` over the
// responses_items rows so a full replace/clear does not orphan R2 objects.
export const deleteAllResponsesItemPayloadFiles = async (): Promise<void> => {
  await getFileProvider().deletePrefix(RESPONSES_ITEMS_FILE_ROOT);
};

const responsesItemsExpiryBucketPrefix = (hourTimestamp: number): string => {
  const date = new Date(hourTimestamp);
  const yyyy = String(date.getUTCFullYear()).padStart(4, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  return `${RESPONSES_ITEMS_FILE_ROOT}${yyyy}/${mm}/${dd}/${hh}/`;
};

export const startOfUtcHour = (timestamp: number): number => Math.floor(timestamp / HOUR_MS) * HOUR_MS;

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digestInput = new Uint8Array(bytes).buffer;
  const digest = await crypto.subtle.digest('SHA-256', digestInput);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
