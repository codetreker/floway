import type { InternalModel, UpstreamModel, UpstreamProviderKind } from './model.ts';
import type { Fetcher } from './options.ts';
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

export interface ResolvedModel extends InternalModel {
  endpoints: ModelEndpoints;
  providers: readonly ProviderModelRecord[];
}

export interface ModelProviderInstance {
  upstream: string;
  providerKind: UpstreamProviderKind;
  name: string;
  // Public model ids the operator switched off for this upstream.
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

// `/responses/compact` is non-streaming — the upstream returns a single
// `response.compaction` envelope. Some upstreams expose a native compaction
// endpoint and produce the envelope directly; others synthesize the
// envelope from a regular `/responses` turn — both return the typed value
// rather than a re-parsed synthesized SSE body. An upstream failure
// carries the raw Response so the boundary reports it verbatim.
export type ProviderCompactionResult =
  | { ok: true; result: ResponsesResult; modelKey: string }
  | { ok: false; response: Response; modelKey: string };

// Per-call observation hooks the gateway threads through to the provider.
//
// `fetcher` is the per-upstream proxy-aware indirection for outbound HTTP.
// Every upstream call (data-plane request, OAuth refresh, etc.) must go
// through this fetcher so a single fallback chain governs every leg of the
// call under restricted egress.
//
// `recordUpstreamLatency` measures the precise upstream round-trip — request
// leaves the gateway, response returns to the gateway — and explicitly excludes
// in-process work the provider does around the call (boundary interceptors,
// auth-token refresh, request/response shaping, SSE parsing). The provider is
// required to wrap the actual upstream fetch promise with this helper at least
// once; the gateway throws on a violation so missing wraps fail loud. On
// retries (e.g. invalidate-token-and-redo), only the most recent invocation's
// measurement is kept.
export interface UpstreamCallOptions {
  fetcher: Fetcher;
  recordUpstreamLatency: <T>(promise: Promise<T>) => Promise<T>;
}

export interface ModelProvider {
  // Catalog refresh fetches a single resource and never enters the per-request
  // latency budget, so it takes the per-upstream fetcher directly instead of
  // the broader `UpstreamCallOptions` bag the data-plane `call*` methods use.
  getProvidedModels(fetcher: Fetcher): Promise<readonly UpstreamModel[]>;
  // Resolve pricing for a usage record's `model_key` (the raw upstream model id).
  getPricingForModelKey(modelKey: string): ModelPricing | null;
  // `headers` is the mutable header bag the caller seeds. A provider may run
  // its own boundary interceptor chain that populates headers (vision,
  // initiator, anthropic-beta, ...) before reaching the wire; the provider
  // passes the bag straight through to the upstream fetch unchanged. The
  // shape is uniform across protocols so provider implementations never
  // branch on which protocol they are serving. Image endpoints have no
  // boundary chain today, but the parameter stays for interface uniformity.
  callChatCompletions(model: UpstreamModel, body: Omit<ChatCompletionsPayload, 'model'>, signal: AbortSignal | undefined, headers: Record<string, string> | undefined, opts: UpstreamCallOptions): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>>;
  callResponses(model: UpstreamModel, body: Omit<ResponsesPayload, 'model'>, signal: AbortSignal | undefined, headers: Record<string, string> | undefined, opts: UpstreamCallOptions): Promise<ProviderStreamResult<ResponsesStreamEvent>>;
  callResponsesCompact(model: UpstreamModel, body: Omit<ResponsesCompactPayload, 'model' | 'store'>, signal: AbortSignal | undefined, headers: Record<string, string> | undefined, opts: UpstreamCallOptions): Promise<ProviderCompactionResult>;
  // Messages and count_tokens additionally receive the source-derived
  // `anthropicBeta` slice as a typed read-only input separate from the wire
  // headers. Some providers select among raw upstream model variants based
  // on caller-declared anthropic-beta values BEFORE a boundary interceptor
  // filters the wire header down to an upstream allow-list. The typed slice
  // gives variant selection access to the caller's full intent even when
  // the beta is dropped before hitting the wire.
  callMessages(model: UpstreamModel, body: Omit<MessagesPayload, 'model'>, signal: AbortSignal | undefined, headers: Record<string, string> | undefined, anthropicBeta: readonly string[] | undefined, opts: UpstreamCallOptions): Promise<ProviderStreamResult<MessagesStreamEvent>>;
  // count_tokens is non-streaming JSON; the gateway relays the upstream
  // Response verbatim.
  callMessagesCountTokens(model: UpstreamModel, body: Omit<MessagesPayload, 'model'>, signal: AbortSignal | undefined, headers: Record<string, string> | undefined, anthropicBeta: readonly string[] | undefined, opts: UpstreamCallOptions): Promise<ProviderCallResult>;
  callEmbeddings(model: UpstreamModel, body: Omit<EmbeddingsPayload, 'model'>, signal: AbortSignal | undefined, headers: Record<string, string> | undefined, opts: UpstreamCallOptions): Promise<ProviderCallResult>;
  callImagesGenerations(model: UpstreamModel, body: Omit<ImagesGenerationsPayload, 'model'>, signal: AbortSignal | undefined, headers: Record<string, string> | undefined, opts: UpstreamCallOptions): Promise<ProviderCallResult>;
  // The provider takes ownership of `body` and may mutate it (e.g. append
  // the upstream-specific model/deployment id). Callers must allocate a
  // fresh FormData per call.
  callImagesEdits(model: UpstreamModel, body: FormData, signal: AbortSignal | undefined, headers: Record<string, string> | undefined, opts: UpstreamCallOptions): Promise<ProviderCallResult>;
}
