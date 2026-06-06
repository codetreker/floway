import type { Interceptor } from '@floway-dev/interceptor';
import type { ChatCompletionsPayload, ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult, UpstreamModel } from '@floway-dev/provider';

// Boundary ctx for Copilot Chat Completions interceptors. See messages/types.ts
// for the boundary-isolation rationale.
export interface ChatCompletionsBoundaryCtx {
  payload: ChatCompletionsPayload;
  headers: Record<string, string>;
  readonly model: UpstreamModel;
}

export type CopilotChatCompletionsBoundaryInterceptor = Interceptor<
  ChatCompletionsBoundaryCtx,
  object,
  ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>
>;
