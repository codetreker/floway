import { readFileSync } from 'node:fs';

import { parse } from 'jsonc-parser';
import { test } from 'vitest';

import { assertEquals } from '@floway-dev/test-utils';

const workerFirstRoutes = [
  '/api/*',
  '/auth',
  '/auth/*',
  '/v1/*',
  '/v1beta/*',
  '/chat/*',
  '/responses',
  '/messages',
  '/messages/*',
  '/embeddings',
  '/images/*',
  '/models',
  '/azure-api.codex/*',
  '/favicon.ico',
];

const readWranglerExample = (): {
  assets: {
    directory: string;
    html_handling: string;
    not_found_handling: string;
    run_worker_first: string[];
  };
} => parse(readFileSync(new URL('../../../wrangler.example.jsonc', import.meta.url), 'utf8'));

test('wrangler static assets config serves Vue SPA routes outside the Worker', () => {
  const { assets } = readWranglerExample();

  assertEquals(assets.directory, 'apps/web/dist');
  assertEquals(assets.html_handling, 'auto-trailing-slash');
  assertEquals(assets.not_found_handling, 'single-page-application');
  assertEquals(assets.run_worker_first, workerFirstRoutes);
  assertEquals(assets.run_worker_first.includes('/login'), false);
  assertEquals(assets.run_worker_first.includes('/dashboard'), false);
});
