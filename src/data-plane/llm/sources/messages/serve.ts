import type { Context } from 'hono';

import { messagesSourceInterceptors } from './interceptors/index.ts';
import { planMessagesRequest } from './plan.ts';
import { respondMessages } from './respond.ts';
import { getModelCapabilities } from '../../../providers/capabilities.ts';
import { resolveModelForRequest } from '../../../providers/registry.ts';
import type { ProviderModelRecord } from '../../../providers/types.ts';
import type { ChatCompletionsPayload } from '../../../shared/protocol/chat-completions.ts';
import type { MessagesPayload, MessagesStreamEventData } from '../../../shared/protocol/messages.ts';
import type { ResponsesPayload } from '../../../shared/protocol/responses.ts';
import { type PerformanceTelemetryContext } from '../../../shared/telemetry/performance.ts';
import { type LlmTargetApi, type MessagesInterceptor, type MessagesInvocation, runInterceptors } from '../../interceptors.ts';
import type { ExecuteResult } from '../../shared/errors/result.ts';
import type { ProtocolFrame } from '../../shared/stream/types.ts';
import { emitToChatCompletions } from '../../targets/chat-completions/emit.ts';
import { emitToMessages } from '../../targets/messages/emit.ts';
import { emitToResponses } from '../../targets/responses/emit.ts';
import { messagesViaChatCompletionsTranslation } from '../../translate/messages-via-chat-completions/index.ts';
import { messagesViaResponsesTranslation } from '../../translate/messages-via-responses/index.ts';
import { type SourceEmit, viaTranslation } from '../../translate/types.ts';
import { createRequestContext, openAiMissingModelResult, openAiUnsupportedEndpointResult, sourceErrorResult } from '../execute.ts';

export const parseAnthropicBeta = (raw: string | undefined): string[] | undefined => {
  if (!raw) return undefined;
  const values = raw
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0);
  return values.length > 0 ? values : undefined;
};

export const bodyBetaParam = (payload: MessagesPayload): string | undefined => {
  const record = payload as unknown as Record<string, unknown>;
  if (Object.hasOwn(record, 'anthropic_beta')) return 'anthropic_beta';
  if (Object.hasOwn(record, 'betas')) return 'betas';
  return undefined;
};

export const bodyAnthropicBetaResponse = (param: string): Response =>
  Response.json(
    {
      error: {
        message: `${param} in the Messages request body is not supported; send Anthropic beta flags with the anthropic-beta HTTP header.`,
        type: 'invalid_request_error',
        param,
      },
    },
    { status: 400 },
  );

const messagesSourceInterceptorsForProvider = (binding: ProviderModelRecord): readonly MessagesInterceptor[] => [...messagesSourceInterceptors, ...(binding.sourceInterceptors?.messages ?? [])];

const messagesInvocation = <TPayload extends { model: string }>(
  binding: ProviderModelRecord,
  targetApi: LlmTargetApi,
  model: string,
  payload: TPayload,
  anthropicBeta?: readonly string[],
) => ({
  sourceApi: 'messages' as const,
  targetApi,
  model,
  upstream: binding.upstream,
  upstreamModel: binding.upstreamModel,
  provider: binding.provider,
  enabledFixes: binding.enabledFixes,
  ...(binding.targetInterceptors !== undefined ? { targetInterceptors: binding.targetInterceptors } : {}),
  payload,
  ...(anthropicBeta !== undefined ? { anthropicBeta } : {}),
});

export const serveMessages = async (c: Context): Promise<Response> => {
  let lastPerformance: PerformanceTelemetryContext | undefined;
  const rememberPerformance = <T extends { performance?: PerformanceTelemetryContext }>(result: T): T => {
    if (result.performance) lastPerformance = result.performance;
    return result;
  };

  let request = createRequestContext(c, undefined, false);
  let downstreamAbortController: AbortController | undefined;

  try {
    const payload = await c.req.json<MessagesPayload>();
    const rejectedBetaParam = bodyBetaParam(payload);
    if (rejectedBetaParam) return bodyAnthropicBetaResponse(rejectedBetaParam);

    const wantsStream = payload.stream === true;
    downstreamAbortController = wantsStream ? new AbortController() : undefined;
    request = createRequestContext(c, downstreamAbortController?.signal, wantsStream);
    const anthropicBeta = parseAnthropicBeta(c.req.header('anthropic-beta'));

    const { id: model, model: resolved } = await resolveModelForRequest(payload.model);
    let result: ExecuteResult<ProtocolFrame<MessagesStreamEventData>> | undefined;

    if (!resolved) {
      result = openAiMissingModelResult(model);
    } else {
      for (const binding of resolved.providers) {
        const attemptPayload = structuredClone(payload);
        attemptPayload.model = model;
        const capabilities = getModelCapabilities(binding.upstreamModel);
        const plan = planMessagesRequest(capabilities);
        if (!plan) continue;

        const invocation: MessagesInvocation = messagesInvocation(binding, plan.target, model, attemptPayload, anthropicBeta);

        const emits: Record<LlmTargetApi, SourceEmit<MessagesPayload, MessagesStreamEventData>> = {
          messages: async srcPayload => rememberPerformance(await emitToMessages({ ...invocation, payload: srcPayload }, request)),
          responses: viaTranslation(messagesViaResponsesTranslation, async (tgtPayload: ResponsesPayload) =>
            rememberPerformance(await emitToResponses(messagesInvocation(binding, 'responses', model, tgtPayload), request))),
          'chat-completions': viaTranslation(messagesViaChatCompletionsTranslation, async (tgtPayload: ChatCompletionsPayload) =>
            rememberPerformance(await emitToChatCompletions(messagesInvocation(binding, 'chat-completions', model, tgtPayload), request))),
        };

        result = await runInterceptors(invocation, request, messagesSourceInterceptorsForProvider(binding), () =>
          emits[plan.target](invocation.payload, { model, wantsStream, capabilities }));
        break;
      }

      result ??= openAiUnsupportedEndpointResult(model, '/messages');
    }

    return await respondMessages(c, result, wantsStream, request, lastPerformance, downstreamAbortController);
  } catch (error) {
    return await respondMessages(
      c,
      sourceErrorResult(error, {
        sourceApi: 'messages',
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
