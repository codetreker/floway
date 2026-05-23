import { test } from 'vitest';

import { pricingForCopilotModelKey, pricingForCopilotPublicModelId } from './pricing.ts';
import { assertEquals } from '../../../test-assert.ts';

test('pricingForCopilotPublicModelId resolves Claude family by regex', () => {
  assertEquals(pricingForCopilotPublicModelId('claude-opus-4-7'), { input: 5, cache_read: 0.5, cache_write: 6.25, output: 25 });
  assertEquals(pricingForCopilotPublicModelId('claude-opus-4-5'), { input: 5, cache_read: 0.5, cache_write: 6.25, output: 25 });
  assertEquals(pricingForCopilotPublicModelId('claude-sonnet-4-5'), { input: 3, cache_read: 0.3, cache_write: 3.75, output: 15 });
  assertEquals(pricingForCopilotPublicModelId('claude-haiku-4-5'), { input: 1, cache_read: 0.1, cache_write: 1.25, output: 5 });
});

test('pricingForCopilotPublicModelId resolves gpt-5 family by exact id and regex', () => {
  assertEquals(pricingForCopilotPublicModelId('gpt-5.4'), { input: 2.5, cache_read: 0.25, output: 15 });
  assertEquals(pricingForCopilotPublicModelId('gpt-5.3-codex'), { input: 1.75, cache_read: 0.175, output: 14 });
  assertEquals(pricingForCopilotPublicModelId('gpt-5.1-codex-mini'), { input: 0.25, cache_read: 0.025, output: 2 });
});

test('pricingForCopilotPublicModelId resolves embeddings with output 0', () => {
  assertEquals(pricingForCopilotPublicModelId('text-embedding-3-small'), { input: 0.02, output: 0 });
  assertEquals(pricingForCopilotPublicModelId('text-embedding-ada-002'), { input: 0.1, output: 0 });
});

test('pricingForCopilotPublicModelId returns null for unknown ids', () => {
  assertEquals(pricingForCopilotPublicModelId('totally-made-up-model'), null);
});

test('pricingForCopilotModelKey strips Claude variant suffix before lookup', () => {
  const opus = { input: 5, cache_read: 0.5, cache_write: 6.25, output: 25 };
  assertEquals(pricingForCopilotModelKey('claude-opus-4-7-high'), opus);
  assertEquals(pricingForCopilotModelKey('claude-opus-4-7-xhigh'), opus);
  assertEquals(pricingForCopilotModelKey('claude-opus-4-7-1m'), opus);
  assertEquals(pricingForCopilotModelKey('claude-opus-4-7-1m-internal'), opus);
});

test('pricingForCopilotModelKey strips trailing date suffix on Claude variants', () => {
  const opus = { input: 5, cache_read: 0.5, cache_write: 6.25, output: 25 };
  assertEquals(pricingForCopilotModelKey('claude-opus-4-7-20251101'), opus);
  assertEquals(pricingForCopilotModelKey('claude-opus-4-7-xhigh-20251101'), opus);
});

test('pricingForCopilotModelKey passes non-Claude ids through unchanged', () => {
  assertEquals(pricingForCopilotModelKey('gpt-5.4'), { input: 2.5, cache_read: 0.25, output: 15 });
  assertEquals(pricingForCopilotModelKey('gpt-4o'), { input: 2.5, cache_read: 1.25, output: 10 });
});
