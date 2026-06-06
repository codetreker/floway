import { compressBytesToWebp, type ImageSizeCalculator } from '@floway-dev/platform';

const BASE64_CHUNK = 0x8000;

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
  }
  return btoa(binary);
};

const BASE64_DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

export const compressBase64ImageToWebp = async (
  base64: string,
  calculator: ImageSizeCalculator,
): Promise<string> => {
  const webp = await compressBytesToWebp(base64ToBytes(base64), calculator);
  return bytesToBase64(webp);
};

// Recompresses a `data:image/*;base64,...` URL to a WebP data URL. Returns the
// original URL unchanged when it is not a base64 image data URL (e.g. a remote
// https image reference, which the egress forwards as-is).
export const compressImageDataUrlToWebp = async (
  url: string,
  calculator: ImageSizeCalculator,
): Promise<string> => {
  const match = BASE64_DATA_URL.exec(url);
  if (!match?.[1].startsWith('image/')) return url;
  const webp = await compressBase64ImageToWebp(match[2], calculator);
  return `data:image/webp;base64,${webp}`;
};

export const isBase64ImageDataUrl = (url: string): boolean =>
  BASE64_DATA_URL.exec(url)?.[1].startsWith('image/') ?? false;
