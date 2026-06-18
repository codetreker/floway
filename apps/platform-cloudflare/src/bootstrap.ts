import { createCloudflareImageProcessor, type ImagesBinding } from './image-processor.ts';
import { KvImageCache, type KvNamespace } from './kv-image-cache.ts';
import { R2FileProvider, type R2BucketLike } from './r2-file-provider.ts';
import { cloudflareSocketDial } from './socket-dial.ts';
import { cloudflareRuntimeRootCAs } from './tls-trust.ts';
import { addTrustedRootCAs } from '@floway-dev/http';
import {
  IMAGE_CACHE_POLICY,
  initEnv,
  initFileProvider,
  initImageCacheStore,
  initImageProcessor,
  initRuntimeKind,
  initSocketDial,
  type SqlDatabase,
} from '@floway-dev/platform';

export interface CloudflareEnv {
  DB: SqlDatabase;
  FILES: R2BucketLike;
  IMAGES: ImagesBinding;
  KV: KvNamespace;
  [key: string]: unknown;
}

// Every binding declared on `CloudflareEnv` is load-bearing — D1 holds all
// config and telemetry, R2 holds spilled payloads, Images compresses inline
// images, KV memoises compressed image results. A missing binding means
// wrangler.jsonc drifted from the code, so we refuse to initialise rather
// than 503 on first use of the absent binding.
const REQUIRED_BINDINGS = ['DB', 'FILES', 'IMAGES', 'KV'] as const;

export const bootstrapCloudflarePlatform = (env: CloudflareEnv): { db: SqlDatabase } => {
  const missing = REQUIRED_BINDINGS.filter(name => env[name] === undefined || env[name] === null);
  if (missing.length > 0) {
    throw new Error(
      `Missing required Cloudflare bindings: ${missing.join(', ')}. `
      + 'Declare them in wrangler.jsonc; see wrangler.example.jsonc.',
    );
  }

  initEnv(name => {
    const value = env[name];
    if (value === undefined || value === null) {
      throw new Error(`Missing required env var: ${name}`);
    }
    return String(value);
  });
  initRuntimeKind('cloudflare');
  initFileProvider(new R2FileProvider(env.FILES));
  initImageCacheStore(new KvImageCache(env.KV, IMAGE_CACHE_POLICY));
  initImageProcessor(createCloudflareImageProcessor(env.IMAGES));
  initSocketDial(cloudflareSocketDial);
  addTrustedRootCAs(cloudflareRuntimeRootCAs);
  return { db: env.DB };
};
