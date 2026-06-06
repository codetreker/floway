import type { Interceptor } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ExecuteResult, UpstreamModel } from '@floway-dev/provider';

// Boundary ctx for Copilot Messages interceptors. The chain runs inside
// `provider.callMessages` after the gateway has handed control to the
// provider, so the gateway main flow no longer needs to know that Copilot
// has interceptors at all.
//
// `payload` is the source-shape body with `model` re-attached so interceptors
// that read the public model id (e.g. claude-opus-4-8 carve-outs) keep
// working unchanged; the terminal strips it before serializing to the wire.
// `headers` is the mutable header bag the provider call seeds empty and
// passes straight through to the upstream fetch. `model` is the resolved
// UpstreamModel record. `anthropicBeta` carries the inbound Messages-side
// beta slice so variant selection can read the caller's full intent even
// after the wire header is filtered down to the Copilot allow-list.
export interface MessagesBoundaryCtx {
  payload: MessagesPayload;
  headers: Record<string, string>;
  readonly model: UpstreamModel;
  readonly anthropicBeta?: readonly string[];
}

export type CopilotMessagesBoundaryInterceptor = Interceptor<
  MessagesBoundaryCtx,
  object,
  ExecuteResult<ProtocolFrame<MessagesStreamEvent>>
>;

// count_tokens is a one-shot, non-streaming HTTP exchange: the terminal
// returns the raw upstream `Response` directly. Pure header/payload mutators
// only — post-`run()` event-stream inspection is not portable to this
// result type.
export interface MessagesCountTokensBoundaryCtx {
  payload: MessagesPayload;
  headers: Record<string, string>;
  readonly model: UpstreamModel;
  readonly anthropicBeta?: readonly string[];
}

export type CopilotMessagesCountTokensBoundaryInterceptor = Interceptor<
  MessagesCountTokensBoundaryCtx,
  object,
  Response
>;
