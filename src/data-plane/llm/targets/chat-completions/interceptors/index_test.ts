import { test } from 'vitest';
// Order assertion for the Chat Completions target assembler.

import { withUsageStreamOptionsIncluded } from './include-usage-stream-options.ts';
import { interceptorsForChatCompletions } from './index.ts';
import { withDeepseekReasoningDialect } from './normalize-reasoning-dialect.ts';
import { withUsageNormalized } from './normalize-usage.ts';
import { assertEquals } from '../../../../../test-assert.ts';

test('interceptorsForChatCompletions without provider interceptors: base only', () => {
  const provider = {
    enabledFixes: new Set<string>(),
  };
  assertEquals(interceptorsForChatCompletions(provider), [withUsageStreamOptionsIncluded, withUsageNormalized]);
});

test('interceptorsForChatCompletions with deepseek dialect enabled', () => {
  const provider = {
    enabledFixes: new Set(['deepseek-reasoning-dialect']),
  };
  assertEquals(interceptorsForChatCompletions(provider), [withUsageStreamOptionsIncluded, withUsageNormalized, withDeepseekReasoningDialect]);
});

test('interceptorsForChatCompletions without enabledFixes: base only', () => {
  const provider = {
    enabledFixes: new Set<string>(),
  };
  assertEquals(interceptorsForChatCompletions(provider), [withUsageStreamOptionsIncluded, withUsageNormalized]);
});
