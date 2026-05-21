import type { BackgroundScheduler } from '../../runtime/background.ts';
import type { ModelProvider, ProviderTargetInterceptors, UpstreamModel } from '../providers/types.ts';
import type { ChatCompletionChunk, ChatCompletionsPayload } from '../shared/protocol/chat-completions.ts';
import type { GeminiGenerateContentRequest, GeminiStreamEvent } from '../shared/protocol/gemini.ts';
import type { MessagesPayload, MessagesStreamEventData } from '../shared/protocol/messages.ts';
import type { ResponsesPayload } from '../shared/protocol/responses.ts';
import type { RecordRequestPerformance } from '../shared/telemetry/performance.ts';
import type { RecordUsage } from '../shared/telemetry/usage.ts';
import type { ExecuteResult } from './shared/errors/result.ts';
import type { ResponsesStreamEvent } from './shared/protocol/responses.ts';
import type { ProtocolFrame } from './shared/stream/types.ts';

export type LlmSourceApi = 'messages' | 'responses' | 'chat-completions' | 'gemini';

export type LlmTargetApi = 'messages' | 'responses' | 'chat-completions';

/**
 * Per-HTTP-request invariants. Constructed once when the source serve handler
 * receives `c: Context` (in `createRequestContext`) and threaded through every
 * layer (source interceptors, target emits, target interceptors, telemetry).
 *
 * Fields that never change across provider-binding attempts or interceptor
 * passes belong here. Fields that depend on which binding the planner is
 * trying belong on `Invocation`.
 *
 * - apiKeyId / runtimeLocation / scheduleBackground / recordUsage /
 *   recordRequestPerformance / requestStartedAt: bound to the HTTP request,
 *   not to a binding choice.
 * - downstreamAbortSignal: tied to the downstream Response stream lifetime,
 *   which exists at the request scope, not the binding scope.
 *
 * apiKeyId and downstreamAbortSignal live on RequestContext rather than on
 * the per-binding Invocation because the api key never changes for a given
 * request and the downstream abort signal is bound to the HTTP response.
 *
 * Mutable per-request state (last performance row, downstream abort
 * controller) is intentionally NOT here. It lives as local variables in the
 * source serve function. `RequestContext` is plain read-only data and is safe
 * to share with closures and background tasks.
 */
export interface RequestContext {
  readonly requestStartedAt: number;
  readonly apiKeyId?: string;
  readonly runtimeLocation: string;
  readonly scheduleBackground?: BackgroundScheduler;
  readonly recordUsage: RecordUsage;
  readonly recordRequestPerformance: RecordRequestPerformance;
  readonly downstreamAbortSignal?: AbortSignal;
  readonly clientStream: boolean;
}

/**
 * Per-provider-binding-attempt request-side description. Rebuilt for every
 * binding the planner tries inside one HTTP request.
 *
 * - sourceApi / targetApi: the protocol the client spoke and the protocol
 *   the planner picked for this binding.
 * - model: the resolved public model id.
 * - upstream / upstreamModel / provider: the planner's binding choice.
 * - enabledFixes: the upstream-fix set for this binding.
 * - targetInterceptors: the provider-registered target interceptor table.
 * - payload: the source-shape request body, mutable so source interceptors
 *   can clean it.
 *
 * Named `Invocation` (not `Exchange`) because "exchange" implies a
 * request/response pair; this object carries only the request side plus the
 * planner's binding decisions. The response flows through `ExecuteResult`,
 * not back through `Invocation`.
 *
 * apiKeyId, downstreamAbortSignal, telemetry recorders are NOT on
 * `Invocation` — they belong on `RequestContext` because they don't change
 * when the planner tries another binding.
 */
export interface Invocation<TPayload> {
  readonly sourceApi: LlmSourceApi;
  readonly targetApi: LlmTargetApi;
  readonly model: string;
  readonly upstream: string;
  readonly upstreamModel: UpstreamModel;
  readonly provider: ModelProvider;
  readonly enabledFixes: ReadonlySet<string>;
  readonly targetInterceptors?: ProviderTargetInterceptors;
  payload: TPayload;
}

export interface MessagesInvocation extends Invocation<MessagesPayload> {
  readonly anthropicBeta?: readonly string[];
}
export type ResponsesInvocation = Invocation<ResponsesPayload>;
export type ChatCompletionsInvocation = Invocation<ChatCompletionsPayload>;
export type GeminiInvocation = Invocation<GeminiGenerateContentRequest>;

export type InterceptorRun<TResult> = () => Promise<TResult>;

export type Interceptor<TContext, TRequest, TResult> = (ctx: TContext, request: TRequest, run: InterceptorRun<TResult>) => Promise<TResult>;

export const runInterceptors = async <TContext, TRequest, TResult>(
  ctx: TContext,
  request: TRequest,
  interceptors: readonly Interceptor<TContext, TRequest, TResult>[],
  terminal: InterceptorRun<TResult>,
): Promise<TResult> => {
  const run = (index: number): Promise<TResult> => (index < interceptors.length ? interceptors[index](ctx, request, () => run(index + 1)) : terminal());

  return await run(0);
};

export type MessagesInterceptor = Interceptor<MessagesInvocation, RequestContext, ExecuteResult<ProtocolFrame<MessagesStreamEventData>>>;
export type ResponsesInterceptor = Interceptor<ResponsesInvocation, RequestContext, ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>>;
export type ChatCompletionsInterceptor = Interceptor<ChatCompletionsInvocation, RequestContext, ExecuteResult<ProtocolFrame<ChatCompletionChunk>>>;
export type GeminiInterceptor = Interceptor<GeminiInvocation, RequestContext, ExecuteResult<ProtocolFrame<GeminiStreamEvent>>>;
