import { test } from 'vitest';

import { latencyBucketForMs, percentileFromHistogramBuckets } from './performance-histogram.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('latencyBucketForMs returns self-describing exponential buckets', () => {
  assertEquals(latencyBucketForMs(75), { lowerMs: 0, upperMs: 100 });
  assertEquals(latencyBucketForMs(101).lowerMs, 100);
  assertEquals(latencyBucketForMs(600_000).upperMs >= 600_000, true);
});

test('percentileFromHistogramBuckets merges mixed bucket shapes by upper bound', () => {
  const p95 = percentileFromHistogramBuckets(
    [
      { lowerMs: 0, upperMs: 100, count: 90 },
      { lowerMs: 100, upperMs: 150, count: 5 },
      { lowerMs: 100, upperMs: 141, count: 4 },
      { lowerMs: 150, upperMs: 220, count: 1 },
    ],
    0.95,
  );

  assertEquals(p95, 150);
});

test('percentileFromHistogramBuckets returns null for empty histograms', () => {
  assertEquals(percentileFromHistogramBuckets([], 0.95), null);
  assertEquals(percentileFromHistogramBuckets([{ lowerMs: 0, upperMs: 100, count: 0 }], 0.95), null);
});
