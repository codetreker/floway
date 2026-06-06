import { imageSize } from 'image-size';

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface SizeCaps {
  maxLongEdge?: number;
  maxShortEdge?: number;
  maxArea?: number;
}

// Maps a source image's pixel dimensions to the dimensions the compressor
// should fit the output within. Returned dimensions are an upper bound — the
// compressor scales down to fit but never enlarges past the source. This is
// the one intentional knob the egress passes in: per-model tile budgets plug
// in here (see `fitWithin`) without the processor learning any model specifics.
export type ImageSizeCalculator = (source: ImageDimensions) => ImageDimensions;

// Global image-recompression service: one abstract surface with a
// per-platform implementation chosen at the entry point (Cloudflare Images
// binding in production, in-memory passthrough in tests). Callers reach it
// through getImageProcessor() and pass an already-resolved target box; the
// "read source dimensions" step lives in compressBytesToWebp below.
export interface ImageProcessor {
  // Re-encodes arbitrary raster image bytes to WebP at a fixed internal
  // quality, scaled to fit `target` (or untransformed when target is null —
  // i.e. when the source dimensions could not be read locally).
  compressToWebp(input: Uint8Array, target: ImageDimensions | null): Promise<Uint8Array>;
}

// Optional cache surface threaded through ImageProcessor implementations.
// Keys are content-addressed by source bytes + transform; values are the
// encoded output. ttlSeconds is mandatory on `put` so no caller can write an
// entry that never expires.
export interface ImageCache {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array, ttlSeconds: number): Promise<void>;
}

// Reads the source image's pixel dimensions from its bytes via image-size's
// header parser. Returns null when the bytes cannot be decoded so the caller
// can fall through to a no-resize path; image-size's `imageSize` throws on
// unrecognised formats and may also return undefined widths/heights for
// partial reads, both of which we fold into a single null result.
export const dimensionsFromBytes = (bytes: Uint8Array): ImageDimensions | null => {
  try {
    const { width, height } = imageSize(bytes);
    if (width === undefined || height === undefined) return null;
    return { width, height };
  } catch {
    return null;
  }
};

// Scales `source` DOWN (never up) to satisfy every present cap while preserving
// aspect ratio. This mirrors the server-side downscale each provider applies to
// images, so we never ship pixels the model would discard. With no caps the
// source passes through unchanged.
export const fitWithin = ({ width, height }: ImageDimensions, caps: SizeCaps): ImageDimensions => {
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const factors = [1];
  if (caps.maxLongEdge !== undefined) factors.push(caps.maxLongEdge / longEdge);
  if (caps.maxShortEdge !== undefined) factors.push(caps.maxShortEdge / shortEdge);
  if (caps.maxArea !== undefined) factors.push(Math.sqrt(caps.maxArea / (width * height)));
  const scale = Math.min(...factors);
  if (scale >= 1) return { width, height };
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
};

let _imageProcessor: ImageProcessor | null = null;

export const initImageProcessor = (processor: ImageProcessor): void => {
  _imageProcessor = processor;
};

export const getImageProcessor = (): ImageProcessor => {
  if (!_imageProcessor) throw new Error('Image processor not initialized — call initImageProcessor() first');
  return _imageProcessor;
};

// Caller-side convenience that owns the "read source dims → run calculator →
// hand resolved target to the processor" responsibility chain. Each
// ImageProcessor impl stays a pure encoder.
export const compressBytesToWebp = async (
  bytes: Uint8Array,
  calculator: ImageSizeCalculator,
): Promise<Uint8Array> => {
  const source = dimensionsFromBytes(bytes);
  const target = source ? calculator(source) : null;
  return await getImageProcessor().compressToWebp(bytes, target);
};

// In-memory passthrough used by tests. There is no WebP codec available under
// the test runtime, so this stub returns the input bytes unchanged; it exists
// only to satisfy the ImageProcessor contract so the egress interceptors run
// end-to-end. Interceptor behaviour (which images are rewritten, what target
// is computed) is asserted against dedicated spy processors in the
// interceptor tests, not against this stub.
export const createInMemoryImageProcessor = (): ImageProcessor => ({
  compressToWebp: input => Promise.resolve(input),
});
