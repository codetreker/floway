import type { ImageCache, ImageDimensions, ImageProcessor } from '@floway-dev/platform';
import { sha256Hex } from '@floway-dev/platform';

// Fixed WebP quality for every recompressed inline image. 82 sits above the
// cwebp / photographic default of 75 so screenshots and text-heavy UI images —
// the bulk of Copilot traffic — survive our lossy pass before the upstream
// provider applies its own downscale and re-encode, while keeping the bandwidth
// win. Confirmed on real traffic: the production Cloudflare Images encoder at
// q82 matches local cwebp within <0.1 dB PSNR. References:
// - https://developers.google.com/speed/webp/docs/cwebp (default quality 75)
// - https://platform.claude.com/docs/en/build-with-claude/vision (multi-pass
//   compression warning)
// - https://getwebp.com/blog/screenshots-webp-settings-text-ui
const WEBP_QUALITY = 82;

const CACHE_KEY_PREFIX = 'imgwebp';

// Compressed results are content-addressed (keyed by source hash + transform),
// so they never go stale; the TTL exists only to bound storage. The cache pays
// off across a single conversation's lifetime — the same inline image resent
// each turn — so 30 days comfortably covers long sessions while letting
// one-off images age out.
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

// Minimal shapes of the Cloudflare bindings we depend on, hand-typed so the
// runtime contract does not pull in the full @cloudflare/workers-types
// surface. We use only the transform/output path of the Images binding;
// `info()` is intentionally not modelled because it is billed per call — we
// read dimensions locally via image-size in the platform helper instead.
// Reference: https://developers.cloudflare.com/images/transform-images/bindings/
export interface ImagesBinding {
  input(stream: ReadableStream): ImageTransformer;
}

interface ImageTransformer {
  transform(options: ImageTransformOptions): ImageTransformer;
  output(options: ImageOutputOptions): Promise<ImageTransformationResult>;
}

interface ImageTransformOptions {
  width?: number;
  height?: number;
  fit?: 'scale-down' | 'contain' | 'cover' | 'crop' | 'pad';
}

interface ImageOutputOptions {
  format: string;
  quality?: number;
}

interface ImageTransformationResult {
  image(): ReadableStream;
}

// Raw Cloudflare KV binding shape (its `put` takes an options object). We
// adapt it to the platform's `ImageCache` contract via `cloudflareKvImageCache`
// below.
export interface KvNamespace {
  get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>;
  put(key: string, value: ArrayBuffer | ArrayBufferView, options?: { expirationTtl?: number }): Promise<void>;
}

export const cloudflareKvImageCache = (kv: KvNamespace): ImageCache => ({
  get: async key => {
    const buf = await kv.get(key, 'arrayBuffer');
    return buf ? new Uint8Array(buf) : null;
  },
  put: (key, value, ttlSeconds) => kv.put(key, value, { expirationTtl: ttlSeconds }),
});

const streamFrom = (bytes: Uint8Array): ReadableStream =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

class CloudflareImageProcessor implements ImageProcessor {
  constructor(
    private readonly images: ImagesBinding,
    private readonly cache: ImageCache,
  ) {}

  async compressToWebp(input: Uint8Array, target: ImageDimensions | null): Promise<Uint8Array> {
    // Key on the original bytes plus the exact transform we will request, so
    // every distinct (source, target size, encoder params) combination is a
    // separate entry and a changed quality or per-model size never serves a
    // stale result.
    const targetKey = target ? `${target.width}x${target.height}` : 'orig';
    const key = `${CACHE_KEY_PREFIX}:${await sha256Hex(input)}:${targetKey}:webp:q${WEBP_QUALITY}`;

    const cached = await this.cache.get(key);
    if (cached) return cached;

    let transformer = this.images.input(streamFrom(input));
    if (target) transformer = transformer.transform({ width: target.width, height: target.height, fit: 'scale-down' });
    const result = await transformer.output({ format: 'image/webp', quality: WEBP_QUALITY });
    const output = new Uint8Array(await new Response(result.image()).arrayBuffer());

    await this.cache.put(key, output, CACHE_TTL_SECONDS);
    return output;
  }
}

export const createCloudflareImageProcessor = (images: ImagesBinding, cache: ImageCache): ImageProcessor => new CloudflareImageProcessor(images, cache);
