// GET /api/search-usage — query per-key web search usage records.
// Visibility mirrors token usage: any authenticated user can view
// aggregate records.

import { loadSearchConfig } from '../../data-plane/tools/web-search/search-config.ts';
import { queryWebSearchUsage } from '../../data-plane/tools/web-search/usage.ts';
import { type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { SearchUsageRecord } from '../../repo/types.ts';
import { isWebSearchProviderName, type WebSearchProviderName } from '../../shared/web-search-providers.ts';
import type { searchUsageQuery } from '../schemas.ts';
import { USAGE_KEY_COLOR_ORDER } from '../usage-key-colors.ts';

const parseProvider = (provider: string | undefined): { type: 'ok'; provider?: WebSearchProviderName } | { type: 'invalid' } => {
  if (provider === undefined) return { type: 'ok' };
  if (isWebSearchProviderName(provider)) {
    return { type: 'ok', provider };
  }
  return { type: 'invalid' };
};

// Sum across the `action` dimension so dashboard charts get one row
// per (provider, keyId, hour). Both `search` and `fetch_page` consume
// the same provider quota.
type AggregatedRecord = Omit<SearchUsageRecord, 'action'>;

const sumAcrossActions = (records: readonly SearchUsageRecord[]): AggregatedRecord[] => {
  const grouped = new Map<string, AggregatedRecord>();
  for (const r of records) {
    // JSON-encoded tuple so a delimiter byte inside any component (e.g.
    // `|` smuggled into a future external keyId source) can't collide
    // with the separator.
    const key = JSON.stringify([r.provider, r.keyId, r.hour]);
    const existing = grouped.get(key);
    if (existing) {
      existing.requests += r.requests;
    } else {
      grouped.set(key, { provider: r.provider, keyId: r.keyId, hour: r.hour, requests: r.requests });
    }
  }
  return [...grouped.values()];
};

export const searchUsage = async (c: CtxWithQuery<typeof searchUsageQuery>) => {
  const query = c.req.valid('query');
  const keyId = query.key_id === '' ? undefined : query.key_id;
  const start = query.start ?? '';
  const end = query.end ?? '';
  const includeKeyMetadata = query.include_key_metadata === '1';

  if (!start || !end) {
    return c.json(
      {
        error: 'start and end query parameters are required (e.g. 2026-03-09T00)',
      },
      400,
    );
  }

  const providerResult = parseProvider(query.provider);
  if (providerResult.type === 'invalid') {
    return c.json(
      {
        error: "provider must be 'tavily' or 'microsoft-grounding'",
      },
      400,
    );
  }

  const records = await queryWebSearchUsage({
    provider: providerResult.provider,
    keyId,
    start,
    end,
  });
  const aggregated = sumAcrossActions(records);

  // Aggregated-records-only callers (CI, automation) skip the
  // apiKeys.list() round-trip via include_key_metadata=0.
  if (!includeKeyMetadata) return c.json(aggregated);

  const [keys, searchConfig] = await Promise.all([
    getRepo().apiKeys.list(),
    loadSearchConfig(),
  ]);
  const keyMap = new Map(keys.map(k => [k.id, k]));
  const recordsWithKeyMetadata = aggregated.map(r => ({
    ...r,
    keyName: keyMap.get(r.keyId)?.name ?? r.keyId.slice(0, 8),
    keyCreatedAt: keyMap.get(r.keyId)?.createdAt ?? null,
  }));
  const keyMetadata = keys.map(k => ({ id: k.id, name: k.name, createdAt: k.createdAt })).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

  return c.json({
    records: recordsWithKeyMetadata,
    keys: keyMetadata,
    keyColorOrder: USAGE_KEY_COLOR_ORDER,
    activeProvider: searchConfig.provider,
  });
};
