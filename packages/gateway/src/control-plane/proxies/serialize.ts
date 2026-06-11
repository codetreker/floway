// Wire-format projection for proxy and backoff repo records. Proxy URLs are
// returned verbatim — the URI itself carries the secret material (password /
// shadowsocks key) that callers need to round-trip when re-editing a row.

import type { BackoffRow, ProxyRecord } from '../../repo/types.ts';

export interface SerializedProxyRecord {
  id: string;
  name: string;
  url: string;
  created_at: string;
  updated_at: string;
  dial_timeout_seconds: number | null;
}

export interface SerializedBackoffRow {
  proxy_id: string;
  upstream_id: string;
  fail_count: number;
  expires_at: number;
  last_error: string | null;
  last_error_at: number | null;
}

export const proxyRecordToJson = (record: ProxyRecord): SerializedProxyRecord => ({
  id: record.id,
  name: record.name,
  url: record.url,
  created_at: record.createdAt,
  updated_at: record.updatedAt,
  dial_timeout_seconds: record.dialTimeoutSeconds,
});

export const backoffRowToJson = (row: BackoffRow): SerializedBackoffRow => ({
  proxy_id: row.proxyId,
  upstream_id: row.upstreamId,
  fail_count: row.failCount,
  expires_at: row.expiresAt,
  last_error: row.lastError,
  last_error_at: row.lastErrorAt,
});
