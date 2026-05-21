import type { ModelProvider, UpstreamModel } from '../providers/types.ts';
import type { ChatCompletionChunk, ChatCompletionsPayload } from '../shared/protocol/chat-completions.ts';
import type { GeminiGenerateContentRequest, GeminiStreamEvent } from '../shared/protocol/gemini.ts';
import type { MessagesPayload, MessagesStreamEventData } from '../shared/protocol/messages.ts';
import type { ResponsesPayload } from '../shared/protocol/responses.ts';
import type { StreamExecuteResult } from './shared/errors/result.ts';
import type { ResponsesStreamEvent } from './shared/protocol/responses.ts';

export type InterceptorRun<TResult> = () => Promise<TResult>;

export type Interceptor<TContext, TResult> = (ctx: TContext, run: InterceptorRun<TResult>) => Promise<TResult>;

export const runInterceptors = async <TContext, TResult>(ctx: TContext, interceptors: readonly Interceptor<TContext, TResult>[], terminal: InterceptorRun<TResult>): Promise<TResult> => {
  const run = (index: number): Promise<TResult> => (index < interceptors.length ? interceptors[index](ctx, () => run(index + 1)) : terminal());

  return await run(0);
};

export type LlmSourceApi = 'messages' | 'responses' | 'chat-completions' | 'gemini';

export type LlmTargetApi = 'messages' | 'responses' | 'chat-completions';

export interface LlmExchangeMeta {
  sourceApi: LlmSourceApi;
  targetApi: LlmTargetApi;
  model: string;
  upstream: string;
  upstreamModel: UpstreamModel;
  provider: ModelProvider;
  enabledFixes: ReadonlySet<string>;
  apiKeyId?: string;
  downstreamAbortSignal?: AbortSignal;
}

export interface MessagesExchangeContext extends LlmExchangeMeta {
  payload: MessagesPayload;
  anthropicBeta?: readonly string[];
}

export type MessagesExchangeResult = StreamExecuteResult<MessagesStreamEventData>;

export type MessagesInterceptor = Interceptor<MessagesExchangeContext, MessagesExchangeResult>;

export interface ResponsesExchangeContext extends LlmExchangeMeta {
  payload: ResponsesPayload;
}

export type ResponsesExchangeResult = StreamExecuteResult<ResponsesStreamEvent>;

export type ResponsesInterceptor = Interceptor<ResponsesExchangeContext, ResponsesExchangeResult>;

export interface ChatCompletionsExchangeContext extends LlmExchangeMeta {
  payload: ChatCompletionsPayload;
}

export type ChatCompletionsExchangeResult = StreamExecuteResult<ChatCompletionChunk>;

export type ChatCompletionsInterceptor = Interceptor<ChatCompletionsExchangeContext, ChatCompletionsExchangeResult>;

export interface GeminiExchangeContext extends LlmExchangeMeta {
  payload: GeminiGenerateContentRequest;
}

export type GeminiExchangeResult = StreamExecuteResult<GeminiStreamEvent>;

export type GeminiInterceptor = Interceptor<GeminiExchangeContext, GeminiExchangeResult>;
