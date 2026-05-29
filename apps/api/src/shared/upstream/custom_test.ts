import { test } from 'vitest';

import { assertCustomUpstreamRecord, createCustomUpstream } from './custom.ts';
import type { UpstreamRecord } from '../../repo/types.ts';
import { assertEquals, assertThrows } from '../../test-assert.ts';
import { withMockedFetch } from '../../test-helpers.ts';

const baseRecord: UpstreamRecord = {
  id: 'up_test',
  provider: 'custom',
  name: 'Test Custom',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-04-29T00:00:00.000Z',
  updatedAt: '2026-04-29T00:00:00.000Z',
  config: {
    baseUrl: 'https://custom.example.com',
    bearerToken: 'sk-test',
    supportedEndpoints: ['/chat/completions'],
  },
  flagOverrides: {},
};

test('createCustomUpstream uses default /v1/* paths', async () => {
  const upstream = createCustomUpstream(baseRecord);
  assertEquals(upstream.kind, 'custom');

  const seen: string[] = [];
  await withMockedFetch(
    request => {
      seen.push(request.url);
      return new Response('{}', { status: 200 });
    },
    async () => {
      await upstream.fetch('chat_completions', { method: 'POST', body: '{}' });
      await upstream.fetch('responses', { method: 'POST', body: '{}' });
      await upstream.fetch('messages', { method: 'POST', body: '{}' });
      await upstream.fetch('messages_count_tokens', {
        method: 'POST',
        body: '{}',
      });
      await upstream.fetch('embeddings', { method: 'POST', body: '{}' });
      await upstream.fetch('models', { method: 'GET' });
    },
  );

  assertEquals(seen, [
    'https://custom.example.com/v1/chat/completions',
    'https://custom.example.com/v1/responses',
    'https://custom.example.com/v1/messages',
    'https://custom.example.com/v1/messages/count_tokens',
    'https://custom.example.com/v1/embeddings',
    'https://custom.example.com/v1/models',
  ]);
});

test('createCustomUpstream applies path overrides without an automatic /v1 prefix', async () => {
  const upstream = createCustomUpstream({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      pathOverrides: {
        messages: '/api/v1/messages',
      },
    },
  });
  const seen: string[] = [];
  await withMockedFetch(
    request => {
      seen.push(request.url);
      return new Response('{}', { status: 200 });
    },
    async () => {
      await upstream.fetch('messages', { method: 'POST', body: '{}' });
      await upstream.fetch('messages_count_tokens', {
        method: 'POST',
        body: '{}',
      });
      await upstream.fetch('chat_completions', { method: 'POST', body: '{}' });
    },
  );

  assertEquals(seen, [
    'https://custom.example.com/api/v1/messages',
    // count_tokens follows the messages override path.
    'https://custom.example.com/api/v1/messages/count_tokens',
    // Endpoints without an override fall back to the OpenAI default.
    'https://custom.example.com/v1/chat/completions',
  ]);
});

test('createCustomUpstream resolves the /models path from modelsFetch.endpoint', async () => {
  const upstream = createCustomUpstream({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      modelsFetch: { enabled: true, endpoint: '/models' },
    },
  });
  let seen: string | undefined;
  await withMockedFetch(
    request => {
      seen = request.url;
      return new Response('{}', { status: 200 });
    },
    async () => {
      await upstream.fetch('models', { method: 'GET' });
    },
  );

  assertEquals(seen, 'https://custom.example.com/models');
});

test('createCustomUpstream falls back to the default /models path when modelsFetch.endpoint is absent', async () => {
  const upstream = createCustomUpstream({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      modelsFetch: { enabled: true },
    },
  });
  let seen: string | undefined;
  await withMockedFetch(
    request => {
      seen = request.url;
      return new Response('{}', { status: 200 });
    },
    async () => {
      await upstream.fetch('models', { method: 'GET' });
    },
  );

  assertEquals(seen, 'https://custom.example.com/v1/models');
});

test('assertCustomUpstreamRecord parses modelsFetch and models', () => {
  const { config } = assertCustomUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      modelsFetch: { enabled: false },
      models: [
        { upstreamModelId: 'pinned', supportedEndpoints: ['/chat/completions'], display_name: 'Pinned' },
      ],
    },
  });

  assertEquals(config.modelsFetch, { enabled: false });
  assertEquals(config.models.length, 1);
  assertEquals(config.models[0].upstreamModelId, 'pinned');
  assertEquals(config.models[0].display_name, 'Pinned');
});

test('assertCustomUpstreamRecord defaults modelsFetch to enabled when absent', () => {
  const { config } = assertCustomUpstreamRecord(baseRecord);
  assertEquals(config.modelsFetch, { enabled: true });
  assertEquals(config.models, []);
});

test('assertCustomUpstreamRecord treats a null modelsFetch.endpoint as no override', () => {
  const { config } = assertCustomUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      modelsFetch: { enabled: true, endpoint: null },
    },
  });
  assertEquals(config.modelsFetch, { enabled: true });
});

test('createCustomUpstream sends the configured bearer token', async () => {
  const upstream = createCustomUpstream(baseRecord);
  let authHeader: string | null = null;
  await withMockedFetch(
    request => {
      authHeader = request.headers.get('authorization');
      return new Response('{}', { status: 200 });
    },
    async () => {
      await upstream.fetch('models', { method: 'GET' });
    },
  );

  assertEquals(authHeader, 'Bearer sk-test');
});

test('createCustomUpstream defaults authStyle to bearer when omitted', async () => {
  const upstream = createCustomUpstream(baseRecord);
  let authHeader: string | null = null;
  let xApiKey: string | null = null;
  await withMockedFetch(
    request => {
      authHeader = request.headers.get('authorization');
      xApiKey = request.headers.get('x-api-key');
      return new Response('{}', { status: 200 });
    },
    async () => {
      await upstream.fetch('models', { method: 'GET' });
    },
  );

  assertEquals(authHeader, 'Bearer sk-test');
  assertEquals(xApiKey, null);
});

test('createCustomUpstream with authStyle "anthropic" sends x-api-key + anthropic-version', async () => {
  const upstream = createCustomUpstream({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      authStyle: 'anthropic',
    },
  });
  let authHeader: string | null = null;
  let xApiKey: string | null = null;
  let anthropicVersion: string | null = null;
  await withMockedFetch(
    request => {
      authHeader = request.headers.get('authorization');
      xApiKey = request.headers.get('x-api-key');
      anthropicVersion = request.headers.get('anthropic-version');
      return new Response('{}', { status: 200 });
    },
    async () => {
      await upstream.fetch('messages', { method: 'POST', body: '{}' });
    },
  );

  assertEquals(authHeader, null);
  assertEquals(xApiKey, 'sk-test');
  assertEquals(anthropicVersion, '2023-06-01');
});

test('createCustomUpstream with authStyle "anthropic" preserves a caller-supplied anthropic-version', async () => {
  const upstream = createCustomUpstream({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      authStyle: 'anthropic',
    },
  });
  let anthropicVersion: string | null = null;
  await withMockedFetch(
    request => {
      anthropicVersion = request.headers.get('anthropic-version');
      return new Response('{}', { status: 200 });
    },
    async () => {
      await upstream.fetch(
        'messages',
        { method: 'POST', body: '{}', headers: { 'anthropic-version': '2024-01-01' } },
      );
    },
  );

  assertEquals(anthropicVersion, '2024-01-01');
});

test('createCustomUpstream rejects malformed opaque config instead of dropping endpoints', () => {
  assertThrows(
    () =>
      createCustomUpstream({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          supportedEndpoints: ['chat_completions'],
        },
      }),
    Error,
    'unsupported supportedEndpoints entry chat_completions',
  );

  assertThrows(
    () =>
      createCustomUpstream({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          pathOverrides: { models: '/models' },
        },
      }),
    Error,
    'unsupported pathOverrides key models',
  );

  assertThrows(
    () =>
      createCustomUpstream({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          baseUrl: 'ftp://custom.example.com',
        },
      }),
    Error,
    'baseUrl must be an http(s) URL',
  );

  assertThrows(
    () =>
      createCustomUpstream({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          authStyle: 'apiKey',
        },
      }),
    Error,
    'authStyle must be "bearer" or "anthropic"',
  );
});
