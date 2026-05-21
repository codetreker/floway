import { test } from 'vitest';

import { getModelCapabilities } from './capabilities.ts';
import type { UpstreamModel } from './types.ts';
import { assertEquals } from '../../test-assert.ts';

const upstreamModel = (overrides: Partial<UpstreamModel> = {}): UpstreamModel => ({
  id: 'test-model',
  name: 'Test',
  version: '1',
  object: 'model',
  supportedEndpoints: [],
  capabilities: {
    family: 'test',
    type: 'chat',
    limits: {},
    supports: {},
  },
  ...overrides,
});

test('getModelCapabilities trusts provider-supplied endpoints', () => {
  const caps = getModelCapabilities(upstreamModel({ supportedEndpoints: ['messages', 'chat_completions'] }));

  assertEquals(caps.supportsMessages, true);
  assertEquals(caps.supportsChatCompletions, true);
  assertEquals(caps.supportsResponses, false);
  assertEquals(caps.supportedEndpoints, ['messages', 'chat_completions']);
});

test('getModelCapabilities maps every provider endpoint flag', () => {
  const caps = getModelCapabilities(
    upstreamModel({
      supportedEndpoints: ['responses', 'messages_count_tokens', 'embeddings'],
    }),
  );

  assertEquals(caps.supportsResponses, true);
  assertEquals(caps.supportsMessagesCountTokens, true);
  assertEquals(caps.supportsEmbeddings, true);
  assertEquals(caps.supportsMessages, false);
  assertEquals(caps.supportsChatCompletions, false);
});

test('getModelCapabilities does not infer endpoints from model metadata', () => {
  const caps = getModelCapabilities(
    upstreamModel({
      id: 'gpt-legacy-chat',
      supportedEndpoints: [],
      capabilities: {
        family: 'test',
        type: 'chat',
        limits: {},
        supports: {},
      },
    }),
  );

  assertEquals(caps.supportsChatCompletions, false);
  assertEquals(caps.supportsMessages, false);
  assertEquals(caps.supportsResponses, false);
});

test('getModelCapabilities exposes translation-relevant metadata', () => {
  const caps = getModelCapabilities(
    upstreamModel({
      capabilities: {
        family: 'test',
        type: 'chat',
        limits: { max_output_tokens: 64_000 },
        supports: { adaptive_thinking: true },
      },
    }),
  );

  assertEquals(caps.maxOutputTokens, 64_000);
  assertEquals(caps.supportsAdaptiveThinking, true);
});
