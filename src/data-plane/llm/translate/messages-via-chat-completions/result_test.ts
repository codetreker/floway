import { test } from 'vitest';

import { mapChatCompletionsUsageToMessagesUsage } from './result.ts';
import { assertEquals } from '../../../../test-assert.ts';

test('mapChatCompletionsUsageToMessagesUsage maps OpenAI cached_tokens to cache_read_input_tokens', () => {
  const usage = mapChatCompletionsUsageToMessagesUsage({
    prompt_tokens: 100,
    completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 60 },
  });
  assertEquals(usage.input_tokens, 40);
  assertEquals(usage.output_tokens, 20);
  assertEquals(usage.cache_read_input_tokens, 60);
});

test('mapChatCompletionsUsageToMessagesUsage omits cache_read_input_tokens when no cache field', () => {
  const usage = mapChatCompletionsUsageToMessagesUsage({
    prompt_tokens: 100,
    completion_tokens: 20,
  });
  assertEquals(usage.input_tokens, 100);
  assertEquals(usage.cache_read_input_tokens, undefined);
});
