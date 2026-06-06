import { test } from 'vitest';

import { runtimeLocationFromRequest } from './performance.ts';
import { initEnv } from '@floway-dev/platform';
import { assertEquals } from '@floway-dev/test-utils';

test('runtimeLocationFromRequest prefers Cloudflare colo', () => {
  initEnv(() => 'fallback-location');
  const request = new Request('https://example.test');
  Object.defineProperty(request, 'cf', { value: { colo: 'SJC' } });

  assertEquals(runtimeLocationFromRequest(request), 'SJC');
});

test('runtimeLocationFromRequest uses env fallback outside Cloudflare', () => {
  initEnv(name => (name === 'RUNTIME_LOCATION' ? 'worker-local' : ''));

  assertEquals(runtimeLocationFromRequest(new Request('https://example.test')), 'worker-local');
});

test('runtimeLocationFromRequest uses unknown without colo or env', () => {
  initEnv(() => '');

  assertEquals(runtimeLocationFromRequest(new Request('https://example.test')), 'unknown');
});
