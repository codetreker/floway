import type { ImageDimensions, ImageProcessor } from '@floway-dev/platform';
import { getImageCacheStore, sha256Hex } from '@floway-dev/platform';

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

export const createCloudflareImageProcessor = (images: ImagesBinding): ImageProcessor => ({
  async compressToWebp(input: Uint8Array, target: ImageDimensions | null): Promise<Uint8Array> {
    // Key on the original bytes plus the exact transform we will request, so
    // every distinct (source, target size, encoder params) combination is a
    // separate entry and a changed quality or per-model size never serves a
    // stale result.
    const targetKey = target ? `${target.width}x${target.height}` : 'orig';
    const key = `imgwebp:${await sha256Hex(input)}:${targetKey}:webp:q${WEBP_QUALITY}`;

    const store = getImageCacheStore();
    const cached = await store.get(key);
    if (cached) return cached;

    const sourceStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(input);
        controller.close();
      },
    });
    let transformer = images.input(sourceStream);
    if (target) transformer = transformer.transform({ width: target.width, height: target.height, fit: 'scale-down' });
    const result = await transformer.output({ format: 'image/webp', quality: WEBP_QUALITY });
    const output = new Uint8Array(await new Response(result.image()).arrayBuffer());

    await store.put(key, output);
    return output;
  },
});
