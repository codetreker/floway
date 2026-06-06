import type { UsageRecord } from '../../repo/types.ts';
import { type BillingDimension, unitPriceForDimension } from '@floway-dev/protocols/common';

const BILLING_DIMENSIONS: readonly BillingDimension[] = ['input', 'input_cache_read', 'input_cache_write', 'input_image', 'output', 'output_image'];

export interface DisplayUsageRecord {
  keyId: string;
  model: string;
  hour: string;
  requests: number;
  // Disjoint per-dimension token counts. Absent dimensions are zero.
  tokens: Partial<Record<BillingDimension, number>>;
  cost: number;
}

// Cost is pure addition over the dimension rows: Σ tokens × unit_price / 1e6.
// No subtraction is needed because the counts are disjoint and each dimension
// already carries its own resolved unit price snapshot.
const recordCostUsd = (record: UsageRecord): number => {
  let total = 0;
  for (const dimension of BILLING_DIMENSIONS) {
    const tokens = record.tokens[dimension] ?? 0;
    if (tokens === 0) continue;
    const unitPrice = unitPriceForDimension(record.cost, dimension);
    if (unitPrice !== null) total += tokens * unitPrice;
  }
  return total / 1e6;
};

export function aggregateUsageForDisplay(records: readonly UsageRecord[]): DisplayUsageRecord[] {
  const byKey = new Map<string, DisplayUsageRecord>();

  for (const record of records) {
    const key = `${record.keyId}\0${record.model}\0${record.hour}`;
    let existing = byKey.get(key);
    if (!existing) {
      existing = { keyId: record.keyId, model: record.model, hour: record.hour, requests: 0, tokens: {}, cost: 0 };
      byKey.set(key, existing);
    }
    existing.requests += record.requests;
    existing.cost += recordCostUsd(record);
    for (const dimension of BILLING_DIMENSIONS) {
      const tokens = record.tokens[dimension] ?? 0;
      if (tokens > 0) existing.tokens[dimension] = (existing.tokens[dimension] ?? 0) + tokens;
    }
  }

  return [...byKey.values()].sort((a, b) => a.hour.localeCompare(b.hour) || a.keyId.localeCompare(b.keyId) || a.model.localeCompare(b.model));
}
