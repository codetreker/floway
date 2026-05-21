import type { UpstreamConfig } from '../../repo/types.ts';

// Public-facing serialization: omit the bearer token by default and instead
// expose `bearer_token_set` so the dashboard can show whether a credential
// is on file without exposing it. The full bearer is only revealed by the
// admin export path, which already returns the entire repo dump.
export const upstreamConfigToJson = (cfg: UpstreamConfig) => ({
  id: cfg.id,
  name: cfg.name,
  base_url: cfg.baseUrl,
  bearer_token_set: cfg.bearerToken.length > 0,
  supported_endpoints: cfg.supportedEndpoints,
  enabled: cfg.enabled,
  sort_order: cfg.sortOrder,
  created_at: cfg.createdAt,
  enabled_fixes: cfg.enabledFixes,
  ...(cfg.pathOverrides ? { path_overrides: cfg.pathOverrides } : {}),
});

export const upstreamConfigToFullJson = (cfg: UpstreamConfig) => ({
  id: cfg.id,
  name: cfg.name,
  base_url: cfg.baseUrl,
  bearer_token: cfg.bearerToken,
  supported_endpoints: cfg.supportedEndpoints,
  enabled: cfg.enabled,
  sort_order: cfg.sortOrder,
  created_at: cfg.createdAt,
  enabled_fixes: cfg.enabledFixes,
  ...(cfg.pathOverrides ? { path_overrides: cfg.pathOverrides } : {}),
});
