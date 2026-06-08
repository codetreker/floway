import type { ModelKind, ModelEndpoints, ModelPricing } from '@floway-dev/protocols/common';

// A provider's data instance — one row in the upstreams table. Pure data; the
// per-kind provider package validates `config` against its own schema.
export type UpstreamProviderKind = 'copilot' | 'custom' | 'azure' | 'codex';

export interface UpstreamRecord {
  id: string;
  provider: UpstreamProviderKind;
  name: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  config: unknown;
  // Gateway-managed runtime state, persisted in upstreams.state_json. Null for
  // providers that have no autonomous persistent state; populated by the
  // per-kind provider package's state type when present (e.g. Codex's rotated
  // refresh-token + health). Operator HTTP edits never write this column;
  // only the gateway's autonomous flows do, via UpstreamRepo.saveState with
  // optimistic concurrency.
  state: unknown;
  flagOverrides: Record<string, boolean>;
  // Public model ids the operator switched off for this upstream. Orthogonal to
  // every per-model metadata field and uniform across provider kinds: a disabled
  // id is hidden from the catalog and unroutable, but its row metadata stays
  // editable. Entries may reference ids no longer present in the live model list.
  disabledPublicModelIds: string[];
}

// API names the telemetry pipeline records dimensions against. Used by
// PerformanceTelemetryContext below; the proxy-side recorder narrows further
// per source/target lane.
export type PerformanceApiName = 'messages' | 'responses' | 'chat-completions' | 'gemini' | 'embeddings' | 'images_generations' | 'images_edits';

// Pure data identifying the model served by one provider call. Travels alongside
// every event/error result so downstream telemetry never has to re-resolve.
export interface TelemetryModelIdentity {
  model: string;
  upstream: string;
  modelKey: string;
  cost: ModelPricing | null;
}

// Context that the proxy-side recorder reads when writing latency/error metrics.
// Provider-layer code only constructs and forwards it; never reads fields.
export interface PerformanceTelemetryContext {
  keyId: string;
  model: string;
  upstream: string | null;
  modelKey: string;
  sourceApi: PerformanceApiName;
  targetApi: PerformanceApiName;
  stream: boolean;
  runtimeLocation: string;
}

// The internal model shape: what providers produce and what the registry
// stores. Only fields the data plane actually consumes — to expose downstream
// (id, display_name, owned_by, created, limits) or to drive request-time
// decisions (max_output_tokens as the translation fallback). Provider-internal
// raw fields stay inside that provider's own types and projections; nothing
// upstream-shaped leaks onto this neutral type.
//
// `kind` is the high-level endpoint-family discriminator; `endpoints`
// (on UpstreamModel) is the precise per-protocol availability map used by
// the planner. They are linked invariants enforced at the producer boundary:
//   `kind === 'embedding'` ⇔ `endpoints === { embeddings: {} }`
//   `kind === 'image'`     ⇔ `endpoints ⊂ {imagesGenerations, imagesEdits}`
//   `kind === 'chat'`      ⇒ `endpoints ⊂ generation endpoints`.
export interface InternalModel {
  id: string;
  display_name?: string;
  owned_by?: string;
  created?: number;
  limits: {
    max_output_tokens?: number;
    max_context_window_tokens?: number;
    max_prompt_tokens?: number;
  };
  kind: ModelKind;
  cost?: ModelPricing;
}

export interface UpstreamModel extends InternalModel {
  endpoints: ModelEndpoints;
  providerData?: unknown;
  enabledFlags: ReadonlySet<string>;
}
