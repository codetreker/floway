import type { InternalModel, UpstreamModel, UpstreamProviderKind } from './model.ts';
import type { ChatCompletionsPayload, ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import type { ModelEndpoints, ModelPricing, ProtocolFrame } from '@floway-dev/protocols/common';
import type { EmbeddingsPayload } from '@floway-dev/protocols/embeddings';
import type { ImagesGenerationsPayload } from '@floway-dev/protocols/images';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ResponsesCompactPayload, ResponsesPayload, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

export interface ProviderModelRecord {
  upstream: string;
  upstreamName: string;
  providerKind: UpstreamProviderKind;
  provider: ModelProvider;
  upstreamModel: UpstreamModel;
  enabledFlags: ReadonlySet<string>;
  supportsResponsesItemReference: boolean;
}

// endpoints describes which endpoints this model is served by on its
// upstream side; it lives on ResolvedModel for planner-only use. The public
// catalog does not expose upstream endpoint identity — the gateway always
// translates between protocols on the data plane, so downstream clients see
// all source endpoints as available for any generation-capable model.
export interface ResolvedModel extends InternalModel {
  endpoints: ModelEndpoints;
  providers: readonly ProviderModelRecord[];
}

export interface ModelProviderInstance {
  upstream: string;
  providerKind: UpstreamProviderKind;
  name: string;
  // Public model ids the operator switched off for this upstream. The registry
  // drops these from the collected catalog (hidden + unroutable); the per-upstream
  // dashboard view bypasses the registry and still sees them so they can be toggled.
  disabledPublicModelIds: readonly string[];
  provider: ModelProvider;
  supportsResponsesItemReference: boolean;
  resolveRequestedModelId?(modelId: string): string | undefined;
}

export interface ProviderCallResult {
  response: Response;
  modelKey: string;
}

// Streaming endpoints (Messages / Responses / ChatCompletions) return decoded
// protocol frames directly — the provider drives the upstream fetch, parses
// the SSE wire via @floway-dev/protocols, and emits the typed event stream.
// `ok: false` carries the raw upstream Response verbatim so the gateway
// boundary can relay status + body unchanged. Non-2xx-but-not-SSE responses
// throw from the provider as a contract violation (provider always forces
// stream=true on streaming endpoints).
export type ProviderStreamResult<TEvent> =
  | { ok: true; events: AsyncIterable<ProtocolFrame<TEvent>>; modelKey: string }
  | { ok: false; response: Response; modelKey: string };

// `/responses/compact` is non-streaming: the provider produces the
// `response.compaction` envelope as a value — Azure/custom parse it from the
// native endpoint, Copilot reshapes it from a `compaction_trigger` turn — so
// the target builds the event frames itself rather than re-parsing a
// synthesized SSE body. An upstream failure carries the raw Response so the
// boundary reports it verbatim.
export type ProviderCompactionResult =
  | { ok: true; result: ResponsesResult; modelKey: string }
  | { ok: false; response: Response; modelKey: string };

export interface ModelProvider {
  getProvidedModels(): Promise<readonly UpstreamModel[]>;
  // Resolve pricing for a usage record's `model_key` (the raw upstream model
  // id). Used by aggregation-time cost computation. Public-model-name lookups
  // happen elsewhere by reading `UpstreamModel.cost` directly.
  getPricingForModelKey(modelKey: string): ModelPricing | null;
  // `headers` is the mutable header bag the caller seeds. A provider may run
  // its own boundary interceptor chain that populates headers (vision,
  // initiator, anthropic-beta, ...) before reaching the wire; the provider
  // passes the bag straight through to the upstream fetch unchanged. The
  // shape is uniform across protocols so provider implementations never
  // branch on which protocol they are serving. Image endpoints have no
  // boundary chain today, but the parameter stays for interface uniformity.
  callChatCompletions(model: UpstreamModel, body: Omit<ChatCompletionsPayload, 'model'>, signal?: AbortSignal, headers?: Record<string, string>): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>>;
  callResponses(model: UpstreamModel, body: Omit<ResponsesPayload, 'model'>, signal?: AbortSignal, headers?: Record<string, string>): Promise<ProviderStreamResult<ResponsesStreamEvent>>;
  // `/responses/compact` is non-streaming: the upstream returns a single
  // `response.compaction` envelope rather than a token stream. Azure/custom
  // pass the native sub-path straight through; Copilot has no native endpoint
  // and replicates codex's RemoteCompactionV2 inside the provider, returning
  // the synthesized envelope as the result value.
  callResponsesCompact(model: UpstreamModel, body: Omit<ResponsesCompactPayload, 'model' | 'store'>, signal?: AbortSignal, headers?: Record<string, string>): Promise<ProviderCompactionResult>;
  // Messages and count_tokens additionally receive the source-derived
  // `anthropicBeta` slice as a typed read-only input separate from the wire
  // headers. Copilot uses it to pick a raw upstream model variant
  // (claude-*-1m-internal vs the standard variant) BEFORE the
  // anthropic-beta boundary interceptor filters the wire header down to the
  // Copilot allow-list. Variant selection must see the caller's full intent
  // even when the beta value itself is dropped before hitting the wire.
  callMessages(model: UpstreamModel, body: Omit<MessagesPayload, 'model'>, signal?: AbortSignal, headers?: Record<string, string>, anthropicBeta?: readonly string[]): Promise<ProviderStreamResult<MessagesStreamEvent>>;
  // count_tokens is non-streaming JSON; the gateway relays the upstream
  // Response verbatim.
  callMessagesCountTokens(model: UpstreamModel, body: Omit<MessagesPayload, 'model'>, signal?: AbortSignal, headers?: Record<string, string>, anthropicBeta?: readonly string[]): Promise<ProviderCallResult>;
  callEmbeddings(model: UpstreamModel, body: Omit<EmbeddingsPayload, 'model'>, signal?: AbortSignal, headers?: Record<string, string>): Promise<ProviderCallResult>;
  callImagesGenerations(model: UpstreamModel, body: Omit<ImagesGenerationsPayload, 'model'>, signal?: AbortSignal, headers?: Record<string, string>): Promise<ProviderCallResult>;
  // The provider takes ownership of `body` and may mutate it (e.g. append
  // the upstream-specific model/deployment id). Callers must allocate a
  // fresh FormData per call — see images/serve.ts, which builds a new
  // FormData per binding for that reason.
  callImagesEdits(model: UpstreamModel, body: FormData, signal?: AbortSignal, headers?: Record<string, string>): Promise<ProviderCallResult>;
}
