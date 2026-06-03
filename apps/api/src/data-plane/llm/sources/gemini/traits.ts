import { geminiSourceInterceptors } from './interceptors/index.ts';
import { stripUnsupportedPartFieldsFromPayload } from './interceptors/strip-unsupported-part-fields.ts';
import { stripUnsupportedToolsFromPayload } from './interceptors/strip-unsupported-tools.ts';
import { respondGemini, geminiInternalRpcErrorResponse, geminiRpcErrorPayload, geminiRpcErrorResponse } from './respond.ts';
import type { ProviderModelRecord } from '../../../providers/types.ts';
import { type GeminiInvocation, type LlmTargetApi, type MessagesInvocation, runInterceptors } from '../../interceptors.ts';
import { type ExecuteResult, plainResult } from '../../shared/errors/result.ts';
import { emitToChatCompletions } from '../../targets/chat-completions/emit.ts';
import { emitToMessages } from '../../targets/messages/emit.ts';
import { emitToResponses } from '../../targets/responses/emit.ts';
import { createHttpRequestContext } from '../request-context.ts';
import { plainResultFromResponse } from '../respond.ts';
import { jsonUpstreamErrorResult, sourceErrorResult, type LlmEndpointName, type LlmHttpEndpoint, type LlmServeFailure, type LlmSourceTraits } from '../traits.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiContent, GeminiPayload, GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import { type SourceEmit, translateGeminiViaChatCompletions, translateGeminiViaMessages, translateGeminiViaResponses, viaTranslation } from '@floway-dev/translate';
import { geminiViaResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

const geminiErrorResult = (status: number, message: string) =>
  jsonUpstreamErrorResult(status, geminiRpcErrorPayload(status, message));

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
  enabledFlags: binding.enabledFlags,
  ...(binding.targetInterceptors !== undefined ? { targetInterceptors: binding.targetInterceptors } : {}),
  payload,
  headers: {} as Record<string, string>,
});

const renderGeminiFailure = (failure: LlmServeFailure, endpoint: LlmEndpointName): ExecuteResult<ProtocolFrame<GeminiStreamEvent>> => {
  switch (failure.kind) {
  case 'item-not-found':
    return geminiErrorResult(404, `Item with id '${failure.itemId}' not found.`);
  case 'routing-unavailable':
    return geminiErrorResult(400, failure.message);
  case 'model-missing':
    return geminiErrorResult(404, `Model ${failure.model} is not available on any configured upstream.`);
  case 'model-unsupported':
    return geminiErrorResult(400, `Model ${failure.model} does not support ${endpoint === 'countTokens' ? 'countTokens' : 'the Gemini generateContent endpoint'}.`);
  case 'internal':
    return sourceErrorResult<GeminiStreamEvent>(failure.error, { sourceApi: 'gemini', internalStatus: 500 });
  }
};

// The Gemini wire API encodes both the model and the action in one path
// segment, e.g. `models/gemini-2.5-pro:streamGenerateContent`. The route
// dispatches `:countTokens` to the count endpoint; this splits the segment so
// each endpoint reads the model off the path.
const parseGeminiModelAction = (modelAction: string | undefined): { model: string; action: string } | Response => {
  if (!modelAction) return geminiRpcErrorResponse(404, 'Missing Gemini model action.');
  const separator = modelAction.lastIndexOf(':');
  if (separator <= 0 || separator === modelAction.length - 1) return geminiRpcErrorResponse(404, `Unknown Gemini model action: ${modelAction}`);
  return { model: modelAction.slice(0, separator).replace(/^models\//, ''), action: modelAction.slice(separator + 1) };
};

const geminiGenerate: LlmHttpEndpoint<readonly GeminiContent[], GeminiStreamEvent> = {
  respond: async ({ c, result, runtime }) =>
    await respondGemini(c, result, runtime.wantsStream, runtime.request, runtime.downstreamAbortController),
  prepare: async c => {
    const parsed = parseGeminiModelAction(c.req.param('modelAction'));
    if (parsed instanceof Response) return parsed;
    const { model, action } = parsed;
    if (action !== 'generateContent' && action !== 'streamGenerateContent') {
      return geminiRpcErrorResponse(404, `Unknown Gemini model action: ${action}`);
    }
    const wantsStream = action === 'streamGenerateContent';

    const downstreamAbortController = wantsStream ? new AbortController() : undefined;
    const request = createHttpRequestContext(c, downstreamAbortController?.signal, wantsStream);
    const payload = await c.req.json<GeminiPayload>();
    return {
      request,
      items: payload.contents ?? [],
      responsesItemsView: geminiViaResponsesItemsView,
      wantsStream,
      store: undefined,
      model,
      downstreamAbortController,
      // Gemini has no native upstream target in the provider API; prefer Chat
      // Completions, then Messages, then Responses.
      pickTarget: endpoints => endpoints.chatCompletions ? 'chat-completions' : endpoints.messages ? 'messages' : endpoints.responses ? 'responses' : null,
      attempt: async ({ binding, target, model: resolvedModelId, rewriteItems }) => {
        const attemptPayload = structuredClone(payload);
        if (attemptPayload.contents !== undefined) attemptPayload.contents = await rewriteItems(attemptPayload.contents);
        // Gemini source payload has no `model` field on the request body; the
        // invocation carries the resolved id for telemetry/dispatch use.
        const invocation: GeminiInvocation = geminiInvocation(binding, target, resolvedModelId, attemptPayload);
        const emits: Record<LlmTargetApi, SourceEmit<GeminiPayload, { fallbackMaxOutputTokens?: number }, ExecuteResult<ProtocolFrame<GeminiStreamEvent>>>> = {
          messages: viaTranslation(translateGeminiViaMessages, async (tgtPayload: MessagesPayload) =>
            await emitToMessages(geminiInvocation(binding, 'messages', resolvedModelId, tgtPayload), request)),
          responses: viaTranslation(translateGeminiViaResponses, async (tgtPayload: ResponsesPayload) =>
            await emitToResponses(geminiInvocation(binding, 'responses', resolvedModelId, tgtPayload), request)),
          'chat-completions': viaTranslation(translateGeminiViaChatCompletions, async (tgtPayload: ChatCompletionsPayload) =>
            await emitToChatCompletions(geminiInvocation(binding, 'chat-completions', resolvedModelId, tgtPayload), request)),
        };
        const interceptors = [...geminiSourceInterceptors, ...(binding.sourceInterceptors?.gemini ?? [])];
        return await runInterceptors(invocation, request, interceptors, () =>
          emits[target](invocation.payload, { model: resolvedModelId, fallbackMaxOutputTokens: binding.upstreamModel.limits.max_output_tokens }));
      },
    };
  },
};

const geminiCountTokens: LlmHttpEndpoint<readonly GeminiContent[], GeminiStreamEvent> = {
  respond: async ({ c, result, runtime }) =>
    await respondGemini(c, result, runtime.wantsStream, runtime.request, runtime.downstreamAbortController),
  prepare: async c => {
    const parsed = parseGeminiModelAction(c.req.param('modelAction'));
    if (parsed instanceof Response) return parsed;
    const request = createHttpRequestContext(c, undefined, false);
    const body = await c.req.json<{ contents?: GeminiContent[]; generateContentRequest?: GeminiPayload }>();
    const generateContentRequest = body.generateContentRequest ?? { contents: body.contents };
    return {
      request,
      items: generateContentRequest.contents ?? [],
      responsesItemsView: geminiViaResponsesItemsView,
      wantsStream: false,
      store: undefined,
      model: parsed.model,
      downstreamAbortController: undefined,
      pickTarget: endpoints => endpoints.messages ? 'messages' : null,
      attempt: async ({ binding, model: resolvedModelId, rewriteItems }) => {
        const countRequest = structuredClone(generateContentRequest);
        if (countRequest.contents !== undefined) countRequest.contents = await rewriteItems(countRequest.contents);
        // Apply inline the payload normalizations the generate path runs via
        // source interceptors, which count_tokens cannot.
        stripUnsupportedPartFieldsFromPayload(countRequest);
        stripUnsupportedToolsFromPayload(countRequest);
        delete countRequest.safetySettings;
        // The trip always emits `stream: true`; count_tokens is non-streaming,
        // so strip it before sending. The events translator never runs.
        const { target } = await translateGeminiViaMessages(countRequest, { model: resolvedModelId, fallbackMaxOutputTokens: binding.upstreamModel.limits.max_output_tokens });
        const { stream: _stream, ...countPayload } = target;
        const invocation: MessagesInvocation = geminiInvocation(binding, 'messages', resolvedModelId, countPayload);
        const response = await runInterceptors(invocation, request, invocation.targetInterceptors?.messagesCountTokens ?? [], async () => {
          const { model: _model, ...callBody } = invocation.payload;
          const result = await invocation.provider.callMessagesCountTokens(invocation.upstreamModel, callBody, undefined, invocation.headers, invocation.anthropicBeta);
          return result.response;
        });
        if (!response.ok) {
          const text = await response.text();
          return await plainResultFromResponse(geminiRpcErrorResponse(response.status, text || 'Upstream token counting request failed.'));
        }
        const upstreamCount = await response.json();
        const upstreamTokenCounts = upstreamCount && typeof upstreamCount === 'object'
          ? upstreamCount as { input_tokens?: unknown; total_tokens?: unknown }
          : {};
        const totalTokens = typeof upstreamTokenCounts.input_tokens === 'number'
          ? upstreamTokenCounts.input_tokens
          : typeof upstreamTokenCounts.total_tokens === 'number'
            ? upstreamTokenCounts.total_tokens
            : null;
        if (totalTokens === null) return await plainResultFromResponse(geminiInternalRpcErrorResponse(502, new Error('Invalid upstream token counting response.')));
        return plainResult(200, new Headers({ 'content-type': 'application/json' }), new TextEncoder().encode(JSON.stringify({ totalTokens })));
      },
    };
  },
};

export const geminiTraits: LlmSourceTraits<readonly GeminiContent[], GeminiStreamEvent> = {
  renderFailure: renderGeminiFailure,
  endpoints: { generate: geminiGenerate, countTokens: geminiCountTokens },
};
