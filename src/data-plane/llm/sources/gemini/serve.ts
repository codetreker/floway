import type { Context } from 'hono';

import { countGeminiTokens } from './count-tokens/serve.ts';
import { geminiSourceInterceptors } from './interceptors/index.ts';
import { planGeminiRequest } from './plan.ts';
import { geminiRpcErrorResponse, respondGemini } from './respond.ts';
import { getModelCapabilities } from '../../../providers/capabilities.ts';
import { resolveModelForRequest } from '../../../providers/registry.ts';
import type { ProviderModelRecord } from '../../../providers/types.ts';
import type { ChatCompletionsPayload } from '../../../shared/protocol/chat-completions.ts';
import type { GeminiGenerateContentRequest, GeminiStreamEvent } from '../../../shared/protocol/gemini.ts';
import type { MessagesPayload } from '../../../shared/protocol/messages.ts';
import type { ResponsesPayload } from '../../../shared/protocol/responses.ts';
import { type PerformanceTelemetryContext } from '../../../shared/telemetry/performance.ts';
import { type GeminiInterceptor, type GeminiInvocation, type LlmTargetApi, runInterceptors } from '../../interceptors.ts';
import type { ExecuteResult } from '../../shared/errors/result.ts';
import type { ProtocolFrame } from '../../shared/stream/types.ts';
import { emitToChatCompletions } from '../../targets/chat-completions/emit.ts';
import { emitToMessages } from '../../targets/messages/emit.ts';
import { emitToResponses } from '../../targets/responses/emit.ts';
import { geminiViaChatCompletionsTranslation } from '../../translate/gemini-via-chat-completions/index.ts';
import { geminiViaMessagesTranslation } from '../../translate/gemini-via-messages/index.ts';
import { geminiViaResponsesTranslation } from '../../translate/gemini-via-responses/index.ts';
import { type SourceEmit, viaTranslation } from '../../translate/types.ts';
import { createRequestContext, jsonUpstreamErrorResult, sourceErrorResult } from '../execute.ts';

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

const geminiInvocation = <TPayload>(
  binding: ProviderModelRecord,
  targetApi: LlmTargetApi,
  model: string,
  payload: TPayload,
) => ({
  sourceApi: 'gemini' as const,
  targetApi,
  model,
  upstream: binding.upstream,
  upstreamModel: binding.upstreamModel,
  provider: binding.provider,
  enabledFixes: binding.enabledFixes,
  ...(binding.targetInterceptors !== undefined ? { targetInterceptors: binding.targetInterceptors } : {}),
  payload,
});

export const serveGemini = async (c: Context, model: string, wantsStream: boolean): Promise<Response> => {
  let lastPerformance: PerformanceTelemetryContext | undefined;
  const rememberPerformance = <T extends { performance?: PerformanceTelemetryContext }>(result: T): T => {
    if (result.performance) lastPerformance = result.performance;
    return result;
  };

  const downstreamAbortController = wantsStream ? new AbortController() : undefined;
  const request = createRequestContext(c, downstreamAbortController?.signal, wantsStream);

  try {
    const payload = await c.req.json<GeminiGenerateContentRequest>();

    const { id: modelId, model: resolved } = await resolveModelForRequest(model);
    let result: ExecuteResult<ProtocolFrame<GeminiStreamEvent>> | undefined;

    if (!resolved) {
      result = missingGeminiModelResult(modelId);
    } else {
      for (const binding of resolved.providers) {
        const attemptPayload = structuredClone(payload);
        const capabilities = getModelCapabilities(binding.upstreamModel);
        const plan = planGeminiRequest(capabilities);
        if (!plan) continue;

        // Gemini source payload has no `model` field on the request body; the
        // invocation carries the resolved id for telemetry/dispatch use.
        const invocation: GeminiInvocation = geminiInvocation(binding, plan.target, modelId, attemptPayload);

        const emits: Record<LlmTargetApi, SourceEmit<GeminiGenerateContentRequest, GeminiStreamEvent>> = {
          messages: viaTranslation(geminiViaMessagesTranslation, async (tgtPayload: MessagesPayload) =>
            rememberPerformance(await emitToMessages(geminiInvocation(binding, 'messages', modelId, tgtPayload), request))),
          responses: viaTranslation(geminiViaResponsesTranslation, async (tgtPayload: ResponsesPayload) =>
            rememberPerformance(await emitToResponses(geminiInvocation(binding, 'responses', modelId, tgtPayload), request))),
          'chat-completions': viaTranslation(geminiViaChatCompletionsTranslation, async (tgtPayload: ChatCompletionsPayload) =>
            rememberPerformance(await emitToChatCompletions(geminiInvocation(binding, 'chat-completions', modelId, tgtPayload), request))),
        };

        result = await runInterceptors(invocation, request, geminiSourceInterceptorsForProvider(binding), () =>
          emits[plan.target](invocation.payload, { model: modelId, wantsStream, capabilities }));
        break;
      }

      result ??= unsupportedGeminiModelResult(modelId);
    }

    return await respondGemini(c, result, wantsStream, request, lastPerformance, downstreamAbortController);
  } catch (error) {
    return await respondGemini(
      c,
      sourceErrorResult(error, {
        sourceApi: 'gemini',
        internalStatus: 500,
        lastPerformance,
      }),
      false,
      request,
      lastPerformance,
      downstreamAbortController,
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
