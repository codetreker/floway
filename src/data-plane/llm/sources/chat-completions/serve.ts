import type { Context } from 'hono';

import { planChatRequest } from './plan.ts';
import { respondChatCompletions } from './respond.ts';
import { getModelCapabilities } from '../../../providers/capabilities.ts';
import { resolveModelForRequest } from '../../../providers/registry.ts';
import type { ProviderModelRecord } from '../../../providers/types.ts';
import type { ChatCompletionChunk, ChatCompletionsPayload } from '../../../shared/protocol/chat-completions.ts';
import { type ChatCompletionsInterceptor, runInterceptors } from '../../interceptors.ts';
import type { StreamExecuteResult } from '../../shared/errors/result.ts';
import { emitToChatCompletions } from '../../targets/chat-completions/emit.ts';
import { emitToMessages } from '../../targets/messages/emit.ts';
import { emitToResponses } from '../../targets/responses/emit.ts';
import { translateToSourceEvents as translateMessagesToSourceEvents } from '../../translate/chat-completions-via-messages/events.ts';
import { buildTargetRequest as buildMessagesTargetRequest } from '../../translate/chat-completions-via-messages/request.ts';
import { translateToSourceEvents as translateResponsesToSourceEvents } from '../../translate/chat-completions-via-responses/events.ts';
import { buildTargetRequest as buildResponsesTargetRequest } from '../../translate/chat-completions-via-responses/request.ts';
import { createSourceExecutionContext, openAiMissingModelResult, openAiUnsupportedEndpointResult, sourceErrorResult, sourceExchangeMeta, sourceTargetInput } from '../execute.ts';

const chatSourceInterceptorsForProvider = (binding: ProviderModelRecord): readonly ChatCompletionsInterceptor[] => binding.sourceInterceptors?.chatCompletions ?? [];

export const serveChatCompletions = async (c: Context): Promise<Response> => {
  const source = createSourceExecutionContext(c);
  // Target interceptors may force upstream usage for gateway accounting, but
  // Chat SSE exposes usage only when the caller requested `include_usage`.
  let includeUsageChunk = false;
  try {
    const payload = await c.req.json<ChatCompletionsPayload>();
    includeUsageChunk = payload.stream_options?.include_usage === true;
    const wantsStream = payload.stream === true;
    source.beginDownstream(wantsStream);

    const { id: model, model: resolved } = await resolveModelForRequest(payload.model);
    let result: StreamExecuteResult<ChatCompletionChunk> | undefined;

    if (!resolved) {
      result = openAiMissingModelResult(model);
    } else {
      for (const binding of resolved.providers) {
        const attemptPayload = structuredClone(payload);
        attemptPayload.model = model;
        const capabilities = getModelCapabilities(binding.upstreamModel);
        const plan = planChatRequest(capabilities);
        if (!plan) continue;

        const sourceCtx = {
          ...sourceExchangeMeta(source, binding, 'chat-completions', plan.target, model),
          payload: attemptPayload,
        };

        result = await runInterceptors(sourceCtx, chatSourceInterceptorsForProvider(binding), async () => {
          const payload = sourceCtx.payload;

          if (plan.target === 'messages') {
            const targetPayload = await buildMessagesTargetRequest(payload, capabilities);
            const targetResult = source.rememberPerformance(await emitToMessages(sourceTargetInput(source, binding, 'chat-completions', 'messages', model, targetPayload, wantsStream)));
            return targetResult.type === 'events'
              ? {
                  ...targetResult,
                  events: translateMessagesToSourceEvents(targetResult.events),
                }
              : targetResult;
          }

          if (plan.target === 'responses') {
            const targetPayload = buildResponsesTargetRequest(payload);
            const targetResult = source.rememberPerformance(await emitToResponses(sourceTargetInput(source, binding, 'chat-completions', 'responses', model, targetPayload, wantsStream)));
            return targetResult.type === 'events'
              ? {
                  ...targetResult,
                  events: translateResponsesToSourceEvents(targetResult.events),
                }
              : targetResult;
          }

          return source.rememberPerformance(await emitToChatCompletions(sourceTargetInput(source, binding, 'chat-completions', 'chat-completions', model, payload, wantsStream)));
        });
        break;
      }

      result ??= openAiUnsupportedEndpointResult(model, '/chat/completions');
    }

    return await respondChatCompletions(c, result, wantsStream, includeUsageChunk, source);
  } catch (error) {
    return await respondChatCompletions(
      c,
      sourceErrorResult(error, {
        sourceApi: 'chat-completions',
        internalStatus: 502,
        lastPerformance: source.lastPerformance,
      }),
      false,
      includeUsageChunk,
      source,
    );
  }
};
