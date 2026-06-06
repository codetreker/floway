import type { ModelProviderInstance, ProviderModelRecord } from './provider.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { GeminiPayload } from '@floway-dev/protocols/gemini';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';

export type LlmTargetApi = 'messages' | 'responses' | 'chat-completions';

// The provider-binding decision the planner made for this attempt: which
// upstream's binding to call and which target protocol to invoke on it.
// The binding carries the upstream identity, the upstream model record,
// the per-binding flag set; `provider` is the resolved upstream provider
// instance the binding came from, retained alongside the binding so the
// call site can register telemetry, invalidate caches, and dispatch the
// upstream call without re-resolving the registry.
export interface ProviderCandidate {
  readonly provider: ModelProviderInstance;
  readonly binding: ProviderModelRecord;
  readonly targetApi: LlmTargetApi;
}

// Per-protocol invocation shape passed to gateway-side interceptors. Carries
// the source-shape request body (mutable so source-side interceptors can clean
// it), the planner's binding decision, and the mutable HTTP-header bag the
// source seeds empty. Gateway-side interceptors that derive trace headers
// populate `headers`; the provider call passes it through to the wire fetch
// unchanged, so workarounds that only need to set or drop a header (vision,
// initiator, anthropic-beta, ...) stay at the owning interceptor boundary
// instead of widening the provider call signature.
export interface MessagesInvocation {
  payload: MessagesPayload;
  readonly candidate: ProviderCandidate;
  // `anthropicBeta` is an inbound Messages concept that crosses native
  // Messages targets; translated targets (Responses, Chat Completions) do not
  // consume it, so it stays optional and is only populated when the source
  // protocol is Messages and the target is Messages.
  readonly anthropicBeta?: readonly string[];
  readonly headers: Record<string, string>;
}

export interface ResponsesInvocation {
  payload: ResponsesPayload;
  readonly candidate: ProviderCandidate;
  readonly headers: Record<string, string>;
}

export interface ChatCompletionsInvocation {
  payload: ChatCompletionsPayload;
  readonly candidate: ProviderCandidate;
  readonly headers: Record<string, string>;
}

export interface GeminiInvocation {
  payload: GeminiPayload;
  readonly candidate: ProviderCandidate;
  readonly headers: Record<string, string>;
}
