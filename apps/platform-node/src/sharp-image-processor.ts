import sharp from 'sharp';

import { getImageCacheStore, sha256Hex } from '@floway-dev/platform';
import type { ImageDimensions, ImageProcessor } from '@floway-dev/platform';

// Fixed WebP quality matching the Cloudflare encoder so both deployment
// targets pass the same lossy budget through to the upstream model. See
// platform-cloudflare/src/image-processor.ts for the calibration notes.
const WEBP_QUALITY = 82;

export const createSharpImageProcessor = (): ImageProcessor => ({
  async compressToWebp(input: Uint8Array, target: ImageDimensions | null): Promise<Uint8Array> {
    const cacheKey = `imgwebp:${await sha256Hex(input)}:${target ? `${target.width}x${target.height}` : 'orig'}:webp:q${WEBP_QUALITY}`;
    const store = getImageCacheStore();
    const hit = await store.get(cacheKey);
    if (hit) return hit;

    let pipeline = sharp(input);
    // `fit: 'inside'` already implies never-enlarge; the `withoutEnlargement`
    // flag is redundant but the sharp docs recommend stating it explicitly
    // so the intent is unambiguous when reading the call site.
    if (target) pipeline = pipeline.resize({ width: target.width, height: target.height, fit: 'inside', withoutEnlargement: true });
    const output = new Uint8Array(await pipeline.webp({ quality: WEBP_QUALITY }).toBuffer());

    await store.put(cacheKey, output);
    return output;
  },
});
