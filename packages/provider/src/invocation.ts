import type { Fetcher } from './options.ts';
import type { ModelProviderInstance, ProviderModelRecord } from './provider.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { GeminiPayload } from '@floway-dev/protocols/gemini';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';

export type LlmTargetApi = 'messages' | 'responses' | 'chat-completions';

// The provider-binding decision for this attempt: which upstream's binding
// to call and which target protocol to invoke on it. `provider` is the
// resolved upstream provider instance the binding came from, retained
// alongside `binding` so dispatch can run without re-resolving the registry.
// `fetcher` is the per-upstream Fetcher minted at request time.
export interface ProviderCandidate {
  readonly provider: ModelProviderInstance;
  readonly binding: ProviderModelRecord;
  readonly targetApi: LlmTargetApi;
  readonly fetcher: Fetcher;
}

// Per-protocol invocation shape passed to interceptors. Carries the
// source-shape request body (mutable, so the body can be cleaned), the
// planner's binding decision, and a mutable HTTP-header bag passed through
// to the wire fetch unchanged — so workarounds that only need to set or
// drop a header stay at the owning interceptor boundary instead of widening
// the provider call signature.
export interface MessagesInvocation {
  payload: MessagesPayload;
  readonly candidate: ProviderCandidate;
  // `anthropicBeta` is an inbound Messages concept that crosses native
  // Messages targets; translated targets do not consume it, so it stays
  // optional and is only populated when the source and target are Messages.
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
