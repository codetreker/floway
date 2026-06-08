import type { UpstreamProviderKind, UpstreamRecord } from '@floway-dev/provider';
import type { CodexQuotaSnapshot } from '@floway-dev/provider-codex';

export interface SerializedUpstreamRecord {
  id: string;
  provider: UpstreamProviderKind;
  name: string;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  flag_overrides: Record<string, boolean>;
  disabled_public_model_ids: string[];
  config: unknown;
  state: unknown;
  // Present only for provider === 'codex'. Route handlers attach the live
  // snapshot after serialization so this module stays free of provider I/O.
  codex_quota?: CodexQuotaSnapshot | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const clone = <T>(value: T): T => structuredClone(value);

const hasSecret = (value: unknown): boolean => typeof value === 'string' && value.length > 0;

const redactedConfig = (upstream: UpstreamRecord): unknown => {
  const config = isRecord(upstream.config) ? upstream.config : {};

  switch (upstream.provider) {
  case 'custom':
    return {
      ...(config.baseUrl !== undefined ? { baseUrl: clone(config.baseUrl) } : {}),
      ...(config.authStyle !== undefined ? { authStyle: clone(config.authStyle) } : {}),
      ...(config.endpoints !== undefined ? { endpoints: clone(config.endpoints) } : {}),
      ...(config.pathOverrides !== undefined ? { pathOverrides: clone(config.pathOverrides) } : {}),
      ...(config.modelsFetch !== undefined ? { modelsFetch: clone(config.modelsFetch) } : {}),
      ...(config.models !== undefined ? { models: clone(config.models) } : {}),
      bearerTokenSet: hasSecret(config.bearerToken),
    };
  case 'azure':
    return {
      ...(config.endpoint !== undefined ? { endpoint: clone(config.endpoint) } : {}),
      ...(config.models !== undefined ? { models: clone(config.models) } : {}),
      apiKeySet: hasSecret(config.apiKey),
    };
  case 'copilot':
    return {
      ...(config.accountType !== undefined ? { accountType: clone(config.accountType) } : {}),
      ...(config.user !== undefined ? { user: clone(config.user) } : {}),
      githubTokenSet: hasSecret(config.githubToken),
    };
  case 'codex':
    // refresh_token lives in state and is redacted by redactedState.
    return {
      accounts: Array.isArray(config.accounts) ? config.accounts.map(account => {
        const a = isRecord(account) ? account : {};
        return {
          ...(a.email !== undefined ? { email: clone(a.email) } : {}),
          ...(a.chatgptAccountId !== undefined ? { chatgptAccountId: clone(a.chatgptAccountId) } : {}),
          ...(a.chatgptUserId !== undefined ? { chatgptUserId: clone(a.chatgptUserId) } : {}),
          ...(a.planType !== undefined ? { planType: clone(a.planType) } : {}),
        };
      }) : [],
    };
  default: {
    const exhaustive: never = upstream.provider;
    throw new Error(`Unknown upstream provider for redaction: ${String(exhaustive)}`);
  }
  }
};

const redactedState = (upstream: UpstreamRecord): unknown => {
  if (upstream.state === null || upstream.state === undefined) return null;
  const state = isRecord(upstream.state) ? upstream.state : {};

  switch (upstream.provider) {
  case 'codex':
    return {
      accounts: Array.isArray(state.accounts) ? state.accounts.map(account => {
        const a = isRecord(account) ? account : {};
        return {
          ...(a.chatgptAccountId !== undefined ? { chatgptAccountId: clone(a.chatgptAccountId) } : {}),
          ...(a.state !== undefined ? { state: clone(a.state) } : {}),
          ...(a.state_message !== undefined ? { state_message: clone(a.state_message) } : {}),
          state_updated_at: clone(a.state_updated_at),
          refresh_token_set: hasSecret(a.refresh_token),
        };
      }) : [],
    };
  case 'copilot':
  case 'custom':
  case 'azure':
    // No autonomous state today. The column is null in D1 for these; do not
    // synthesize anything.
    return null;
  default: {
    const exhaustive: never = upstream.provider;
    throw new Error(`Unknown upstream provider for state redaction: ${String(exhaustive)}`);
  }
  }
};

const serializeBase = (
  upstream: UpstreamRecord,
  payload: { config: unknown; state: unknown },
): SerializedUpstreamRecord => ({
  id: upstream.id,
  provider: upstream.provider,
  name: upstream.name,
  enabled: upstream.enabled,
  sort_order: upstream.sortOrder,
  created_at: upstream.createdAt,
  updated_at: upstream.updatedAt,
  flag_overrides: { ...upstream.flagOverrides },
  disabled_public_model_ids: [...upstream.disabledPublicModelIds],
  config: payload.config,
  state: payload.state,
});

export const upstreamRecordToJson = (upstream: UpstreamRecord): SerializedUpstreamRecord =>
  serializeBase(upstream, { config: redactedConfig(upstream), state: redactedState(upstream) });

export const upstreamRecordToFullJson = (upstream: UpstreamRecord): SerializedUpstreamRecord =>
  serializeBase(upstream, { config: clone(upstream.config), state: clone(upstream.state) });
