import { FsFileProvider } from './fs-file-provider.ts';
import { createNodeSqliteDatabase } from './node-sqlite-database.ts';
import { createMemoryImageCache, createSharpImageProcessor } from './sharp-image-processor.ts';
import {
  initEnv,
  initFileProvider,
  initImageProcessor,
  type ImageCache,
  type SqlDatabase,
} from '@floway-dev/platform';

export interface NodePlatformOptions {
  dbPath: string;
  filesDir: string;
  imageCache?: ImageCache;
}

// Wires the Node-specific platform implementations. Each component
// (createNodeSqliteDatabase, FsFileProvider) ensures its own root directory
// exists, so bootstrap stays a pure wiring step. `imageCache` is optional:
// a single-process Node deployment gets an in-memory LRU by default, but a
// multi-instance deployment can pass a shared implementation (e.g. backed
// by Redis) without touching this code.
export const bootstrapNodePlatform = (opts: NodePlatformOptions): { db: SqlDatabase } => {
  initEnv(name => process.env[name] ?? '');
  initFileProvider(new FsFileProvider(opts.filesDir));
  initImageProcessor(createSharpImageProcessor({ cache: opts.imageCache ?? createMemoryImageCache() }));
  return { db: createNodeSqliteDatabase(opts.dbPath) };
};
