import type { Context } from 'hono';

import { responsesSourceInterceptors } from './interceptors/index.ts';
import { planResponsesRequest } from './plan.ts';
import { respondResponses } from './respond.ts';
import { getModelCapabilities } from '../../../providers/capabilities.ts';
import { resolveModelForRequest } from '../../../providers/registry.ts';
import type { ProviderModelRecord } from '../../../providers/types.ts';
import type { ResponsesPayload } from '../../../shared/protocol/responses.ts';
import { type ResponsesInterceptor, runInterceptors } from '../../interceptors.ts';
import type { StreamExecuteResult } from '../../shared/errors/result.ts';
import type { ResponsesStreamEvent } from '../../shared/protocol/responses.ts';
import { emitToChatCompletions } from '../../targets/chat-completions/emit.ts';
import { emitToMessages } from '../../targets/messages/emit.ts';
import { emitToResponses } from '../../targets/responses/emit.ts';
import { translateToSourceEvents as translateChatCompletionsToSourceEvents } from '../../translate/responses-via-chat-completions/events.ts';
import { buildTargetRequest as buildChatCompletionsTargetRequest } from '../../translate/responses-via-chat-completions/request.ts';
import { translateToSourceEvents } from '../../translate/responses-via-messages/events.ts';
import { buildTargetRequest as buildMessagesTargetRequest } from '../../translate/responses-via-messages/request.ts';
import { createSourceExecutionContext, openAiMissingModelResult, openAiUnsupportedEndpointResult, sourceErrorResult, sourceExchangeMeta, sourceTargetInput } from '../execute.ts';

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

const createTranslatedResponseId = (): string => `resp_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

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

export const serveResponses = async (c: Context): Promise<Response> => {
  const source = createSourceExecutionContext(c);
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
    source.beginDownstream(wantsStream);

    const { id: model, model: resolved } = await resolveModelForRequest(payload.model);
    let result: StreamExecuteResult<ResponsesStreamEvent> | undefined;

    if (!resolved) {
      result = openAiMissingModelResult(model);
    } else {
      for (const binding of resolved.providers) {
        const attemptPayload = structuredClone(payload);
        attemptPayload.model = model;
        const capabilities = getModelCapabilities(binding.upstreamModel);
        const plan = planResponsesRequest(capabilities);
        if (!plan) continue;

        const sourceCtx = {
          ...sourceExchangeMeta(source, binding, 'responses', plan.target, model),
          payload: attemptPayload,
        };

        result = await runInterceptors(sourceCtx, responsesSourceInterceptorsForProvider(binding), async () => {
          const payload = sourceCtx.payload;

          if (plan.target === 'responses') {
            return source.rememberPerformance(await emitToResponses(sourceTargetInput(source, binding, 'responses', 'responses', model, payload, wantsStream)));
          }

          if (plan.target === 'messages') {
            const targetPayload = await buildMessagesTargetRequest(payload, capabilities);
            const targetResult = source.rememberPerformance(await emitToMessages(sourceTargetInput(source, binding, 'responses', 'messages', model, targetPayload, wantsStream)));
            return targetResult.type === 'events'
              ? {
                  ...targetResult,
                  events: translateToSourceEvents(targetResult.events, createTranslatedResponseId(), targetPayload.model),
                }
              : targetResult;
          }

          const targetPayload = buildChatCompletionsTargetRequest(payload);
          const targetResult = source.rememberPerformance(await emitToChatCompletions(sourceTargetInput(source, binding, 'responses', 'chat-completions', model, targetPayload, wantsStream)));
          return targetResult.type === 'events'
            ? {
                ...targetResult,
                events: translateChatCompletionsToSourceEvents(targetResult.events),
              }
            : targetResult;
        });
        break;
      }

      result ??= openAiUnsupportedEndpointResult(model, '/responses');
    }

    return await respondResponses(c, result, wantsStream, source);
  } catch (error) {
    return await respondResponses(
      c,
      sourceErrorResult(error, {
        sourceApi: 'responses',
        internalStatus: 502,
        lastPerformance: source.lastPerformance,
      }),
      false,
      source,
    );
  }
};
