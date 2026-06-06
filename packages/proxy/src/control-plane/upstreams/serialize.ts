import type { UpstreamProviderKind, UpstreamRecord } from '@floway-dev/provider';

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
  default: {
    const exhaustive: never = upstream.provider;
    throw new Error(`Unknown upstream provider for redaction: ${String(exhaustive)}`);
  }
  }
};

const serializeBase = (upstream: UpstreamRecord, config: unknown): SerializedUpstreamRecord => ({
  id: upstream.id,
  provider: upstream.provider,
  name: upstream.name,
  enabled: upstream.enabled,
  sort_order: upstream.sortOrder,
  created_at: upstream.createdAt,
  updated_at: upstream.updatedAt,
  flag_overrides: { ...upstream.flagOverrides },
  disabled_public_model_ids: [...upstream.disabledPublicModelIds],
  config,
});

export const upstreamRecordToJson = (upstream: UpstreamRecord): SerializedUpstreamRecord => serializeBase(upstream, redactedConfig(upstream));

export const upstreamRecordToFullJson = (upstream: UpstreamRecord): SerializedUpstreamRecord => serializeBase(upstream, clone(upstream.config));
