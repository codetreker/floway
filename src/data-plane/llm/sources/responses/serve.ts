import type { Context } from 'hono';

import { responsesSourceInterceptors } from './interceptors/index.ts';
import { planResponsesRequest } from './plan.ts';
import { respondResponses } from './respond.ts';
import { getModelCapabilities } from '../../../providers/capabilities.ts';
import { resolveModelForRequest } from '../../../providers/registry.ts';
import type { ProviderModelRecord } from '../../../providers/types.ts';
import type { ChatCompletionsPayload } from '../../../shared/protocol/chat-completions.ts';
import type { MessagesPayload } from '../../../shared/protocol/messages.ts';
import type { ResponsesPayload } from '../../../shared/protocol/responses.ts';
import { type PerformanceTelemetryContext } from '../../../shared/telemetry/performance.ts';
import { type LlmTargetApi, type ResponsesInterceptor, type ResponsesInvocation, runInterceptors } from '../../interceptors.ts';
import type { ExecuteResult } from '../../shared/errors/result.ts';
import type { ResponsesStreamEvent } from '../../shared/protocol/responses.ts';
import type { ProtocolFrame } from '../../shared/stream/types.ts';
import { emitToChatCompletions } from '../../targets/chat-completions/emit.ts';
import { emitToMessages } from '../../targets/messages/emit.ts';
import { emitToResponses } from '../../targets/responses/emit.ts';
import { responsesViaChatCompletionsTranslation } from '../../translate/responses-via-chat-completions/index.ts';
import { responsesViaMessagesTranslation } from '../../translate/responses-via-messages/index.ts';
import { type SourceEmit, viaTranslation } from '../../translate/types.ts';
import { createRequestContext, openAiMissingModelResult, openAiUnsupportedEndpointResult, sourceErrorResult } from '../execute.ts';

const CODEX_AUTO_REVIEW_ALIAS = 'codex-auto-review';
const CODEX_AUTO_REVIEW_TARGET = 'gpt-5.4';

type UnsupportedStatefulContinuationField = 'previous_response_id' | 'item_reference';

const isItemReferenceInput = (item: unknown): boolean => typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'item_reference';

const unsupportedStatefulContinuationField = (payload: ResponsesPayload): UnsupportedStatefulContinuationField | undefined => {
  if (payload.previous_response_id !== undefined && payload.previous_response_id !== null) {
    return 'previous_response_id';
  }
  if (Array.isArray(payload.input) && payload.input.some(isItemReferenceInput)) {
    return 'item_reference';
  }
  return undefined;
};

const unsupportedStatefulContinuationResponse = (field: UnsupportedStatefulContinuationField): Response =>
  Response.json(
    {
      error: {
        message: `Responses API ${field} is not supported by this gateway. Send the full input instead of using server-side conversation state references.`,
        type: 'invalid_request_error',
        param: field,
      },
    },
    { status: 400 },
  );

const responsesSourceInterceptorsForProvider = (binding: ProviderModelRecord): readonly ResponsesInterceptor[] => [...responsesSourceInterceptors, ...(binding.sourceInterceptors?.responses ?? [])];

const rewriteResponsesEntryModelAlias = (payload: ResponsesPayload): ResponsesPayload => {
  if (payload.model !== CODEX_AUTO_REVIEW_ALIAS) return payload;

  // TODO: Replace this source-entry hardcode with generic model alias support.
  // Codex sends auto-review requests over the Responses wire API, so rewriting
  // here keeps downstream routing, performance telemetry, and usage accounting
  // on the real model name.
  // References:
  // https://github.com/openai/codex/blob/e7bffc5a20e92cbc64d6c16a1b257d0b2e4cd5df/codex-rs/model-provider/src/provider.rs#L73-L96
  // https://github.com/openai/codex/blob/e7bffc5a20e92cbc64d6c16a1b257d0b2e4cd5df/codex-rs/codex-api/src/endpoint/responses.rs#L102-L134
  return {
    ...payload,
    model: CODEX_AUTO_REVIEW_TARGET,
    reasoning: { ...(payload.reasoning ?? {}), effort: 'low' },
  };
};

const responsesInvocation = <TPayload extends { model: string }>(
  binding: ProviderModelRecord,
  targetApi: LlmTargetApi,
  model: string,
  payload: TPayload,
) => ({
  sourceApi: 'responses' as const,
  targetApi,
  model,
  upstream: binding.upstream,
  upstreamModel: binding.upstreamModel,
  provider: binding.provider,
  enabledFixes: binding.enabledFixes,
  ...(binding.targetInterceptors !== undefined ? { targetInterceptors: binding.targetInterceptors } : {}),
  payload,
});

export const serveResponses = async (c: Context): Promise<Response> => {
  let lastPerformance: PerformanceTelemetryContext | undefined;
  const rememberPerformance = <T extends { performance?: PerformanceTelemetryContext }>(result: T): T => {
    if (result.performance) lastPerformance = result.performance;
    return result;
  };

  let request = createRequestContext(c, undefined, false);
  let downstreamAbortController: AbortController | undefined;

  try {
    const payload = rewriteResponsesEntryModelAlias(await c.req.json<ResponsesPayload>());
    // previous_response_id and item_reference require stateful server-side
    // continuation. We cannot reliably preserve that semantic across provider
    // fallback and translated targets, so reject it at the Responses
    // source boundary and make clients resend the full input instead.
    const unsupportedField = unsupportedStatefulContinuationField(payload);
    if (unsupportedField) {
      return unsupportedStatefulContinuationResponse(unsupportedField);
    }
    const wantsStream = payload.stream === true;
    downstreamAbortController = wantsStream ? new AbortController() : undefined;
    request = createRequestContext(c, downstreamAbortController?.signal, wantsStream);

    const { id: model, model: resolved } = await resolveModelForRequest(payload.model);
    let result: ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> | undefined;

    if (!resolved) {
      result = openAiMissingModelResult(model);
    } else {
      for (const binding of resolved.providers) {
        const attemptPayload = structuredClone(payload);
        attemptPayload.model = model;
        const capabilities = getModelCapabilities(binding.upstreamModel);
        const plan = planResponsesRequest(capabilities);
        if (!plan) continue;

        const invocation: ResponsesInvocation = responsesInvocation(binding, plan.target, model, attemptPayload);

        const emits: Record<LlmTargetApi, SourceEmit<ResponsesPayload, ResponsesStreamEvent>> = {
          responses: async srcPayload => rememberPerformance(await emitToResponses({ ...invocation, payload: srcPayload }, request)),
          messages: viaTranslation(responsesViaMessagesTranslation, async (tgtPayload: MessagesPayload) =>
            rememberPerformance(await emitToMessages(responsesInvocation(binding, 'messages', model, tgtPayload), request))),
          'chat-completions': viaTranslation(responsesViaChatCompletionsTranslation, async (tgtPayload: ChatCompletionsPayload) =>
            rememberPerformance(await emitToChatCompletions(responsesInvocation(binding, 'chat-completions', model, tgtPayload), request))),
        };

        result = await runInterceptors(invocation, request, responsesSourceInterceptorsForProvider(binding), () =>
          emits[plan.target](invocation.payload, { model, wantsStream, capabilities }));
        break;
      }

      result ??= openAiUnsupportedEndpointResult(model, '/responses');
    }

    return await respondResponses(c, result, wantsStream, request, lastPerformance, downstreamAbortController);
  } catch (error) {
    return await respondResponses(
      c,
      sourceErrorResult(error, {
        sourceApi: 'responses',
        internalStatus: 502,
        lastPerformance,
      }),
      false,
      request,
      lastPerformance,
      downstreamAbortController,
    );
  }
};
