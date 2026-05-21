import type { Context } from 'hono';

import { planChatRequest } from './plan.ts';
import { respondChatCompletions } from './respond.ts';
import { getModelCapabilities } from '../../../providers/capabilities.ts';
import { resolveModelForRequest } from '../../../providers/registry.ts';
import type { ProviderModelRecord } from '../../../providers/types.ts';
import type { ChatCompletionChunk, ChatCompletionsPayload } from '../../../shared/protocol/chat-completions.ts';
import type { MessagesPayload } from '../../../shared/protocol/messages.ts';
import type { ResponsesPayload } from '../../../shared/protocol/responses.ts';
import { type PerformanceTelemetryContext } from '../../../shared/telemetry/performance.ts';
import { type ChatCompletionsInterceptor, type ChatCompletionsInvocation, type LlmTargetApi, runInterceptors } from '../../interceptors.ts';
import type { ExecuteResult } from '../../shared/errors/result.ts';
import type { ProtocolFrame } from '../../shared/stream/types.ts';
import { emitToChatCompletions } from '../../targets/chat-completions/emit.ts';
import { emitToMessages } from '../../targets/messages/emit.ts';
import { emitToResponses } from '../../targets/responses/emit.ts';
import { chatCompletionsViaMessagesTranslation } from '../../translate/chat-completions-via-messages/index.ts';
import { chatCompletionsViaResponsesTranslation } from '../../translate/chat-completions-via-responses/index.ts';
import { type SourceEmit, viaTranslation } from '../../translate/types.ts';
import { createRequestContext, openAiMissingModelResult, openAiUnsupportedEndpointResult, sourceErrorResult } from '../execute.ts';

const chatSourceInterceptorsForProvider = (binding: ProviderModelRecord): readonly ChatCompletionsInterceptor[] => binding.sourceInterceptors?.chatCompletions ?? [];

const chatInvocation = <TPayload extends { model: string }>(
  binding: ProviderModelRecord,
  targetApi: LlmTargetApi,
  model: string,
  payload: TPayload,
) => ({
  sourceApi: 'chat-completions' as const,
  targetApi,
  model,
  upstream: binding.upstream,
  upstreamModel: binding.upstreamModel,
  provider: binding.provider,
  enabledFixes: binding.enabledFixes,
  ...(binding.targetInterceptors !== undefined ? { targetInterceptors: binding.targetInterceptors } : {}),
  payload,
});

export const serveChatCompletions = async (c: Context): Promise<Response> => {
  let lastPerformance: PerformanceTelemetryContext | undefined;
  const rememberPerformance = <T extends { performance?: PerformanceTelemetryContext }>(result: T): T => {
    if (result.performance) lastPerformance = result.performance;
    return result;
  };

  let request = createRequestContext(c, undefined, false);
  let downstreamAbortController: AbortController | undefined;
  // Target interceptors may force upstream usage for gateway accounting, but
  // Chat SSE exposes usage only when the caller requested `include_usage`.
  let includeUsageChunk = false;

  try {
    const payload = await c.req.json<ChatCompletionsPayload>();
    includeUsageChunk = payload.stream_options?.include_usage === true;
    const wantsStream = payload.stream === true;
    downstreamAbortController = wantsStream ? new AbortController() : undefined;
    request = createRequestContext(c, downstreamAbortController?.signal, wantsStream);

    const { id: model, model: resolved } = await resolveModelForRequest(payload.model);
    let result: ExecuteResult<ProtocolFrame<ChatCompletionChunk>> | undefined;

    if (!resolved) {
      result = openAiMissingModelResult(model);
    } else {
      for (const binding of resolved.providers) {
        const attemptPayload = structuredClone(payload);
        attemptPayload.model = model;
        const capabilities = getModelCapabilities(binding.upstreamModel);
        const plan = planChatRequest(capabilities);
        if (!plan) continue;

        const invocation: ChatCompletionsInvocation = chatInvocation(binding, plan.target, model, attemptPayload);

        const emits: Record<LlmTargetApi, SourceEmit<ChatCompletionsPayload, ChatCompletionChunk>> = {
          'chat-completions': async srcPayload => rememberPerformance(await emitToChatCompletions({ ...invocation, payload: srcPayload }, request)),
          messages: viaTranslation(chatCompletionsViaMessagesTranslation, async (tgtPayload: MessagesPayload) =>
            rememberPerformance(await emitToMessages(chatInvocation(binding, 'messages', model, tgtPayload), request))),
          responses: viaTranslation(chatCompletionsViaResponsesTranslation, async (tgtPayload: ResponsesPayload) =>
            rememberPerformance(await emitToResponses(chatInvocation(binding, 'responses', model, tgtPayload), request))),
        };

        result = await runInterceptors(invocation, request, chatSourceInterceptorsForProvider(binding), () =>
          emits[plan.target](invocation.payload, { model, wantsStream, capabilities }));
        break;
      }

      result ??= openAiUnsupportedEndpointResult(model, '/chat/completions');
    }

    return await respondChatCompletions(c, result, wantsStream, includeUsageChunk, request, lastPerformance, downstreamAbortController);
  } catch (error) {
    return await respondChatCompletions(
      c,
      sourceErrorResult(error, {
        sourceApi: 'chat-completions',
        internalStatus: 502,
        lastPerformance,
      }),
      false,
      includeUsageChunk,
      request,
      lastPerformance,
      downstreamAbortController,
    );
  }
};
