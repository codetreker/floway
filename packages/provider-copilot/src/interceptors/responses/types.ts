import type { Interceptor } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ExecuteResult, ProviderCompactionResult, UpstreamModel } from '@floway-dev/provider';

// Boundary ctx for Copilot Responses interceptors. See messages/types.ts for
// the boundary-isolation rationale; the shape mirrors the Messages boundary
// minus `anthropicBeta` (Responses has no upstream beta-flag input). The same
// ctx shape feeds both the streaming `/responses` chain and the non-streaming
// `/responses/compact` chain; the difference is the result type the terminal
// produces, which is the type parameter on the interceptor aliases below.
export interface ResponsesBoundaryCtx {
  payload: ResponsesPayload;
  headers: Record<string, string>;
  readonly model: UpstreamModel;
}

// Streaming `/responses` chain — terminal returns an ExecuteResult of
// protocol-frame stream events so post-`run()` event-stream mutators
// (whitespace abort, output-item id sync) can rewrite the frames.
export type CopilotResponsesBoundaryInterceptor = Interceptor<
  ResponsesBoundaryCtx,
  object,
  ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>
>;

// Non-streaming `/responses/compact` chain — terminal builds the
// `response.compaction` envelope as a value, so this list only registers
// payload/header mutators. Pure-mutator interceptors are written with a
// `<TResult>` generic so the same definition fits both lists.
export type CopilotResponsesCompactBoundaryInterceptor = Interceptor<
  ResponsesBoundaryCtx,
  object,
  ProviderCompactionResult
>;
