import { test } from 'vitest';

import { getModelPricing, recordCostUsd } from './pricing.ts';
import { assertAlmostEquals, assertEquals } from '../../test-assert.ts';

test('getModelPricing matches public Claude id', () => {
  assertEquals(getModelPricing('claude-opus-4-7'), {
    input: 5,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    output: 25,
  });
});

test('getModelPricing covers gpt-5 family by exact id and regex', () => {
  assertEquals(getModelPricing('gpt-5.5'), {
    input: 5,
    cacheRead: 0.5,
    output: 30,
  });
  assertEquals(getModelPricing('gpt-5.3-codex'), {
    input: 1.75,
    cacheRead: 0.175,
    output: 14,
  });
});

test('getModelPricing returns null for unknown ids', () => {
  assertEquals(getModelPricing('totally-made-up-model'), null);
});

test('recordCostUsd splits prefill/cache-read/cache-write/output', () => {
  // claude-opus-4-7: input 5, cacheRead 0.5, cacheWrite 6.25, output 25 per 1M tokens.
  // 100k input where 60k is cache-read, 10k is cache-write, leaves 30k prefill.
  // 50k output. Cost in USD:
  //   prefill:    30000 * 5     = 150000
  //   cacheRead:  60000 * 0.5   =  30000
  //   cacheWrite: 10000 * 6.25  =  62500
  //   output:     50000 * 25    = 1250000
  // total = 1492500 / 1e6 = 1.4925
  const cost = recordCostUsd('claude-opus-4-7', 100_000, 50_000, 60_000, 10_000);
  assertAlmostEquals(cost, 1.4925, 1e-9);
});

test('recordCostUsd returns 0 for unknown models', () => {
  assertEquals(recordCostUsd('totally-made-up', 100, 100, 0, 0), 0);
});
