import type { Context } from 'hono';

import { countGeminiTokens } from './count-tokens/serve.ts';
import { geminiSourceInterceptors } from './interceptors/index.ts';
import { planGeminiRequest } from './plan.ts';
import { geminiRpcErrorResponse, respondGemini } from './respond.ts';
import { getModelCapabilities } from '../../../providers/capabilities.ts';
import { resolveModelForRequest } from '../../../providers/registry.ts';
import type { ProviderModelRecord } from '../../../providers/types.ts';
import type { GeminiGenerateContentRequest, GeminiStreamEvent } from '../../../shared/protocol/gemini.ts';
import { type GeminiInterceptor, runInterceptors } from '../../interceptors.ts';
import type { StreamExecuteResult } from '../../shared/errors/result.ts';
import { emitToChatCompletions } from '../../targets/chat-completions/emit.ts';
import { emitToMessages } from '../../targets/messages/emit.ts';
import { emitToResponses } from '../../targets/responses/emit.ts';
import { translateToSourceEvents as translateChatCompletionsToSourceEvents } from '../../translate/gemini-via-chat-completions/events.ts';
import { buildTargetRequest as buildChatCompletionsTargetRequest } from '../../translate/gemini-via-chat-completions/request.ts';
import { translateToSourceEvents as translateMessagesToSourceEvents } from '../../translate/gemini-via-messages/events.ts';
import { buildTargetRequest as buildMessagesTargetRequest } from '../../translate/gemini-via-messages/request.ts';
import { translateToSourceEvents as translateResponsesToSourceEvents } from '../../translate/gemini-via-responses/events.ts';
import { buildTargetRequest as buildResponsesTargetRequest } from '../../translate/gemini-via-responses/request.ts';
import { createSourceExecutionContext, jsonUpstreamErrorResult, sourceErrorResult, sourceExchangeMeta, sourceTargetInput } from '../execute.ts';

const missingGeminiModelResult = (model: string) =>
  jsonUpstreamErrorResult(404, {
    error: {
      code: 404,
      message: `Model ${model} is not available on any configured upstream.`,
      status: 'NOT_FOUND',
    },
  });

const unsupportedGeminiModelResult = (model: string) =>
  jsonUpstreamErrorResult(400, {
    error: {
      code: 400,
      message: `Model ${model} does not support the Gemini generateContent endpoint.`,
      status: 'INVALID_ARGUMENT',
    },
  });

const geminiSourceInterceptorsForProvider = (binding: ProviderModelRecord): readonly GeminiInterceptor[] => [...geminiSourceInterceptors, ...(binding.sourceInterceptors?.gemini ?? [])];

export const serveGemini = async (c: Context, model: string, wantsStream: boolean): Promise<Response> => {
  const source = createSourceExecutionContext(c);
  try {
    const payload = await c.req.json<GeminiGenerateContentRequest>();

    source.beginDownstream(wantsStream);
    const { id: modelId, model: resolved } = await resolveModelForRequest(model);
    let result: StreamExecuteResult<GeminiStreamEvent> | undefined;

    if (!resolved) {
      result = missingGeminiModelResult(modelId);
    } else {
      for (const binding of resolved.providers) {
        const attemptPayload = structuredClone(payload);
        const capabilities = getModelCapabilities(binding.upstreamModel);
        const plan = planGeminiRequest(capabilities);
        if (!plan) continue;

        const sourceCtx = {
          ...sourceExchangeMeta(source, binding, 'gemini', plan.target, modelId),
          payload: attemptPayload,
        };

        result = await runInterceptors(sourceCtx, geminiSourceInterceptorsForProvider(binding), async () => {
          const payload = sourceCtx.payload;

          if (plan.target === 'messages') {
            const targetPayload = buildMessagesTargetRequest(payload, modelId, wantsStream, capabilities);
            const targetResult = source.rememberPerformance(await emitToMessages(sourceTargetInput(source, binding, 'gemini', 'messages', modelId, targetPayload, wantsStream)));
            return targetResult.type === 'events'
              ? {
                  ...targetResult,
                  events: translateMessagesToSourceEvents(targetResult.events),
                }
              : targetResult;
          }

          if (plan.target === 'responses') {
            const targetPayload = buildResponsesTargetRequest(payload, modelId, wantsStream);
            const targetResult = source.rememberPerformance(await emitToResponses(sourceTargetInput(source, binding, 'gemini', 'responses', modelId, targetPayload, wantsStream)));
            return targetResult.type === 'events'
              ? {
                  ...targetResult,
                  events: translateResponsesToSourceEvents(targetResult.events),
                }
              : targetResult;
          }

          const targetPayload = buildChatCompletionsTargetRequest(payload, modelId, wantsStream);
          const targetResult = source.rememberPerformance(await emitToChatCompletions(sourceTargetInput(source, binding, 'gemini', 'chat-completions', modelId, targetPayload, wantsStream)));
          return targetResult.type === 'events'
            ? {
                ...targetResult,
                events: translateChatCompletionsToSourceEvents(targetResult.events),
              }
            : targetResult;
        });
        break;
      }

      result ??= unsupportedGeminiModelResult(modelId);
    }

    return await respondGemini(c, result, wantsStream, source);
  } catch (error) {
    return await respondGemini(
      c,
      sourceErrorResult(error, {
        sourceApi: 'gemini',
        internalStatus: 500,
        lastPerformance: source.lastPerformance,
      }),
      false,
      source,
    );
  }
};

export const serveGeminiPost = async (c: Context): Promise<Response> => {
  const modelAction = c.req.param('modelAction');
  if (!modelAction) {
    return geminiRpcErrorResponse(404, 'Missing Gemini model action.');
  }

  const separator = modelAction.lastIndexOf(':');
  if (separator <= 0 || separator === modelAction.length - 1) {
    return geminiRpcErrorResponse(404, `Unknown Gemini model action: ${modelAction}`);
  }

  const model = modelAction.slice(0, separator);
  const action = modelAction.slice(separator + 1);

  switch (action) {
  case 'generateContent':
    return await serveGemini(c, model, false);
  case 'streamGenerateContent':
    return await serveGemini(c, model, true);
  case 'countTokens':
    return await countGeminiTokens(c, model);
  default:
    return geminiRpcErrorResponse(404, `Unknown Gemini model action: ${action}`);
  }
};
