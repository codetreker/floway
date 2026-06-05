import sharp from 'sharp';

import { sha256Hex } from '@floway-dev/platform';
import type { ImageCache, ImageDimensions, ImageProcessor } from '@floway-dev/platform';

// Fixed WebP quality matching the Cloudflare encoder so both deployment
// targets pass the same lossy budget through to the upstream model. See
// platform-cloudflare/src/image-processor.ts for the calibration notes.
const WEBP_QUALITY = 82;

const CACHE_KEY_PREFIX = 'imgwebp';
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

export const createSharpImageProcessor = (opts: { cache?: ImageCache } = {}): ImageProcessor => {
  const cache = opts.cache ?? null;
  return {
    async compressToWebp(input: Uint8Array, target: ImageDimensions | null): Promise<Uint8Array> {
      const cacheKey = cache
        ? `${CACHE_KEY_PREFIX}:${await sha256Hex(input)}:${target ? `${target.width}x${target.height}` : 'orig'}:webp:q${WEBP_QUALITY}`
        : null;
      if (cache && cacheKey) {
        const hit = await cache.get(cacheKey);
        if (hit) return hit;
      }

      let pipeline = sharp(input);
      // `fit: 'inside'` already implies never-enlarge; the `withoutEnlargement`
      // flag is redundant but the sharp docs recommend stating it explicitly
      // so the intent is unambiguous when reading the call site.
      if (target) pipeline = pipeline.resize({ width: target.width, height: target.height, fit: 'inside', withoutEnlargement: true });
      const output = new Uint8Array(await pipeline.webp({ quality: WEBP_QUALITY }).toBuffer());

      if (cache && cacheKey) await cache.put(cacheKey, output, CACHE_TTL_SECONDS);
      return output;
    },
  };
};

// Bounded in-memory ImageCache with LRU-on-touch eviction: a hit reorders the
// entry to the most-recent position by re-inserting, and put on an existing
// key likewise refreshes its position. Suitable for single-process Node
// deployments where the workload is "the same image resent across consecutive
// turns of one conversation" — exactly the LRU access pattern. A multi-
// instance deployment can pass its own ImageCache implementation to bootstrap.
export const createMemoryImageCache = (maxEntries = 64): ImageCache => {
  const store = new Map<string, Uint8Array>();
  return {
    get(key) {
      const value = store.get(key);
      if (value === undefined) return Promise.resolve(null);
      // Re-insert to bump to the tail (Map preserves insertion order; .delete
      // + .set is the canonical Map-LRU touch).
      store.delete(key);
      store.set(key, value);
      return Promise.resolve(value);
    },
    put(key, value) {
      // Refresh position on overwrite. .delete + .set on the existing key
      // moves it to the tail; a fresh key falls through to the size check
      // and may evict the least-recently-used entry first.
      if (store.has(key)) {
        store.delete(key);
      } else if (store.size >= maxEntries) {
        store.delete(store.keys().next().value as string);
      }
      store.set(key, value);
      return Promise.resolve();
    },
  };
};
