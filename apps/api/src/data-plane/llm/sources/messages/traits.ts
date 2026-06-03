import { messagesSourceInterceptors } from './interceptors/index.ts';
import { respondMessages } from './respond.ts';
import type { ProviderModelRecord } from '../../../providers/types.ts';
import { type LlmTargetApi, type MessagesInvocation, runInterceptors } from '../../interceptors.ts';
import type { ExecuteResult } from '../../shared/errors/result.ts';
import { emitToChatCompletions } from '../../targets/chat-completions/emit.ts';
import { emitToMessages } from '../../targets/messages/emit.ts';
import { emitToResponses } from '../../targets/responses/emit.ts';
import { createHttpRequestContext } from '../request-context.ts';
import { plainResultFromResponse } from '../respond.ts';
import { type LlmEndpointName, type LlmHttpEndpoint, jsonUpstreamErrorResult, sourceErrorResult, type LlmServeFailure, type LlmSourceTraits } from '../traits.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesMessage, MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import { type SourceEmit, translateMessagesViaChatCompletions, translateMessagesViaResponses, viaTranslation } from '@floway-dev/translate';
import { messagesViaResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

const parseAnthropicBeta = (raw: string | undefined): string[] | undefined => {
  if (!raw) return undefined;
  const values = raw
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0);
  return values.length > 0 ? values : undefined;
};

const bodyBetaParam = (payload: MessagesPayload): string | undefined => {
  const record = payload as unknown as Record<string, unknown>;
  if (Object.hasOwn(record, 'anthropic_beta')) return 'anthropic_beta';
  if (Object.hasOwn(record, 'betas')) return 'betas';
  return undefined;
};

const bodyAnthropicBetaResponse = (param: string): Response =>
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

// `headers` is intentionally passed by reference: target-portable source-side
// Copilot interceptors (compact / interaction-id) mutate the original Messages
// invocation's `headers` bag, and the planner may pick a non-Messages target
// (Responses or Chat Completions). Each translated emit closure rebuilds an
// invocation in the target shape — without sharing the same `headers`
// reference, those source-side mutations would land on the dropped Messages
// invocation and never reach the upstream HTTP call.
//
// Native Messages-only identity rewrites, such as Claude Code's messages-proxy
// header shape, must gate on `targetApi === 'messages'` inside the interceptor
// before writing into this shared bag.
//
// `anthropicBeta` deliberately does NOT cross protocols: it is an inbound
// Messages concept, and the Responses / Chat Completions target emitters do
// not consume it.
const messagesInvocation = <TPayload extends { model: string }>(
  binding: ProviderModelRecord,
  targetApi: LlmTargetApi,
  model: string,
  payload: TPayload,
  anthropicBeta: readonly string[] | undefined,
  headers: Record<string, string>,
) => ({
  sourceApi: 'messages' as const,
  targetApi,
  model,
  upstream: binding.upstream,
  upstreamModel: binding.upstreamModel,
  provider: binding.provider,
  enabledFlags: binding.enabledFlags,
  ...(binding.targetInterceptors !== undefined ? { targetInterceptors: binding.targetInterceptors } : {}),
  payload,
  headers,
  ...(anthropicBeta !== undefined ? { anthropicBeta } : {}),
});

const renderMessagesFailure = (failure: LlmServeFailure, endpoint: LlmEndpointName): ExecuteResult<ProtocolFrame<MessagesStreamEvent>> => {
  if (failure.kind === 'internal') return sourceErrorResult<MessagesStreamEvent>(failure.error, { sourceApi: 'messages', internalStatus: 502 });
  const endpointPath = endpoint === 'countTokens' ? '/messages/count_tokens' : '/messages';
  const [status, type, message]: [number, string, string] = (() => {
    switch (failure.kind) {
    case 'item-not-found': return [400, 'invalid_request_error', `Item with id '${failure.itemId}' not found.`];
    case 'routing-unavailable': return [400, 'invalid_request_error', failure.message];
    case 'model-missing': return [404, 'not_found_error', `Model ${failure.model} is not available on any configured upstream.`];
    case 'model-unsupported': return [400, 'invalid_request_error', `Model ${failure.model} does not support the ${endpointPath} endpoint.`];
    }
  })();
  const body = { type: 'error', error: { type, message } };
  return jsonUpstreamErrorResult(status, body);
};

const messagesGenerate: LlmHttpEndpoint<readonly MessagesMessage[], MessagesStreamEvent> = {
  respond: async ({ c, result, runtime }) =>
    await respondMessages(c, result, runtime.wantsStream, runtime.request, runtime.downstreamAbortController),
  prepare: async c => {
    const payload = await c.req.json<MessagesPayload>();
    const rejectedBetaParam = bodyBetaParam(payload);
    if (rejectedBetaParam) return bodyAnthropicBetaResponse(rejectedBetaParam);
    const wantsStream = payload.stream === true;
    const downstreamAbortController = wantsStream ? new AbortController() : undefined;
    const request = createHttpRequestContext(c, downstreamAbortController?.signal, wantsStream);
    const anthropicBeta = parseAnthropicBeta(c.req.header('anthropic-beta'));
    return {
      request,
      items: payload.messages,
      responsesItemsView: messagesViaResponsesItemsView,
      wantsStream,
      store: undefined,
      model: payload.model,
      downstreamAbortController,
      pickTarget: endpoints => endpoints.messages ? 'messages' : endpoints.responses ? 'responses' : endpoints.chatCompletions ? 'chat-completions' : null,
      attempt: async ({ binding, target, model, rewriteItems }) => {
        const attemptPayload = structuredClone(payload);
        attemptPayload.model = model;
        attemptPayload.messages = await rewriteItems(attemptPayload.messages);
        const sharedHeaders: Record<string, string> = {};
        const invocation: MessagesInvocation = messagesInvocation(binding, target, model, attemptPayload, anthropicBeta, sharedHeaders);
        const emits: Record<LlmTargetApi, SourceEmit<MessagesPayload, { fallbackMaxOutputTokens?: number }, ExecuteResult<ProtocolFrame<MessagesStreamEvent>>>> = {
          messages: async srcPayload => await emitToMessages({ ...invocation, payload: srcPayload }, request),
          responses: viaTranslation(translateMessagesViaResponses, async (tgtPayload: ResponsesPayload) =>
            await emitToResponses(messagesInvocation(binding, 'responses', model, tgtPayload, undefined, sharedHeaders), request)),
          'chat-completions': viaTranslation(translateMessagesViaChatCompletions, async (tgtPayload: ChatCompletionsPayload) =>
            await emitToChatCompletions(messagesInvocation(binding, 'chat-completions', model, tgtPayload, undefined, sharedHeaders), request)),
        };
        const interceptors = [...messagesSourceInterceptors, ...(binding.sourceInterceptors?.messages ?? [])];
        return await runInterceptors(invocation, request, interceptors, () =>
          emits[target](invocation.payload, { model, fallbackMaxOutputTokens: binding.upstreamModel.limits.max_output_tokens }));
      },
    };
  },
};

// count_tokens shares the Messages input and provider walk but produces a
// count_tokens shares the Messages input and provider walk but produces a
// measurement, not a stream: it routes alongside the Messages capability
// (presence of `messages` implies count_tokens), calls the count_tokens
// endpoint through the same count_tokens interceptors, and proxies the
// upstream body back as a plain result.
const messagesCountTokens: LlmHttpEndpoint<readonly MessagesMessage[], MessagesStreamEvent> = {
  respond: async ({ c, result, runtime }) =>
    await respondMessages(c, result, runtime.wantsStream, runtime.request, runtime.downstreamAbortController),
  prepare: async c => {
    const payload = await c.req.json<MessagesPayload>();
    const rejectedBetaParam = bodyBetaParam(payload);
    if (rejectedBetaParam) return bodyAnthropicBetaResponse(rejectedBetaParam);
    const request = createHttpRequestContext(c, undefined, false);
    const anthropicBeta = parseAnthropicBeta(c.req.header('anthropic-beta'));
    return {
      request,
      items: payload.messages,
      responsesItemsView: messagesViaResponsesItemsView,
      wantsStream: false,
      store: undefined,
      model: payload.model,
      downstreamAbortController: undefined,
      pickTarget: endpoints => endpoints.messages ? 'messages' : null,
      attempt: async ({ binding, model, rewriteItems }) => {
        const attemptPayload = structuredClone(payload);
        attemptPayload.model = model;
        attemptPayload.messages = await rewriteItems(attemptPayload.messages);
        // targetApi is 'messages' because count_tokens hits the Messages
        // endpoint family; the same provider count_tokens interceptors run so
        // Copilot's vision/initiator/anthropic-beta header workarounds apply.
        const invocation: MessagesInvocation = messagesInvocation(binding, 'messages', model, attemptPayload, anthropicBeta, {});
        const response = await runInterceptors(invocation, request, invocation.targetInterceptors?.messagesCountTokens ?? [], async () => {
          const { model: _model, ...body } = invocation.payload;
          const { response } = await binding.provider.callMessagesCountTokens(invocation.upstreamModel, body, undefined, invocation.headers, invocation.anthropicBeta);
          return response;
        });
        return await plainResultFromResponse(response);
      },
    };
  },
};

export const messagesTraits: LlmSourceTraits<readonly MessagesMessage[], MessagesStreamEvent> = {
  renderFailure: renderMessagesFailure,
  endpoints: { generate: messagesGenerate, countTokens: messagesCountTokens },
};
