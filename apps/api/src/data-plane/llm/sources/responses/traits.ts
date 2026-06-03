import { responsesSourceInterceptors } from './interceptors/index.ts';
import { respondResponses } from './respond.ts';
import type { ProviderModelRecord } from '../../../providers/types.ts';
import { type LlmTargetApi, type ResponsesInvocation, runInterceptors } from '../../interceptors.ts';
import type { ExecuteResult } from '../../shared/errors/result.ts';
import { emitToChatCompletions } from '../../targets/chat-completions/emit.ts';
import { emitToMessages } from '../../targets/messages/emit.ts';
import { emitToResponses } from '../../targets/responses/emit.ts';
import { createHttpRequestContext } from '../request-context.ts';
import { jsonUpstreamErrorResult, sourceErrorResult, type LlmHttpEndpoint, type LlmServeFailure, type LlmSourceTraits } from '../traits.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ResponsesInputItem, ResponsesPayload, RawResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { type SourceEmit, translateResponsesViaChatCompletions, translateResponsesViaMessages, viaTranslation } from '@floway-dev/translate';
import { responsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

const CODEX_AUTO_REVIEW_ALIAS = 'codex-auto-review';
const CODEX_AUTO_REVIEW_TARGET = 'gpt-5.4';

// Previous-response pointers are gateway snapshots over stored Responses item
// ids. A pointer miss intentionally matches OpenAI's not-found contract so
// clients that retry with full input can keep using their existing fallback.
// Verbatim payloads cross-verified from real upstream captures:
// - https://github.com/cline/cline/issues/9399
// - https://github.com/microsoft/semantic-kernel/issues/13128
// - https://github.com/router-for-me/CLIProxyAPI/issues/999
// - https://github.com/openai/openai-agents-python/issues/2020
const previousResponseNotFoundResponse = (id: string): Response =>
  Response.json(
    {
      error: {
        message: `Previous response with id '${id}' not found.`,
        type: 'invalid_request_error',
        param: 'previous_response_id',
        code: 'previous_response_not_found',
      },
    },
    { status: 400 },
  );

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

const responsesInputItemsForStorage = (input: ResponsesPayload['input']): ResponsesInputItem[] =>
  typeof input === 'string' ? [{ type: 'message', role: 'user', content: input }] : [...input];

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
  enabledFlags: binding.enabledFlags,
  ...(binding.targetInterceptors !== undefined ? { targetInterceptors: binding.targetInterceptors } : {}),
  payload,
  headers: {} as Record<string, string>,
});

// OpenAI error envelope. `param`/`code` reproduce OpenAI's native fields; a
// stored-item miss must byte-match OpenAI's own "not found" body, which
// stateless clients (codex) compare verbatim.
const openAiErrorResult = (status: number, message: string, extra?: { param: string; code: string | null }): ExecuteResult<ProtocolFrame<RawResponsesStreamEvent>> =>
  jsonUpstreamErrorResult(status, { error: { message, type: 'invalid_request_error', ...extra } });

const renderResponsesFailure = (failure: LlmServeFailure): ExecuteResult<ProtocolFrame<RawResponsesStreamEvent>> => {
  switch (failure.kind) {
  case 'item-not-found':
    return openAiErrorResult(404, `Item with id '${failure.itemId}' not found.`, { param: 'input', code: null });
  case 'routing-unavailable':
    return openAiErrorResult(400, failure.message, { param: 'input', code: 'responses_item_routing_unavailable' });
  case 'model-missing':
    return openAiErrorResult(404, `Model ${failure.model} is not available on any configured upstream.`);
  case 'model-unsupported':
    return openAiErrorResult(400, `Model ${failure.model} does not support the /responses endpoint.`);
  case 'internal':
    return sourceErrorResult<RawResponsesStreamEvent>(failure.error, { sourceApi: 'responses', internalStatus: 502 });
  }
};

const responsesGenerate: LlmHttpEndpoint<string | readonly ResponsesInputItem[], RawResponsesStreamEvent> = {
  respond: async ({ c, result, runtime }) =>
    await respondResponses(c, result, runtime.wantsStream, runtime.request, runtime.downstreamAbortController),
  prepare: async c => {
    const payload = rewriteResponsesEntryModelAlias(await c.req.json<ResponsesPayload>());
    const wantsStream = payload.stream === true;
    const downstreamAbortController = wantsStream ? new AbortController() : undefined;
    const request = createHttpRequestContext(c, downstreamAbortController?.signal, wantsStream, { store: payload.store });
    const currentInputItems = responsesInputItemsForStorage(payload.input);
    const previousResponseId = payload.previous_response_id ?? null;
    const statefulResponsesStore = request.statefulResponsesStore;
    if (previousResponseId !== null) {
      const snapshot = await statefulResponsesStore.loadSnapshot(previousResponseId);
      if (snapshot === null) return previousResponseNotFoundResponse(previousResponseId);
      payload.input = [
        ...snapshot.itemIds.map(id => ({ type: 'item_reference' as const, id })),
        ...currentInputItems,
      ];
    }
    return {
      request,
      items: payload.input,
      responsesItemsView,
      wantsStream,
      store: payload.store,
      statefulResponsesInputItems: currentInputItems,
      commitStatefulResponsesSnapshot: payload.store !== false,
      model: payload.model,
      downstreamAbortController,
      pickTarget: endpoints => endpoints.responses ? 'responses' : endpoints.messages ? 'messages' : endpoints.chatCompletions ? 'chat-completions' : null,
      attempt: async ({ binding, target, model, rewriteItems }) => {
        const attemptPayload = structuredClone(payload);
        attemptPayload.model = model;
        delete attemptPayload.previous_response_id;
        attemptPayload.input = await rewriteItems(attemptPayload.input);
        const invocation: ResponsesInvocation = responsesInvocation(binding, target, model, attemptPayload);
        const emits: Record<LlmTargetApi, SourceEmit<ResponsesPayload, { fallbackMaxOutputTokens?: number }, ExecuteResult<ProtocolFrame<RawResponsesStreamEvent>>>> = {
          responses: async srcPayload => await emitToResponses({ ...invocation, payload: srcPayload }, request),
          messages: viaTranslation(translateResponsesViaMessages, async (tgtPayload: MessagesPayload) =>
            await emitToMessages(responsesInvocation(binding, 'messages', model, tgtPayload), request)),
          'chat-completions': viaTranslation(translateResponsesViaChatCompletions, async (tgtPayload: ChatCompletionsPayload) =>
            await emitToChatCompletions(responsesInvocation(binding, 'chat-completions', model, tgtPayload), request)),
        };
        const interceptors = [...responsesSourceInterceptors, ...(binding.sourceInterceptors?.responses ?? [])];
        return await runInterceptors(invocation, request, interceptors, () =>
          emits[target](invocation.payload, { model, fallbackMaxOutputTokens: binding.upstreamModel.limits.max_output_tokens }));
      },
    };
  },
};

export const responsesTraits: LlmSourceTraits<string | readonly ResponsesInputItem[], RawResponsesStreamEvent> = {
  renderFailure: renderResponsesFailure,
  endpoints: { generate: responsesGenerate },
};
