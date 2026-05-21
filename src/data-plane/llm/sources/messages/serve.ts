import type { Context } from 'hono';

import { messagesSourceInterceptors } from './interceptors/index.ts';
import { planMessagesRequest } from './plan.ts';
import { respondMessages } from './respond.ts';
import { getModelCapabilities } from '../../../providers/capabilities.ts';
import { resolveModelForRequest } from '../../../providers/registry.ts';
import type { ProviderModelRecord } from '../../../providers/types.ts';
import type { MessagesPayload, MessagesStreamEventData } from '../../../shared/protocol/messages.ts';
import { type MessagesInterceptor, runInterceptors } from '../../interceptors.ts';
import type { StreamExecuteResult } from '../../shared/errors/result.ts';
import { emitToChatCompletions } from '../../targets/chat-completions/emit.ts';
import { emitToMessages } from '../../targets/messages/emit.ts';
import { emitToResponses } from '../../targets/responses/emit.ts';
import { translateToSourceEvents as translateChatToSourceEvents } from '../../translate/messages-via-chat-completions/events.ts';
import { buildTargetRequest as buildChatTargetRequest } from '../../translate/messages-via-chat-completions/request.ts';
import { translateToSourceEvents as translateResponsesToSourceEvents } from '../../translate/messages-via-responses/events.ts';
import { buildTargetRequest as buildResponsesTargetRequest } from '../../translate/messages-via-responses/request.ts';
import { createSourceExecutionContext, openAiMissingModelResult, openAiUnsupportedEndpointResult, sourceErrorResult, sourceExchangeMeta, sourceTargetInput } from '../execute.ts';

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

export const serveMessages = async (c: Context): Promise<Response> => {
  const source = createSourceExecutionContext(c);
  try {
    const payload = await c.req.json<MessagesPayload>();
    const rejectedBetaParam = bodyBetaParam(payload);
    if (rejectedBetaParam) return bodyAnthropicBetaResponse(rejectedBetaParam);

    const wantsStream = payload.stream === true;
    source.beginDownstream(wantsStream);
    const anthropicBeta = parseAnthropicBeta(c.req.header('anthropic-beta'));

    const { id: model, model: resolved } = await resolveModelForRequest(payload.model);
    let result: StreamExecuteResult<MessagesStreamEventData> | undefined;

    if (!resolved) {
      result = openAiMissingModelResult(model);
    } else {
      for (const binding of resolved.providers) {
        const attemptPayload = structuredClone(payload);
        attemptPayload.model = model;
        const capabilities = getModelCapabilities(binding.upstreamModel);
        const plan = planMessagesRequest(capabilities);
        if (!plan) continue;

        const sourceCtx = {
          ...sourceExchangeMeta(source, binding, 'messages', plan.target, model),
          payload: attemptPayload,
          anthropicBeta,
        };

        result = await runInterceptors(sourceCtx, messagesSourceInterceptorsForProvider(binding), async () => {
          const payload = sourceCtx.payload;

          if (plan.target === 'messages') {
            return source.rememberPerformance(await emitToMessages(sourceTargetInput(source, binding, 'messages', 'messages', model, payload, wantsStream, { anthropicBeta })));
          }

          if (plan.target === 'responses') {
            const targetPayload = buildResponsesTargetRequest(payload);
            const targetResult = source.rememberPerformance(await emitToResponses(sourceTargetInput(source, binding, 'messages', 'responses', model, targetPayload, wantsStream)));
            return targetResult.type === 'events'
              ? {
                  ...targetResult,
                  events: translateResponsesToSourceEvents(targetResult.events),
                }
              : targetResult;
          }

          const targetPayload = buildChatTargetRequest(payload);
          const targetResult = source.rememberPerformance(await emitToChatCompletions(sourceTargetInput(source, binding, 'messages', 'chat-completions', model, targetPayload, wantsStream)));
          return targetResult.type === 'events'
            ? {
                ...targetResult,
                events: translateChatToSourceEvents(targetResult.events),
              }
            : targetResult;
        });
        break;
      }

      result ??= openAiUnsupportedEndpointResult(model, '/messages');
    }

    return await respondMessages(c, result, wantsStream, source);
  } catch (error) {
    return await respondMessages(
      c,
      sourceErrorResult(error, {
        sourceApi: 'messages',
        internalStatus: 502,
        lastPerformance: source.lastPerformance,
      }),
      false,
      source,
    );
  }
};
