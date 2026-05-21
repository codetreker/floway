import { test } from 'vitest';

import { planGeminiRequest } from './plan.ts';
import { assertEquals } from '../../../../test-assert.ts';
import type { ModelCapabilities } from '../../../providers/capabilities.ts';

const capabilities = (overrides: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
  supportedEndpoints: [],
  supportsMessages: false,
  supportsResponses: false,
  supportsChatCompletions: false,
  supportsAdaptiveThinking: false,
  ...overrides,
});

test('planGeminiRequest rejects capability misses instead of legacy fallback', () => {
  const plan = planGeminiRequest(capabilities());

  assertEquals(plan, null);
});

test('planGeminiRequest follows Chat Completions native preference', () => {
  const plan = planGeminiRequest(
    capabilities({
      supportedEndpoints: ['messages', 'chat_completions'],
      supportsMessages: true,
      supportsChatCompletions: true,
    }),
  );

  assertEquals(plan?.target, 'chat-completions');
});

test('planGeminiRequest does not invent legacy fallback without provider endpoints', () => {
  const plan = planGeminiRequest(capabilities());

  assertEquals(plan, null);
});
