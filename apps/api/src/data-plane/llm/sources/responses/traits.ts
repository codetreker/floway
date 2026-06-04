import type { Context } from 'hono';

import { responsesSourceInterceptors } from './interceptors/index.ts';
import { respondResponses } from './respond.ts';
import type { ResponsesSnapshotMode, StatefulResponsesStore } from './stateful-store.ts';
import { type LlmTargetApi, type ResponsesInvocation, runInterceptors } from '../../interceptors.ts';
import { emitToChatCompletions } from '../../targets/chat-completions/emit.ts';
import { emitToMessages } from '../../targets/messages/emit.ts';
import { emitToResponses, emitToResponsesCompact } from '../../targets/responses/emit.ts';
import { createHttpRequestContext } from '../request-context.ts';
import { jsonUpstreamErrorResult, sourceErrorResult, type LlmEndpointPlan, type LlmHttpEndpoint, type LlmServeFailure, type LlmSourceTraits } from '../traits.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ResponsesCompactPayload, ResponsesInputItem, ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ExecuteResult, ProviderModelRecord } from '@floway-dev/provider';
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

// Compact has no `reasoning` field, so only the model swap applies. The
// codex alias rerouting is per-request semantics, not per-endpoint, so we
// honour it here too.
const rewriteResponsesCompactEntryModelAlias = (payload: ResponsesCompactPayload): ResponsesCompactPayload =>
  payload.model === CODEX_AUTO_REVIEW_ALIAS ? { ...payload, model: CODEX_AUTO_REVIEW_TARGET } : payload;

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
const openAiErrorResult = (status: number, message: string, extra?: { param: string; code: string | null }): ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> =>
  jsonUpstreamErrorResult(status, { error: { message, type: 'invalid_request_error', ...extra } });

const renderResponsesFailure = (failure: LlmServeFailure): ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> => {
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
    return sourceErrorResult<ResponsesStreamEvent>(failure.error, { sourceApi: 'responses', internalStatus: 502 });
  }
};

interface SetupResponsesSourceOptions {
  readonly downstreamAbortController?: AbortController;
  readonly statefulResponsesStore?: StatefulResponsesStore;
  readonly storedItemsStore?: boolean | null | undefined;
  readonly snapshotMode?: ResponsesSnapshotMode;
}

export const setupResponsesSource = async (
  c: Context,
  sourcePayload: ResponsesPayload,
  options: SetupResponsesSourceOptions = {},
): Promise<LlmEndpointPlan<string | readonly ResponsesInputItem[], ResponsesStreamEvent> | Response> => {
  const payload = rewriteResponsesEntryModelAlias(sourcePayload);
  const wantsStream = payload.stream === true;
  const downstreamAbortController = options.downstreamAbortController ?? (wantsStream ? new AbortController() : undefined);
  const request = createHttpRequestContext(c, downstreamAbortController?.signal, wantsStream, {
    store: payload.store,
    ...(options.statefulResponsesStore !== undefined ? { statefulResponsesStore: options.statefulResponsesStore } : {}),
  });
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
    store: options.storedItemsStore ?? payload.store,
    statefulResponsesInputItems: currentInputItems,
    responsesSnapshotMode: options.snapshotMode ?? (payload.store !== false ? 'append' : 'none'),
    model: payload.model,
    downstreamAbortController,
    pickTarget: endpoints => endpoints.responses ? 'responses' : endpoints.messages ? 'messages' : endpoints.chatCompletions ? 'chat-completions' : null,
    attempt: async ({ binding, target, model, rewriteItems }) => {
      const attemptPayload = structuredClone(payload);
      attemptPayload.model = model;
      delete attemptPayload.previous_response_id;
      attemptPayload.input = await rewriteItems(attemptPayload.input);
      const invocation: ResponsesInvocation = responsesInvocation(binding, target, model, attemptPayload);
      const emits: Record<LlmTargetApi, SourceEmit<ResponsesPayload, { fallbackMaxOutputTokens?: number }, ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>>> = {
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
};

const responsesGenerate: LlmHttpEndpoint<string | readonly ResponsesInputItem[], ResponsesStreamEvent> = {
  respond: async ({ c, result, runtime }) =>
    await respondResponses(c, result, runtime.wantsStream, runtime.request, runtime.downstreamAbortController),
  prepare: async c => await setupResponsesSource(c, await c.req.json<ResponsesPayload>()),
};

// `/responses/compact` reuses the input stitching of /responses (alias
// rewrite + previous_response_id snapshot expansion) and answers with a
// single non-streaming `response.compaction` envelope. It gates on
// `endpoints.responses` only (no translation) — models without that
// endpoint surface `model-unsupported` → 400.
//
// The retained + compaction items DO commit through the same staging path
// the generate endpoint uses so the returned `id` is a usable
// `previous_response_id` handle for a follow-up `/responses` or
// `/responses/compact` turn (matching the official endpoint, which
// documents `previous_response_id` as accepted on /responses/compact).
//
// `stream` is ignored — the upstream's answer is one blob; the gateway
// always collects it into one JSON body regardless of the client's flag.
const setupResponsesCompactSource = async (
  c: Context,
  sourcePayload: ResponsesCompactPayload,
): Promise<LlmEndpointPlan<string | readonly ResponsesInputItem[], ResponsesStreamEvent> | Response> => {
  const payload = rewriteResponsesCompactEntryModelAlias(sourcePayload);
  const request = createHttpRequestContext(c, undefined, false, { store: payload.store });
  const currentInputItems = responsesInputItemsForStorage(payload.input);
  const previousResponseId = payload.previous_response_id ?? null;
  if (previousResponseId !== null) {
    const snapshot = await request.statefulResponsesStore.loadSnapshot(previousResponseId);
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
    wantsStream: false,
    store: payload.store,
    statefulResponsesInputItems: currentInputItems,
    responsesSnapshotMode: payload.store !== false ? 'replace' : 'none',
    downstreamAbortController: undefined,
    model: payload.model,
    pickTarget: endpoints => endpoints.responses ? 'responses' : null,
    // `target` is always 'responses' here — pickTarget above gates on it —
    // so we destructure it away rather than threading it through.
    attempt: async ({ binding, model, rewriteItems }) => {
      // store is a gateway-only policy and never reaches the wire; the
      // narrow ResponsesCompactPayload already strips create-only fields
      // (tools, temperature, reasoning, ...).
      const { store: _store, model: _model, previous_response_id: _previous, ...callBody } = payload;
      const attemptPayload = { ...callBody, model, input: await rewriteItems(payload.input) };
      const invocation: ResponsesInvocation = responsesInvocation(binding, 'responses', model, attemptPayload);
      const interceptors = [...responsesSourceInterceptors, ...(binding.sourceInterceptors?.responses ?? [])];
      return await runInterceptors(invocation, request, interceptors, () => emitToResponsesCompact(invocation, request));
    },
  };
};

const responsesCompact: LlmHttpEndpoint<string | readonly ResponsesInputItem[], ResponsesStreamEvent> = {
  respond: async ({ c, result, runtime }) => await respondResponses(c, result, false, runtime.request, undefined),
  prepare: async c => await setupResponsesCompactSource(c, await c.req.json<ResponsesCompactPayload>()),
};

export const responsesTraits: LlmSourceTraits<string | readonly ResponsesInputItem[], ResponsesStreamEvent> = {
  renderFailure: renderResponsesFailure,
  endpoints: { generate: responsesGenerate, compact: responsesCompact },
};
