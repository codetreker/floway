export interface HistogramBucket {
  lowerMs: number;
  upperMs: number;
  count: number;
}

const BASE_BUCKET_UPPER_MS = 100;
const HISTOGRAM_FACTOR = Math.SQRT2;

export function latencyBucketForMs(durationMs: number): Omit<HistogramBucket, 'count'> {
  const ms = Math.max(0, Math.ceil(durationMs));
  if (ms <= BASE_BUCKET_UPPER_MS) {
    return { lowerMs: 0, upperMs: BASE_BUCKET_UPPER_MS };
  }

  let lowerMs = BASE_BUCKET_UPPER_MS;
  let upperMs = Math.ceil(BASE_BUCKET_UPPER_MS * HISTOGRAM_FACTOR);
  while (ms > upperMs) {
    lowerMs = upperMs;
    upperMs = Math.max(lowerMs + 1, Math.ceil(upperMs * HISTOGRAM_FACTOR));
  }

  return { lowerMs, upperMs };
}

export function percentileFromHistogramBuckets(buckets: readonly HistogramBucket[], percentile: number): number | null {
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  if (total <= 0) return null;

  const rank = Math.ceil(total * percentile);
  let seen = 0;
  const ordered = [...buckets].sort((a, b) => a.upperMs - b.upperMs || a.lowerMs - b.lowerMs);

  for (const bucket of ordered) {
    seen += bucket.count;
    if (seen >= rank) return bucket.upperMs;
  }

  return ordered.at(-1)?.upperMs ?? null;
}
