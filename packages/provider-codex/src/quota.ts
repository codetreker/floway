import type { CacheRepo } from '@floway-dev/provider';

export interface CodexQuotaSnapshot {
  observed_at: string;           // ISO 8601
  active_limit?: string;
  plan_type?: string;

  primary_used_percent?: number;
  primary_window_minutes?: number;
  primary_reset_after_at?: string;

  secondary_used_percent?: number;
  secondary_window_minutes?: number;
  secondary_reset_after_at?: string;

  credits_has_credits?: boolean;
  credits_balance?: number;

  // Present only when this snapshot was written as a result of a 429.
  ratelimited_until?: string;
}

export const codexQuotaKey = (upstreamId: string): string => `codex_quota:${upstreamId}`;

const TTL_FLOOR_MS = 24 * 60 * 60 * 1000;

interface ParseCodexQuotaOptions {
  now: Date;
  isRateLimited: boolean;
}

export const parseCodexQuotaHeaders = (headers: Headers, options: ParseCodexQuotaOptions): CodexQuotaSnapshot => {
  const snapshot: CodexQuotaSnapshot = { observed_at: options.now.toISOString() };
  const assign = snapshot as unknown as Record<string, unknown>;

  const setString = (key: keyof CodexQuotaSnapshot, header: string): void => {
    const v = headers.get(header);
    if (v !== null) assign[key] = v;
  };
  const setNumber = (key: keyof CodexQuotaSnapshot, header: string): void => {
    const v = headers.get(header);
    if (v === null) return;
    const n = Number(v);
    if (Number.isFinite(n)) assign[key] = n;
  };
  const setBool = (key: keyof CodexQuotaSnapshot, header: string): void => {
    const v = headers.get(header);
    if (v === null) return;
    const lower = v.toLowerCase();
    if (lower === 'true') assign[key] = true;
    else if (lower === 'false') assign[key] = false;
  };
  const setResetAfter = (key: keyof CodexQuotaSnapshot, header: string): void => {
    const v = headers.get(header);
    if (v === null) return;
    const seconds = Number(v);
    if (!Number.isFinite(seconds)) return;
    assign[key] = new Date(options.now.getTime() + seconds * 1000).toISOString();
  };

  setString('active_limit', 'x-codex-active-limit');
  setString('plan_type', 'x-codex-plan-type');
  setNumber('primary_used_percent', 'x-codex-primary-used-percent');
  setNumber('primary_window_minutes', 'x-codex-primary-window-minutes');
  setResetAfter('primary_reset_after_at', 'x-codex-primary-reset-after-seconds');
  setNumber('secondary_used_percent', 'x-codex-secondary-used-percent');
  setNumber('secondary_window_minutes', 'x-codex-secondary-window-minutes');
  setResetAfter('secondary_reset_after_at', 'x-codex-secondary-reset-after-seconds');
  setBool('credits_has_credits', 'x-codex-credits-has-credits');
  setNumber('credits_balance', 'x-codex-credits-balance');

  if (options.isRateLimited) {
    const primary = Number(headers.get('x-codex-primary-reset-after-seconds') ?? '0');
    const secondary = Number(headers.get('x-codex-secondary-reset-after-seconds') ?? '0');
    const seconds = Math.max(Number.isFinite(primary) ? primary : 0, Number.isFinite(secondary) ? secondary : 0);
    if (seconds > 0) {
      snapshot.ratelimited_until = new Date(options.now.getTime() + seconds * 1000).toISOString();
    }
  }

  return snapshot;
};

// Bound TTL by the furthest reset horizon to keep a hot account's state
// alive through its entire window; floor at 24h so dashboard reads survive
// quiet periods between bursts.
export const computeCodexQuotaTtlMs = (snapshot: CodexQuotaSnapshot, now: Date): number => {
  const horizons = [snapshot.primary_reset_after_at, snapshot.secondary_reset_after_at, snapshot.ratelimited_until]
    .map(s => s ? new Date(s).getTime() - now.getTime() : 0)
    .filter(ms => ms > 0);
  return Math.max(TTL_FLOOR_MS, ...horizons);
};

// Malformed entries return null rather than throwing — a corrupt cache row
// must never block a request; the next response will rewrite it.
export const getCodexQuota = async (cache: CacheRepo, upstreamId: string): Promise<CodexQuotaSnapshot | null> => {
  const raw = await cache.get(codexQuotaKey(upstreamId));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as CodexQuotaSnapshot;
  } catch {
    return null;
  }
};

export const putCodexQuota = async (cache: CacheRepo, upstreamId: string, snapshot: CodexQuotaSnapshot, ttlMs?: number): Promise<void> => {
  await cache.set(codexQuotaKey(upstreamId), JSON.stringify(snapshot), ttlMs);
};

export const isCodexRateLimited = (snapshot: CodexQuotaSnapshot | null, now: Date): boolean => {
  if (!snapshot?.ratelimited_until) return false;
  return new Date(snapshot.ratelimited_until).getTime() > now.getTime();
};
