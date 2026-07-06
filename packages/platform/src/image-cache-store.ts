// Image-WebP cache shared by both runtime targets. The store owns its own
// expiry policy at construction so callers (image-processor) just read and
// write — neither caller has to thread TTLs through every call.
//
// Why the sliding TTL is debounced: Cloudflare KV rate-limits writes to a
// single key to 1/sec (https://developers.cloudflare.com/kv/platform/limits/),
// and a single agentic request typically batches dozens of identical inline
// images through `Promise.all`. An unconditional refresh-on-read would race
// concurrent writes to the same key on every cache hit. The store refreshes
// the entry's expiry only when the entry has aged past
// `policy.refreshIfOlderThanMs`, capping refresh writes to one per key per
// refresh window. The Node sqlite store applies the same threshold so both
// targets cache identically.
export interface ImageCacheStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array): Promise<void>;
  // Drop entries whose `expires_at <= now`. Runtimes whose underlying store
  // already evicts on TTL (e.g. Cloudflare KV via `expirationTtl`) implement
  // this as a no-op; runtimes backed by a plain table (Node sqlite) need an
  // explicit DELETE so expired rows do not accumulate.
  sweepExpired(now: number): Promise<void>;
}

export interface ImageCachePolicy {
  readonly ttlMs: number;
  readonly refreshIfOlderThanMs: number;
}

// 24h gives a busy conversation a full day to keep an inline image hot; 18h
// (= ttlMs - 6h) leaves a 6h buffer to schedule the refresh before an entry
// expires.
export const IMAGE_CACHE_POLICY: ImageCachePolicy = {
  ttlMs: 24 * 60 * 60 * 1000,
  refreshIfOlderThanMs: 18 * 60 * 60 * 1000,
};

let imageCacheStore: ImageCacheStore | null = null;

export const initImageCacheStore = (store: ImageCacheStore): void => {
  imageCacheStore = store;
};

export const getImageCacheStore = (): ImageCacheStore => {
  if (!imageCacheStore) throw new Error('ImageCacheStore not initialized - call initImageCacheStore() first');
  return imageCacheStore;
};
