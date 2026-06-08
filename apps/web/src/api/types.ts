// Control-plane DTOs the SPA consumes. These mirror the serialized shapes that
// the gateway emits from the unified /api endpoints — keeping them here (rather
// than re-using internal repo types) prevents the bundler from pulling Worker
// runtime code into the browser bundle.

export type UpstreamProviderKind = 'custom' | 'azure' | 'copilot' | 'codex';

export type ModelKind = 'chat' | 'embedding' | 'image';

// Structured per-endpoint capability map. Mirrors @floway-dev/protocols
// ModelEndpoints: a present key means the model is served by that endpoint.
export interface ModelEndpoints {
  chatCompletions?: {};
  responses?: {};
  messages?: {};
  embeddings?: {};
  imagesGenerations?: {};
  imagesEdits?: {};
}

export type ModelEndpointKey = keyof ModelEndpoints;

// USD per million tokens, keyed by billing dimension. Mirrors
// @floway-dev/protocols ModelPricing; every key is optional.
export type ModelPricing = Partial<Record<'input' | 'input_cache_read' | 'input_cache_write' | 'input_image' | 'output' | 'output_image', number>>;

export interface UpstreamModelConfig {
  upstreamModelId: string;
  publicModelId?: string;
  kind: ModelKind;
  endpoints: ModelEndpoints;
  display_name?: string;
  limits?: { max_context_window_tokens?: number; max_prompt_tokens?: number; max_output_tokens?: number };
  cost?: ModelPricing;
  flagOverrides?: { enabled: boolean; values: Record<string, boolean> };
}

export interface CustomModelsFetch {
  enabled: boolean;
  endpoint?: string;
}

// Raw model entries returned by the draft /models browse endpoint
// (POST /api/upstreams/fetch-models). Permissive superset of the OpenAI,
// Anthropic, and floway-native /models shapes the backend parser admits.
export interface CustomRawModel {
  id: string;
  display_name?: string;
  name?: string;
  created?: number;
  owned_by?: string;
  limits?: ModelLimits;
  cost?: ModelPricing;
  kind?: 'chat' | 'embedding' | 'image';
}

export interface CustomUpstreamConfig {
  baseUrl: string;
  authStyle: 'bearer' | 'anthropic';
  endpoints: ModelEndpoints;
  pathOverrides?: Record<string, string>;
  modelsFetch: CustomModelsFetch;
  models: UpstreamModelConfig[];
  bearerTokenSet?: boolean;
}

export interface AzureUpstreamConfig {
  endpoint: string;
  apiKeySet?: boolean;
  models: UpstreamModelConfig[];
}

export interface CopilotUser {
  login: string;
  avatar_url: string;
  name: string | null;
  id: number;
}

export interface CopilotUpstreamConfig {
  accountType: 'individual' | 'business' | 'enterprise';
  user: CopilotUser;
  githubTokenSet?: boolean;
}

// Account-pool identities derived from the id_token at codex import. v1
// always carries exactly one account; the array shape lets a future fan-out
// land without a wire-format change. refresh_token lives in state and is
// exposed only as a `refresh_token_set` boolean per account (see
// CodexUpstreamState below).
export interface CodexAccountIdentity {
  email: string;
  chatgptAccountId: string;
  chatgptUserId: string;
  planType: string;
}

export interface CodexUpstreamConfig {
  accounts: CodexAccountIdentity[];
}

export interface CodexAccountCredentialState {
  chatgptAccountId: string;
  state: 'active' | 'session_terminated' | 'refresh_failed';
  state_message?: string;
  state_updated_at: string;
  refresh_token_set: boolean;
}

export interface CodexUpstreamState {
  accounts: CodexAccountCredentialState[];
}

export interface CodexQuotaSnapshot {
  observed_at: string;
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
  ratelimited_until?: string;
}

export interface UpstreamRecord {
  id: string;
  provider: UpstreamProviderKind;
  name: string;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  flag_overrides: Record<string, boolean>;
  // Public model ids switched off for this upstream. Hidden from the catalog and
  // unroutable, but their per-model metadata stays editable. May include ids no
  // longer present in the live model list.
  disabled_public_model_ids: string[];
  config: CustomUpstreamConfig | AzureUpstreamConfig | CopilotUpstreamConfig | CodexUpstreamConfig;
  // Codex is the only provider that ships gateway-managed state on the row
  // today; the other providers serialize this as null.
  state: CodexUpstreamState | null;
  // Present only for provider === 'codex'; serialized inline so the dashboard
  // renders the quota panel without a follow-up fetch.
  codex_quota?: CodexQuotaSnapshot | null;
}

export interface FlagDef {
  id: string;
  label: string;
  description: string;
  defaultFor: UpstreamProviderKind[];
}

export interface ApiKey {
  id: string;
  name: string;
  key: string;
  created_at: string;
  last_used_at: string | null;
  upstream_ids: string[] | null;
}

export interface ModelEndpointInfo {
  url: string;
  doc?: string;
}

export interface ModelLimits {
  max_context_window_tokens?: number;
  max_prompt_tokens?: number;
  max_output_tokens?: number;
}

export interface PublicModel {
  id: string;
  display_name?: string;
  limits?: ModelLimits;
  endpoints?: Record<string, ModelEndpointInfo>;
  cost?: ModelPricing;
  kind?: 'chat' | 'embedding' | 'image';
}

export interface ControlPlaneModel extends PublicModel {
  upstreams: { kind: UpstreamProviderKind; id: string; name: string }[];
}

export interface SearchConfig {
  provider: 'disabled' | 'tavily' | 'microsoft-grounding';
  tavily: { apiKey: string };
  microsoftGrounding: { apiKey: string };
}

export interface CopilotQuotaSnapshot {
  quota_snapshots?: {
    premium_interactions?: {
      entitlement: number;
      remaining: number;
      reset_date?: string;
    };
  };
}

export interface DeviceFlowStart {
  user_code: string;
  verification_uri: string;
  device_code: string;
  interval: number;
}

export interface DeviceFlowPoll {
  status: 'pending' | 'complete' | 'slow_down' | 'error';
  upstream?: UpstreamRecord;
  error?: string;
  interval?: number;
}
