import type { ExecutionContext } from 'hono';

import { app } from './src/app.ts';
import { createCloudflareImageProcessor, type ImagesBinding } from './src/image/cloudflare.ts';
import { initImageProcessor } from './src/image/index.ts';
import { type D1Database, D1Repo } from './src/repo/d1.ts';
import { getRepo, initRepo } from './src/repo/index.ts';
import { RESPONSES_ITEM_PAYLOAD_TTL_MS, startOfUtcHour, sweepExpiredResponsesItemPayloadFiles } from './src/repo/responses-payload.ts';
import { initEnv } from './src/runtime/env.ts';
import { initFileProvider } from './src/runtime/file-provider.ts';
import { R2FileProvider, type R2BucketLike } from './src/runtime/r2-file-provider.ts';

// Read only by the scheduled cleanup below (deleteOlderThan). Lookups never
// filter by it — a row stays referenceable until cleanup removes it.
const RESPONSES_ITEM_ROW_TTL_MS = 180 * 24 * 60 * 60 * 1000;

// Raw Cloudflare KV binding shape (its `put` takes an options object). We adapt
// it to the image cache's contract, which requires an explicit positional TTL.
interface KvNamespace {
  get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>;
  put(key: string, value: ArrayBuffer | ArrayBufferView, options?: { expirationTtl?: number }): Promise<void>;
}

interface Env {
  DB: D1Database;
  FILES: R2BucketLike;
  IMAGES: ImagesBinding;
  KV: KvNamespace;
  [key: string]: unknown;
}

// Every binding declared on `Env` is load-bearing — D1 holds all config and
// telemetry, R2 holds spilled payloads, Images compresses inline images, KV
// memoises compressed results. A missing binding means wrangler.jsonc drifted
// from the code, so we refuse to initialise rather than 503 on first use of
// the absent binding.
const REQUIRED_BINDINGS = ['DB', 'FILES', 'IMAGES', 'KV'] as const;

const initRuntime = (env: Env): void => {
  const missing = REQUIRED_BINDINGS.filter(name => env[name] === undefined || env[name] === null);
  if (missing.length > 0) {
    throw new Error(
      `Missing required Cloudflare bindings: ${missing.join(', ')}. `
      + 'Declare them in wrangler.jsonc; see wrangler.example.jsonc.',
    );
  }
  initEnv(n => (env[n] as string) ?? '');
  initRepo(new D1Repo(env.DB));
  initFileProvider(new R2FileProvider(env.FILES));
  initImageProcessor(
    createCloudflareImageProcessor(env.IMAGES, {
      get: (key, type) => env.KV.get(key, type),
      put: (key, value, expirationTtl) => env.KV.put(key, value, { expirationTtl }),
    }),
  );
};

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    initRuntime(env);
    return app.fetch(req, env, ctx);
  },
  scheduled(_controller: unknown, env: Env, ctx: ExecutionContext) {
    initRuntime(env);
    const now = startOfUtcHour(Date.now());
    ctx.waitUntil((async () => {
      await getRepo().responsesItems.clearPayloadOlderThan(now - RESPONSES_ITEM_PAYLOAD_TTL_MS);
      await sweepExpiredResponsesItemPayloadFiles(now);
      await getRepo().responsesSnapshots.deleteOlderThan(now - RESPONSES_ITEM_ROW_TTL_MS);
      await getRepo().responsesItems.deleteOlderThan(now - RESPONSES_ITEM_ROW_TTL_MS);
    })());
  },
};
