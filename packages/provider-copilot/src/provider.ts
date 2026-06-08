import { assertCopilotUpstreamRecord } from './config.ts';
import { fetchCopilotModels } from './fetch-models.ts';
import { copilotFetchChatCompletions, copilotFetchEmbeddings, copilotFetchMessages, copilotFetchMessagesCountTokens, copilotFetchResponses } from './fetch.ts';
import { COPILOT_CHATCOMPLETIONS_BOUNDARY } from './interceptors/chat-completions/index.ts';
import type { ChatCompletionsBoundaryCtx } from './interceptors/chat-completions/types.ts';
import { COPILOT_MESSAGES_BOUNDARY, COPILOT_MESSAGES_COUNT_TOKENS_BOUNDARY } from './interceptors/messages/index.ts';
import type { MessagesBoundaryCtx, MessagesCountTokensBoundaryCtx } from './interceptors/messages/types.ts';
import { COPILOT_RESPONSES_BOUNDARY, COPILOT_RESPONSES_COMPACT_BOUNDARY } from './interceptors/responses/index.ts';
import type { ResponsesBoundaryCtx } from './interceptors/responses/types.ts';
import { emptyLedger, mergeLedger, projectLedger, type CopilotLedger } from './ledger.ts';
import { mergeClaudeVariants } from './merge-claude-variants.ts';
import { copilotPublicModelId, copilotRequestedModelAliasTarget } from './model-name.ts';
import { hasContext1mBeta, type ModelSelectionHints, resolveCopilotRawModel } from './model-selection.ts';
import { pricingForCopilotModelKey, pricingForCopilotPublicModelId } from './pricing.ts';
import type { CopilotRawModel } from './types.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import { parseChatCompletionsStream, type ChatCompletionsPayload, type ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { type ModelEndpointKey, type ModelEndpoints, type ProtocolFrame, kindForEndpoints } from '@floway-dev/protocols/common';
import { parseMessagesStream, type MessagesPayload, type MessagesStreamEvent } from '@floway-dev/protocols/messages';
import { parseResponsesStream, type ResponsesInputItem, type ResponsesPayload, type ResponsesResult, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { COMPACTION_TRIGGER, compactionResponse, eventResult, inProcessMemo, readModelsStore, readUpstreamError, streamingProviderCall, upstreamErrorToResponse, writeModelsStore, defaultsForProvider, resolveEffectiveFlags, type ExecuteResult, type ModelProvider, type ModelProviderInstance, type ProviderCallResult, type ProviderCompactionResult, type ProviderStreamResult, type TelemetryModelIdentity, type UpstreamFetchOptions, type UpstreamModel, type UpstreamRecord } from '@floway-dev/provider';

interface CopilotProviderData {
  rawModels: CopilotRawModel[];
}

const SOFT_MS = 10 * 60 * 1000;
const L1_TTL_MS = 120_000;

// Project Copilot's raw `/models` shape into the slim provider-neutral fields
// shared by every provider. kind/endpoints/providerData/enabledFlags are added
// by the caller because they depend on Copilot's endpoint knowledge and the
// upstream-level flag layer.
const copilotInternalModel = (model: CopilotRawModel): Omit<UpstreamModel, 'kind' | 'endpoints' | 'providerData' | 'enabledFlags'> => {
  const limits: UpstreamModel['limits'] = {};
  if (model.capabilities?.limits?.max_output_tokens !== undefined) limits.max_output_tokens = model.capabilities.limits.max_output_tokens;
  if (model.capabilities?.limits?.max_context_window_tokens !== undefined) limits.max_context_window_tokens = model.capabilities.limits.max_context_window_tokens;
  if (model.capabilities?.limits?.max_prompt_tokens !== undefined) limits.max_prompt_tokens = model.capabilities.limits.max_prompt_tokens;

  const internal: Omit<UpstreamModel, 'kind' | 'endpoints' | 'providerData' | 'enabledFlags'> = {
    id: model.id,
    limits,
  };
  if (model.owned_by !== undefined) internal.owned_by = model.owned_by;
  if (model.created !== undefined) internal.created = model.created;
  const displayName = model.display_name ?? model.name;
  if (displayName !== undefined) internal.display_name = displayName;
  return internal;
};

// Copilot's `/models` reports each model's served endpoints as public paths; map
// one onto our structured endpoint key. Both `/x` and `/v1/x` spellings appear.
// Copilot is the only upstream whose catalog speaks paths — operator config and
// our own constants are structured — so this lives here, not in a shared helper.
const copilotPathToModelEndpoint = (path: string): ModelEndpointKey | undefined => {
  switch (path) {
  case '/chat/completions':
  case '/v1/chat/completions':
    return 'chatCompletions';
  case '/responses':
  case '/v1/responses':
    return 'responses';
  case '/v1/messages':
  case '/messages':
    return 'messages';
  case '/embeddings':
  case '/v1/embeddings':
    return 'embeddings';
  case '/images/generations':
  case '/v1/images/generations':
    return 'imagesGenerations';
  case '/images/edits':
  case '/v1/images/edits':
    return 'imagesEdits';
  default:
    return undefined;
  }
};

const rawModelSupportsEndpoint = (model: CopilotRawModel, endpoint: ModelEndpointKey): boolean => {
  if ((model.supported_endpoints ?? []).some(path => copilotPathToModelEndpoint(path) === endpoint)) return true;
  // Copilot's Anthropic-family entries have historically under-reported their
  // native Messages path. Treating claude-* as Messages-capable is a
  // Copilot-provider workaround only; custom providers must declare their own
  // supported endpoints.
  if (endpoint === 'messages' && model.id.startsWith('claude-')) return true;
  if (endpoint === 'chatCompletions') {
    return model.supported_endpoints === undefined && model.capabilities?.type === 'chat';
  }
  if (endpoint === 'embeddings') return model.supported_endpoints === undefined && model.capabilities?.type === 'embeddings';
  return false;
};

const copilotModelEndpoints = (publicModel: CopilotRawModel, rawModels: readonly CopilotRawModel[]): ModelEndpoints => {
  if (rawModels.some(model => rawModelSupportsEndpoint(model, 'responses'))) {
    return { responses: {} };
  }

  if (publicModel.id.startsWith('claude-') || rawModels.some(model => rawModelSupportsEndpoint(model, 'messages'))) {
    return { messages: {} };
  }

  if (rawModels.some(model => rawModelSupportsEndpoint(model, 'chatCompletions'))) {
    return { chatCompletions: {} };
  }

  return rawModels.some(model => rawModelSupportsEndpoint(model, 'embeddings')) ? { embeddings: {} } : {};
};

const chatReasoningEffort = (body: Omit<ChatCompletionsPayload, 'model'>): string | undefined => (body.reasoning_effort && body.reasoning_effort !== 'none' ? body.reasoning_effort : undefined);

const messagesReasoningEffort = (body: Omit<MessagesPayload, 'model'>): string | undefined => body.output_config?.effort;

const responsesReasoningEffort = (body: Omit<ResponsesPayload, 'model'>): string | undefined => (body.reasoning?.effort && body.reasoning.effort !== 'none' ? body.reasoning.effort : undefined);

const rawModelFor = (model: UpstreamModel, endpoint: ModelEndpointKey, hints: ModelSelectionHints = {}): CopilotRawModel => {
  // Copilot exposes one canonical public Claude model id per family. Raw
  // variant selection is derived from request fields such as reasoning effort
  // and anthropic-beta, not from the client's original model alias string.
  const rawModels = (model.providerData as CopilotProviderData).rawModels.filter(rawModel => rawModelSupportsEndpoint(rawModel, endpoint));
  if (rawModels.length === 0) {
    throw new Error(`Copilot provider exposed ${endpoint} for ${model.id}, but no raw variant supports that endpoint`);
  }
  return resolveCopilotRawModel({ object: 'list', data: rawModels }, model.id, hints) ?? rawModels[0];
};

// The Messages and count_tokens call paths receive the UNFILTERED
// anthropic-beta as a typed parameter so variant selection (e.g.
// context-1m-2025-08-07 -> the claude-*-1m-internal variant) sees the
// caller's full intent. The wire `anthropic-beta` header that ultimately
// reaches the upstream is the filtered subset written by
// withAnthropicBetaHeaderFiltered into `invocation.headers`; that header is
// passed through unchanged by the `call` helper below.
const copilotEmbeddingsBody = (body: Record<string, unknown>): Record<string, unknown> => {
  if (typeof body.input !== 'string') return body;

  // OpenAI-compatible clients may send scalar string input, but Copilot's
  // upstream /embeddings endpoint currently returns 400 unless text input is
  // wrapped as an array. Keep this workaround at the Copilot provider boundary
  // so custom OpenAI-compatible upstreams receive the caller's body unchanged.
  // References:
  // https://platform.openai.com/docs/api-reference/embeddings/create
  // https://github.com/ericc-ch/copilot-api/blob/0ea08febdd7e3e055b03dd298bf57e669500b5c1/src/services/copilot/create-embeddings.ts#L19-L21
  // https://github.com/BerriAI/litellm/blob/c8fb77f119ad69a80f5fde088efd3a1aa77f458b/litellm/proxy/proxy_server.py#L7826-L7839
  return { ...body, input: [body.input] };
};

const finalizeCopilotModels = (rawModels: CopilotRawModel[], enabledFlags: ReadonlySet<string>): UpstreamModel[] => {
  const merged = mergeClaudeVariants({ object: 'list', data: rawModels });
  const groups = new Map<string, CopilotRawModel[]>();
  for (const rawModel of rawModels) {
    const id = copilotPublicModelId(rawModel.id);
    groups.set(id, [...(groups.get(id) ?? []), rawModel]);
  }

  const models: UpstreamModel[] = [];
  for (const mergedModel of merged.data) {
    const variants = groups.get(mergedModel.id) ?? [mergedModel];
    const endpoints = copilotModelEndpoints(mergedModel, variants);
    const cost = pricingForCopilotPublicModelId(mergedModel.id);
    models.push({
      ...copilotInternalModel(mergedModel),
      kind: kindForEndpoints(endpoints),
      endpoints,
      providerData: { rawModels: variants } satisfies CopilotProviderData,
      ...(cost ? { cost } : {}),
      enabledFlags,
    });
  }
  return models;
};

export const createCopilotProvider = async (record: UpstreamRecord): Promise<ModelProviderInstance> => {
  const copilot = assertCopilotUpstreamRecord(record);
  const upstreamConfig = { githubToken: copilot.config.githubToken, accountType: copilot.config.accountType };
  // Computed once: only the upstream layer applies for this provider kind
  // (no per-model override layer). Azure recomputes per deployment.
  const upstreamFlags = resolveEffectiveFlags(defaultsForProvider('copilot'), [copilot.flagOverrides]);

  const call = async (
    transport: (config: typeof upstreamConfig, init: RequestInit, options?: UpstreamFetchOptions) => Promise<Response>,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    rawModel: CopilotRawModel,
    headers: Record<string, string> | undefined,
  ): Promise<ProviderCallResult> => {
    const response = await transport(
      upstreamConfig,
      {
        method: 'POST',
        body: JSON.stringify({ ...body, model: rawModel.id }),
        signal,
      },
      headers && Object.keys(headers).length > 0 ? { extraHeaders: headers } : undefined,
    );
    return { response, modelKey: rawModel.id };
  };

  const callStreaming = <TEvent>(
    transport: (config: typeof upstreamConfig, init: RequestInit, options?: UpstreamFetchOptions) => Promise<Response>,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    rawModel: CopilotRawModel,
    headers: Record<string, string> | undefined,
    parser: Parameters<typeof streamingProviderCall<TEvent>>[1],
  ) =>
    streamingProviderCall(
      transport(
        upstreamConfig,
        {
          method: 'POST',
          body: JSON.stringify({ ...body, stream: true, model: rawModel.id }),
          signal,
        },
        headers && Object.keys(headers).length > 0 ? { extraHeaders: headers } : undefined,
      ),
      parser,
      rawModel.id,
      signal,
    );

  // The boundary chain expects ExecuteResult shape so post-`run()` inspectors
  // (e.g. rewriteContextWindowError) can pattern-match on `result.type`. The
  // gateway later rebuilds the real telemetry identity with pricing — the
  // placeholder here only has to satisfy the EventResult contract while the
  // chain runs inside the provider boundary.
  const placeholderIdentity = (modelKey: string): TelemetryModelIdentity => ({
    model: modelKey,
    upstream: copilot.id,
    modelKey,
    cost: pricingForCopilotModelKey(modelKey),
  });

  // Materialize an upstream error body up-front so any interceptor that
  // inspects `result.body` (e.g. rewriteContextWindowError) sees the bytes.
  // Success flows through as the events iterable; the placeholder identity
  // is replaced by the gateway with the candidate-aware identity downstream.
  const liftStream = async <TEvent>(
    streamPromise: Promise<ProviderStreamResult<TEvent>>,
  ): Promise<ExecuteResult<ProtocolFrame<TEvent>>> => {
    const stream = await streamPromise;
    if (stream.ok) return eventResult(stream.events as AsyncIterable<ProtocolFrame<TEvent>>, placeholderIdentity(stream.modelKey));
    return await readUpstreamError(stream.response);
  };

  // Lowering rebuilds a ProviderStreamResult so the gateway boundary continues
  // to relay status/headers/body verbatim on errors and forward the typed
  // event stream on success. `internal-error` is not a shape any Copilot
  // boundary interceptor produces today; an explicit throw makes a future
  // regression noisy instead of silently dropping the result.
  const lowerToStream = <TEvent>(
    result: ExecuteResult<ProtocolFrame<TEvent>>,
    modelKey: string,
  ): ProviderStreamResult<TEvent> => {
    if (result.type === 'events') {
      return { ok: true, events: result.events as AsyncIterable<ProtocolFrame<TEvent>>, modelKey };
    }
    if (result.type === 'upstream-error') {
      return { ok: false, response: upstreamErrorToResponse(result), modelKey };
    }
    throw new Error(`Copilot boundary chain produced unexpected ExecuteResult shape '${result.type}'`);
  };

  const messagesRawModel = (model: UpstreamModel, body: Omit<MessagesPayload, 'model'>, anthropicBeta: readonly string[] | undefined) =>
    // Both the native Messages call and count_tokens select the same raw
    // `messages` variant; they differ only in the upstream endpoint path.
    rawModelFor(model, 'messages', {
      context1m: hasContext1mBeta(anthropicBeta),
      reasoningEffort: messagesReasoningEffort(body),
    });

  const provider: ModelProvider = {
    getProvidedModels: () =>
      inProcessMemo(copilot.id, L1_TTL_MS, async () => {
        const ledger = (await readModelsStore<CopilotLedger>(copilot.id)) ?? emptyLedger();
        const now = Date.now();
        const initial = projectLedger(ledger, now);
        if (now - ledger.fetchedAt < SOFT_MS && initial.length > 0) {
          return finalizeCopilotModels(initial, upstreamFlags);
        }
        try {
          const response = await fetchCopilotModels(upstreamConfig);
          const merged = mergeLedger(ledger, response, now);
          await writeModelsStore<CopilotLedger>(copilot.id, merged);
          return finalizeCopilotModels(projectLedger(merged, now), upstreamFlags);
        } catch (err) {
          if (initial.length > 0) return finalizeCopilotModels(initial, upstreamFlags);
          throw err;
        }
      }),
    getPricingForModelKey: pricingForCopilotModelKey,
    callChatCompletions: async (model, body, signal, headers) => {
      const rawModel = rawModelFor(model, 'chatCompletions', { reasoningEffort: chatReasoningEffort(body) });
      const ctx: ChatCompletionsBoundaryCtx = {
        payload: { ...body, model: model.id },
        headers: { ...(headers ?? {}) },
        model,
      };
      const result = await runInterceptors<ChatCompletionsBoundaryCtx, object, ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>>(
        ctx, {}, COPILOT_CHATCOMPLETIONS_BOUNDARY, async () => {
          const { model: _ignored, ...wireBody } = ctx.payload;
          return await liftStream(callStreaming(copilotFetchChatCompletions, wireBody, signal, rawModel, ctx.headers, parseChatCompletionsStream));
        },
      );
      return lowerToStream(result, rawModel.id);
    },
    callResponses: async (model, body, signal, headers) => {
      const rawModel = rawModelFor(model, 'responses', { reasoningEffort: responsesReasoningEffort(body) });
      const ctx: ResponsesBoundaryCtx = {
        payload: { ...body, model: model.id },
        headers: { ...(headers ?? {}) },
        model,
      };
      const result = await runInterceptors<ResponsesBoundaryCtx, object, ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>>(
        ctx, {}, COPILOT_RESPONSES_BOUNDARY, async () => {
          const { model: _ignored, ...wireBody } = ctx.payload;
          return await liftStream(callStreaming(copilotFetchResponses, wireBody, signal, rawModel, ctx.headers, parseResponsesStream));
        },
      );
      return lowerToStream(result, rawModel.id);
    },
    callResponsesCompact: async (model, body, signal, headers) => {
      const rawModel = rawModelFor(model, 'responses', { reasoningEffort: responsesReasoningEffort(body) });
      const ctx: ResponsesBoundaryCtx = {
        payload: { ...body, model: model.id },
        headers: { ...(headers ?? {}) },
        model,
      };
      return await runInterceptors<ResponsesBoundaryCtx, object, ProviderCompactionResult>(
        ctx, {}, COPILOT_RESPONSES_COMPACT_BOUNDARY, async () => {
          // Compaction is non-streaming — a single encrypted blob, not a token
          // stream — so we drive `/responses` with `stream:false` (bypassing
          // the SSE-forcing callStreaming helper) and reshape the response
          // into the canonical `response.compaction` envelope. Build the wire
          // body from the post-interceptor `ctx.payload` so mutations from
          // `withStoreForcedFalse`, `withServiceTierStripped`, etc. survive
          // the trigger-item insertion.
          const { model: _ignored, ...wireBody } = ctx.payload;
          const input: ResponsesInputItem[] = typeof wireBody.input === 'string' ? [{ type: 'message', role: 'user', content: wireBody.input }] : wireBody.input;
          const triggered = { ...wireBody, input: [...input, COMPACTION_TRIGGER], stream: false, model: rawModel.id };
          const response = await copilotFetchResponses(
            upstreamConfig,
            { method: 'POST', body: JSON.stringify(triggered), signal },
            Object.keys(ctx.headers).length > 0 ? { extraHeaders: ctx.headers } : undefined,
          );
          if (!response.ok) return { ok: false, response, modelKey: rawModel.id };
          const generated = (await response.json()) as ResponsesResult;
          return { ok: true, result: compactionResponse(input, generated), modelKey: rawModel.id };
        },
      );
    },
    callMessages: async (model, body, signal, headers, anthropicBeta) => {
      const rawModel = messagesRawModel(model, body, anthropicBeta);
      const ctx: MessagesBoundaryCtx = {
        payload: { ...body, model: model.id },
        headers: { ...(headers ?? {}) },
        model,
        ...(anthropicBeta !== undefined ? { anthropicBeta } : {}),
      };
      const result = await runInterceptors<MessagesBoundaryCtx, object, ExecuteResult<ProtocolFrame<MessagesStreamEvent>>>(
        ctx, {}, COPILOT_MESSAGES_BOUNDARY, async () => {
          const { model: _ignored, ...wireBody } = ctx.payload;
          return await liftStream(callStreaming(copilotFetchMessages, wireBody, signal, rawModel, ctx.headers, parseMessagesStream));
        },
      );
      return lowerToStream(result, rawModel.id);
    },
    callMessagesCountTokens: async (model, body, signal, headers, anthropicBeta) => {
      const rawModel = messagesRawModel(model, body, anthropicBeta);
      const ctx: MessagesCountTokensBoundaryCtx = {
        payload: { ...body, model: model.id },
        headers: { ...(headers ?? {}) },
        model,
        ...(anthropicBeta !== undefined ? { anthropicBeta } : {}),
      };
      const response = await runInterceptors<MessagesCountTokensBoundaryCtx, object, Response>(
        ctx, {}, COPILOT_MESSAGES_COUNT_TOKENS_BOUNDARY, async () => {
          const { model: _ignored, ...wireBody } = ctx.payload;
          const { response } = await call(copilotFetchMessagesCountTokens, wireBody, signal, rawModel, ctx.headers);
          return response;
        },
      );
      return { response, modelKey: rawModel.id };
    },
    callEmbeddings: (model, body, signal, headers) => call(copilotFetchEmbeddings, copilotEmbeddingsBody(body), signal, rawModelFor(model, 'embeddings'), headers),
    // Copilot has no /images/... upstream. getProvidedModels never emits a
    // kind='image' model for Copilot bindings, so the source-side dispatcher
    // in packages/gateway/src/data-plane/images/serve.ts never selects this provider
    // for image requests. These stubs satisfy the ModelProvider interface
    // only; they are unreachable in normal operation. The `headers` parameter
    // is present for signature parity with the other call methods even
    // though it is never consumed.
    callImagesGenerations: () => {
      throw new Error('Copilot provider does not implement images_generations');
    },
    callImagesEdits: () => {
      throw new Error('Copilot provider does not implement images_edits');
    },
  };

  return {
    upstream: copilot.id,
    providerKind: 'copilot',
    name: copilot.name,
    disabledPublicModelIds: copilot.disabledPublicModelIds,
    provider,
    supportsResponsesItemReference: false,
    resolveRequestedModelId: copilotRequestedModelAliasTarget,
  };
};
