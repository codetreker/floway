import { Hono } from 'hono';
import { test } from 'vitest';

import { authMiddleware } from './auth.ts';
import { setupAppTest } from '../test-helpers.ts';
import { assertEquals } from '@floway-dev/test-utils';

const authTestApp = () => {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.all('*', c => c.text('ok'));
  return app;
};

test('auth middleware accepts Gemini x-goog-api-key header', async () => {
  const { apiKey } = await setupAppTest();
  const app = authTestApp();

  const response = await app.request('/v1beta/models/gemini-test:generateContent', {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey.key },
  });

  assertEquals(response.status, 200);
  assertEquals(await response.text(), 'ok');
});

test('admin playground access allows Gemini model actions only with playground header', async () => {
  const { adminKey } = await setupAppTest();
  const app = authTestApp();

  const withoutPlayground = await app.request('/v1beta/models/gemini-test:generateContent', {
    method: 'POST',
    headers: { 'x-api-key': adminKey },
  });
  assertEquals(withoutPlayground.status, 403);

  const withPlayground = await app.request('/v1beta/models/gemini-test:generateContent', {
    method: 'POST',
    headers: {
      'x-api-key': adminKey,
      'x-models-playground': '1',
    },
  });
  assertEquals(withPlayground.status, 200);
  assertEquals(await withPlayground.text(), 'ok');
});

test('admin playground access does not allow non-Gemini v1beta routes', async () => {
  const { adminKey } = await setupAppTest();
  const app = authTestApp();

  const response = await app.request('/v1beta/files', {
    method: 'POST',
    headers: {
      'x-api-key': adminKey,
      'x-models-playground': '1',
    },
  });

  assertEquals(response.status, 403);
});
