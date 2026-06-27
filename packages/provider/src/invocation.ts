import type { Fetcher } from './options.ts';
import type { ModelProviderInstance, ProviderModelRecord, ResponsesAction } from './provider.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { GeminiPayload } from '@floway-dev/protocols/gemini';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';

export type ChatTargetApi = 'messages' | 'responses' | 'chat-completions';

// The provider-binding decision for this attempt: which upstream's binding
// to call and which target protocol to invoke on it. `provider` is the
// resolved upstream provider instance the binding came from, retained
// alongside `binding` so dispatch can run without re-resolving the registry.
// `fetcher` is the per-upstream Fetcher minted at request time.
export interface ProviderCandidate {
  readonly provider: ModelProviderInstance;
  readonly binding: ProviderModelRecord;
  readonly targetApi: ChatTargetApi;
  readonly fetcher: Fetcher;
}

// Per-protocol invocation shape passed to interceptors. Carries the
// source-shape request body (mutable, so the body can be cleaned), the
// planner's binding decision, and a mutable `Headers` instance carried into
// the boundary chain — so workarounds that only need to set or drop a
// header stay at the owning interceptor boundary instead of widening the
// provider call signature.
export interface MessagesInvocation {
  payload: MessagesPayload;
  readonly candidate: ProviderCandidate;
  readonly headers: Headers;
}

export interface ResponsesInvocation {
  payload: ResponsesPayload;
  // Mutable action tag — interceptors can flip 'compact' to 'generate' so the
  // inner provider call runs a normal summarization turn (see the
  // responses-compact-shim) and the gateway derives snapshot mode from the
  // post-chain action carried on the provider's tagged result.
  action: ResponsesAction;
  readonly candidate: ProviderCandidate;
  readonly headers: Headers;
}

export interface ChatCompletionsInvocation {
  payload: ChatCompletionsPayload;
  readonly candidate: ProviderCandidate;
  readonly headers: Headers;
}

export interface GeminiInvocation {
  payload: GeminiPayload;
  readonly candidate: ProviderCandidate;
  readonly headers: Headers;
}
