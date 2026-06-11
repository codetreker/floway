// The repo stores one row per (provider, keyId, action, hour). The two
// aggregators below collapse the action dimension, summing search and
// fetch_page into a single `requests` count per (provider, keyId, hour) or
// (provider, userId, hour).

import type { SearchUsageRecord } from '../../repo/types.ts';
import type { WebSearchProviderName } from '../../shared/web-search-providers.ts';

export interface DisplaySearchUsageByKeyRecord {
  provider: WebSearchProviderName;
  keyId: string;
  hour: string;
  requests: number;
}

export interface DisplaySearchUsageByUserRecord {
  provider: WebSearchProviderName;
  userId: number;
  hour: string;
  requests: number;
}

export const aggregateSearchUsageByKey = (records: readonly SearchUsageRecord[]): DisplaySearchUsageByKeyRecord[] => {
  const grouped = new Map<string, DisplaySearchUsageByKeyRecord>();
  for (const r of records) {
    const key = JSON.stringify([r.provider, r.keyId, r.hour]);
    const existing = grouped.get(key);
    if (existing) {
      existing.requests += r.requests;
    } else {
      grouped.set(key, { provider: r.provider, keyId: r.keyId, hour: r.hour, requests: r.requests });
    }
  }
  return [...grouped.values()].sort((a, b) => a.hour.localeCompare(b.hour) || a.keyId.localeCompare(b.keyId) || a.provider.localeCompare(b.provider));
};

// Records whose keyId no longer resolves to a user (a key the operator hard-
// deleted directly in the DB) collapse into a synthetic userId 0 so the
// dashboard can still surface the lost rows; the keyToUser map is populated
// from active + soft-deleted api_keys, so a normal soft delete still resolves.
export const aggregateSearchUsageByUser = (
  records: readonly SearchUsageRecord[],
  keyToUser: ReadonlyMap<string, number>,
): DisplaySearchUsageByUserRecord[] => {
  const grouped = new Map<string, DisplaySearchUsageByUserRecord>();
  for (const r of records) {
    const userId = keyToUser.get(r.keyId) ?? 0;
    const key = JSON.stringify([r.provider, userId, r.hour]);
    const existing = grouped.get(key);
    if (existing) {
      existing.requests += r.requests;
    } else {
      grouped.set(key, { provider: r.provider, userId, hour: r.hour, requests: r.requests });
    }
  }
  return [...grouped.values()].sort((a, b) => a.hour.localeCompare(b.hour) || a.userId - b.userId || a.provider.localeCompare(b.provider));
};
