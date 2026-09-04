import { ensureM365AccessToken } from './access-token.ts';
import { openM365ChatTurn, type M365ChatTurnStream } from './chat.ts';
import { assertM365CopilotWebUpstreamRecord, type M365CopilotWebUpstreamRecord } from './config.ts';
import { M365_COPILOT_WEB_DEFAULT_FLAGS } from './defaults.ts';
import { M365BusyError, M365ProbeRequiredError } from './errors.ts';
import { startM365Heartbeat, type M365Heartbeat } from './heartbeat.ts';
import { m365ModelDefinition, projectM365Models, type M365ProviderModelData } from './models.ts';
import { claimM365Turn, commitM365Turn, m365BusyResponse, markM365DispatchUncertain, releaseM365PreDispatch, renewM365TurnClaim, type M365ClaimedTurn } from './sessions.ts';
import { readM365CopilotWebUpstreamState, type M365CopilotWebUpstreamState } from './state.ts';
import { canonicalizeM365ChatMessages, canonicalizeM365ResponsesInput, digestM365RouteProfile, digestM365Text, formatM365CanonicalMessages, m365HandleFromChatMessages, type M365CanonicalMessage } from './transcript.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { createRandomOpenAIResponsesItemId, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesOutputItem, type OpenAIResponsesResult, type OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import { getProviderRepo, type Provider, type ProviderCallResult, type ProviderInstance, type ProviderModel, type ProviderOpenAIResponsesResult, type ProviderStreamResult, type UpstreamCallOptions, type UpstreamRecord } from '@floway-dev/provider';

type M365CallOptions = UpstreamCallOptions & { caller?: { apiKeyId: string } };

interface RunningTurn {
  turn: M365ClaimedTurn;
  stream: M365ChatTurnStream;
  heartbeat: M365Heartbeat;
  markConsumed(): void;
  dispose(): void;
}

const M365_TURN_TIMEOUT_MS = 30 * 60 * 1000;
const M365_STREAM_CONSUMPTION_TIMEOUT_MS = 30_000;

const jsonError = (status: number, type: string, message: string): Response => new Response(JSON.stringify({ error: { type, message } }), {
  status,
  headers: { 'content-type': 'application/json' },
});

const invalidChat = (modelKey: string, message: string): ProviderStreamResult<OpenAIChatCompletionsStreamEvent> => ({
  ok: false,
  modelKey,
  response: jsonError(400, 'invalid_request_error', message),
});

const invalidResponses = (action: 'generate' | 'compact', modelKey: string, message: string): ProviderOpenAIResponsesResult => ({
  action,
  ok: false,
  modelKey,
  response: jsonError(400, 'invalid_request_error', message),
});

const unsupportedResponse = (capability: string): Response => jsonError(405, 'method_not_allowed', `M365 Copilot Web provider does not support ${capability}`);

const unsupportedCall = (capability: string): Promise<ProviderCallResult> => Promise.resolve({ modelKey: '', response: unsupportedResponse(capability) });
const unsupportedStream = <TEvent>(capability: string): Promise<ProviderStreamResult<TEvent>> => Promise.resolve({ ok: false, modelKey: '', response: unsupportedResponse(capability) });

const providerDataFor = (model: ProviderModel): M365ProviderModelData => {
  const definition = m365ModelDefinition(model.id);
  const data = model.providerData;
  if (typeof data !== 'object' || data === null || Array.isArray(data) || (data as Record<string, unknown>).tone !== definition.tone) {
    throw new Error(`M365 model ${model.id} provider data is inconsistent with the catalog`);
  }
  return data as M365ProviderModelData;
};

const readFresh = async (upstreamId: string, requireEnabled = false): Promise<{ record: M365CopilotWebUpstreamRecord; state: M365CopilotWebUpstreamState }> => {
  const record = await getProviderRepo().upstreams.getById(upstreamId);
  if (record === null) throw new Error(`M365 Copilot upstream ${upstreamId} disappeared`);
  assertM365CopilotWebUpstreamRecord(record);
  if (requireEnabled && !record.enabled) throw new Error(`M365 Copilot upstream ${upstreamId} is disabled`);
  return { record, state: readM365CopilotWebUpstreamState(record.state) };
};

const ensureToneReceipt = (state: M365CopilotWebUpstreamState, model: ProviderModel, tone: string): Response | null => {
  const receipt = state.toneReceipts[model.id];
  return receipt?.available === true && receipt.tone === tone && receipt.expiresAt > Date.now()
    ? null
    : jsonError(409, 'm365_probe_required', `M365 model '${model.id}' requires a fresh successful tone probe`);
};

const probeRequiredResponse = (error: M365ProbeRequiredError): Response =>
  jsonError(409, error.code, error.message);

const errorEvents = <TEvent>(error: unknown): AsyncIterable<ProtocolFrame<TEvent>> => (async function* () { throw error; })();

const combineCleanupFailures = (primary: unknown, cleanupErrors: readonly unknown[]): unknown =>
  cleanupErrors.length === 0
    ? primary
    : new AggregateError([primary, ...cleanupErrors], 'M365 request failed and cleanup also failed', { cause: primary });

const cleanupPreDispatch = async (
  primary: unknown,
  cleanups: readonly (() => Promise<void>)[],
): Promise<never> => {
  const cleanupErrors: unknown[] = [];
  for (const cleanup of cleanups) {
    try { await cleanup(); } catch (error) { cleanupErrors.push(error); }
  }
  throw combineCleanupFailures(primary, cleanupErrors);
};

const beginNetworkTurn = async (input: {
  upstreamId: string;
  model: ProviderModel;
  tone: string;
  apiKeyId: string;
  expectedCredentialId: string;
  requestedHandle?: string;
  history: readonly M365CanonicalMessage[];
  promptPrefix: readonly M365CanonicalMessage[];
  routeProfileDigest: string;
  signal?: AbortSignal;
  options: M365CallOptions;
}): Promise<RunningTurn | { error: unknown; turn: M365ClaimedTurn }> => {
  const turnController = new AbortController();
  const forwardAbort = () => turnController.abort(input.signal?.reason);
  if (input.signal?.aborted) forwardAbort();
  else input.signal?.addEventListener('abort', forwardAbort, { once: true });
  const turnTimer = setTimeout(() => turnController.abort(new Error('M365 Copilot turn timed out')), M365_TURN_TIMEOUT_MS);
  const disposeTurnSignal = () => {
    clearTimeout(turnTimer);
    input.signal?.removeEventListener('abort', forwardAbort);
  };
  let turn: M365ClaimedTurn;
  try {
    turn = await claimM365Turn({
      upstreamId: input.upstreamId,
      apiKeyId: input.apiKeyId,
      expectedCredentialId: input.expectedCredentialId,
      modelId: input.model.id,
      routeProfileDigest: input.routeProfileDigest,
      history: input.history,
      requestedHandle: input.requestedHandle,
    });
  } catch (error) {
    disposeTurnSignal();
    throw error;
  }
  const heartbeat = startM365Heartbeat(input.upstreamId, turn);
  void heartbeat.failure.catch(error => turnController.abort(error));
  let opened: Awaited<ReturnType<typeof openM365ChatTurn>>;
  try {
    const claimedFresh = await readFresh(input.upstreamId, true);
    if (claimedFresh.state.credential.credentialId !== input.expectedCredentialId) throw new Error('M365 credential changed after session claim');
    if (ensureToneReceipt(claimedFresh.state, input.model, input.tone) !== null) {
      throw new M365ProbeRequiredError(input.model.id);
    }
    const accessToken = await ensureM365AccessToken(input.upstreamId, input.options.fetcher, turnController.signal);
    opened = await openM365ChatTurn({
      connectWebSocket: input.options.connectWebSocket!,
      accessToken: accessToken.token,
      configuredChatHubHost: claimedFresh.record.config.account.chatHubHost,
      configuredChatHubPath: claimedFresh.record.config.account.chatHubPath,
      modelId: input.model.id,
      tone: input.tone,
      prompt: formatM365CanonicalMessages([
        ...(turn.promptStart === 0 ? input.promptPrefix : []),
        ...input.history.slice(turn.promptStart),
      ]),
      session: { sessionId: turn.session.sessionId, conversationId: turn.session.conversationId, turnCount: turn.session.turnCount },
      locale: claimedFresh.record.config.locale,
      timeZone: claimedFresh.record.config.timeZone,
      timeZoneOffsetMinutes: claimedFresh.record.config.timeZoneOffsetMinutes,
      signal: turnController.signal,
      wrapUpstreamCall: input.options.wrapUpstreamCall,
    });
  } catch (error) {
    heartbeat.stop();
    disposeTurnSignal();
    return await cleanupPreDispatch(error, [() => releaseM365PreDispatch(input.upstreamId, turn)]);
  }
  let dispatchIntentPersisted = false;
  try {
    await renewM365TurnClaim(input.upstreamId, turn);
    await markM365DispatchUncertain(input.upstreamId, turn);
    dispatchIntentPersisted = true;
    const stream = await opened.dispatch();
    void stream.diagnostics.catch(() => undefined);
    let disposed = false;
    let consumed = false;
    const consumptionTimer = setTimeout(() => {
      if (!consumed) turnController.abort(new Error('M365 Copilot stream was not consumed'));
    }, M365_STREAM_CONSUMPTION_TIMEOUT_MS);
    const disposeRunningResources = (): void => {
      if (disposed) return;
      disposed = true;
      clearTimeout(consumptionTimer);
      turnController.signal.removeEventListener('abort', abortRunningTurn);
      disposeTurnSignal();
      heartbeat.stop();
    };
    const abortRunningTurn = (): void => {
      disposeRunningResources();
      void stream.cancel().catch(() => undefined);
    };
    turnController.signal.addEventListener('abort', abortRunningTurn, { once: true });
    if (turnController.signal.aborted) abortRunningTurn();
    return {
      turn,
      stream,
      heartbeat,
      markConsumed: () => {
        consumed = true;
        clearTimeout(consumptionTimer);
      },
      dispose: disposeRunningResources,
    };
  } catch (error) {
    heartbeat.stop();
    disposeTurnSignal();
    const cleanupErrors: unknown[] = [];
    try { await opened.close(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    if (!dispatchIntentPersisted) {
      try { await releaseM365PreDispatch(input.upstreamId, turn); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    const combined = combineCleanupFailures(error, cleanupErrors);
    if (!dispatchIntentPersisted) throw combined;
    return { error: combined, turn };
  }
};

const finalizedChatEvents = (input: {
  upstreamId: string;
  running: RunningTurn;
  history: readonly M365CanonicalMessage[];
}): AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> => (async function* () {
  input.running.markConsumed();
  const iterator = input.running.stream.events[Symbol.asyncIterator]();
  let terminal: Extract<ProtocolFrame<OpenAIChatCompletionsStreamEvent>, { type: 'event' }> | null = null;
  let committed = false;
  try {
    while (true) {
      const result = await Promise.race([iterator.next(), input.running.heartbeat.failure]);
      if (result.done) throw new Error('M365 Chat stream ended without DONE');
      const frame = result.value;
      if (frame.type === 'done') {
        await iterator.return?.();
        const text = (await input.running.stream.diagnostics).answer;
        await renewM365TurnClaim(input.upstreamId, input.running.turn);
        await commitM365Turn({
          upstreamId: input.upstreamId,
          turn: input.running.turn,
          history: [...input.history, { role: 'assistant', content: text }],
        });
        committed = true;
        input.running.dispose();
        if (terminal === null) throw new Error('M365 Chat stream ended without a terminal event');
        yield eventFrame({
          id: terminal.event.id,
          object: 'chat.completion.chunk',
          created: terminal.event.created,
          model: terminal.event.model,
          choices: [{ index: 0, delta: { reasoning_opaque: input.running.turn.handle }, finish_reason: null }],
        });
        yield terminal;
        yield doneFrame();
        return;
      }
      const choice = frame.event.choices[0];
      if (choice?.finish_reason !== null && choice?.finish_reason !== undefined) terminal = frame;
      else yield frame;
    }
  } finally {
    input.running.dispose();
    if (!committed) await input.running.stream.cancel().catch(() => undefined);
    await iterator.return?.();
  }
})();

const finalizedResponsesEvents = (input: {
  upstreamId: string;
  running: RunningTurn;
  history: readonly M365CanonicalMessage[];
  body: Omit<CanonicalOpenAIResponsesPayload, 'model'>;
  modelId: string;
}): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>> => (async function* () {
  input.running.markConsumed();
  const iterator = input.running.stream.events[Symbol.asyncIterator]();
  const responseId = `resp_${crypto.randomUUID().replace(/-/g, '')}`;
  const reasoningId = createRandomOpenAIResponsesItemId('reasoning');
  const messageId = createRandomOpenAIResponsesItemId('message');
  const createdAt = Math.floor(Date.now() / 1000);
  const snapshot: OpenAIResponsesResult = {
    id: responseId,
    object: 'response',
    model: input.modelId,
    status: 'in_progress',
    output: [],
    error: null,
    incomplete_details: null,
    created_at: createdAt,
    completed_at: null,
    previous_response_id: input.body.previous_response_id ?? null,
    instructions: input.body.instructions ?? null,
    tools: [],
    tool_choice: 'none',
    parallel_tool_calls: false,
    store: input.body.store ?? false,
    metadata: input.body.metadata ?? null,
  };
  let committed = false;
  try {
    yield eventFrame({ type: 'response.created', response: snapshot });
    yield eventFrame({ type: 'response.in_progress', response: snapshot });
    yield eventFrame({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: messageId, status: 'in_progress', role: 'assistant', content: [] } });
    yield eventFrame({ type: 'response.content_part.added', item_id: messageId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    while (true) {
      const result = await Promise.race([iterator.next(), input.running.heartbeat.failure]);
      if (result.done) throw new Error('M365 Responses turn ended without DONE');
      const frame = result.value;
      if (frame.type === 'event') {
        const delta = frame.event.choices[0]?.delta.content;
        if (delta) {
          yield eventFrame({ type: 'response.output_text.delta', item_id: messageId, output_index: 0, content_index: 0, delta });
        }
      }
      if (frame.type !== 'done') continue;
      await iterator.return?.();
      const text = (await input.running.stream.diagnostics).answer;
      await renewM365TurnClaim(input.upstreamId, input.running.turn);
      await commitM365Turn({
        upstreamId: input.upstreamId,
        turn: input.running.turn,
        history: [...input.history, { role: 'assistant', content: text }],
      });
      committed = true;
      input.running.dispose();
      const completedAt = Math.floor(Date.now() / 1000);
      const output: OpenAIResponsesOutputItem[] = [
        {
          type: 'message', id: messageId, status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
        { type: 'reasoning', id: reasoningId, summary: [], encrypted_content: input.running.turn.handle },
      ];
      const response: OpenAIResponsesResult = {
        ...snapshot,
        status: 'completed',
        output,
        completed_at: completedAt,
      };
      const part = { type: 'output_text' as const, text, annotations: [] };
      yield eventFrame({ type: 'response.output_text.done', item_id: messageId, output_index: 0, content_index: 0, text });
      yield eventFrame({ type: 'response.content_part.done', item_id: messageId, output_index: 0, content_index: 0, part });
      yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: output[0]! });
      yield eventFrame({ type: 'response.output_item.added', output_index: 1, item: { type: 'reasoning', id: reasoningId, summary: [] } });
      yield eventFrame({ type: 'response.output_item.done', output_index: 1, item: output[1]! });
      yield eventFrame({ type: 'response.completed', response });
      yield doneFrame();
      return;
    }
  } finally {
    input.running.dispose();
    if (!committed) await input.running.stream.cancel().catch(() => undefined);
    await iterator.return?.();
  }
})();

const chatValidationError = (body: Omit<OpenAIChatCompletionsPayload, 'model'>): string | null => {
  if ((body.tools?.length ?? 0) > 0 || (body.tool_choice !== undefined && body.tool_choice !== null && body.tool_choice !== 'none')) return 'M365 Copilot Web does not support tools';
  const unsupported: (keyof typeof body)[] = ['max_tokens', 'stop', 'temperature', 'top_p', 'seed', 'presence_penalty', 'frequency_penalty', 'user', 'metadata', 'store', 'response_format', 'reasoning_effort', 'verbosity', 'safety_identifier', 'service_tier'];
  const present = unsupported.find(key => body[key] !== undefined && body[key] !== null);
  if (present !== undefined) return `M365 Copilot Web does not support '${present}'`;
  if (body.n !== undefined && body.n !== null && body.n !== 1) return 'M365 Copilot Web only supports n=1';
  if (body.messages.length === 0) return 'M365 Copilot Web requires at least one message';
  return null;
};

const responsesValidationError = (body: Omit<CanonicalOpenAIResponsesPayload, 'model'>): string | null => {
  if ((body.tools?.length ?? 0) > 0 || (body.tool_choice !== undefined && body.tool_choice !== null && body.tool_choice !== 'none')) return 'M365 Copilot Web does not support tools';
  const unsupported: (keyof typeof body)[] = ['temperature', 'top_p', 'max_output_tokens', 'max_tool_calls', 'reasoning', 'text', 'prompt_cache_options', 'prompt_cache_retention', 'safety_identifier', 'service_tier', 'truncation', 'background', 'top_logprobs', 'presence_penalty', 'frequency_penalty'];
  const present = unsupported.find(key => body[key] !== undefined && body[key] !== null);
  if (present !== undefined) return `M365 Copilot Web does not support '${present}'`;
  if (body.include?.some(value => value !== 'reasoning.encrypted_content')) return 'M365 Copilot Web only supports include=["reasoning.encrypted_content"]';
  return null;
};

export const createM365CopilotWebProvider = (record: UpstreamRecord): Provider => {
  assertM365CopilotWebUpstreamRecord(record);
  readM365CopilotWebUpstreamState(record.state);
  const instance: ProviderInstance = {
    getProvidedModels: async () => {
      const fresh = await readFresh(record.id);
      return projectM365Models(fresh.state, fresh.record.flagOverrides, M365_COPILOT_WEB_DEFAULT_FLAGS);
    },
    callOpenAIChatCompletions: async (model, body, signal, rawOptions) => {
      const invalid = chatValidationError(body);
      if (invalid !== null) return invalidChat(model.id, invalid);
      let history: M365CanonicalMessage[];
      try { history = canonicalizeM365ChatMessages(body.messages); } catch (error) { return invalidChat(model.id, error instanceof Error ? error.message : String(error)); }
      const options = rawOptions as M365CallOptions;
      if (options.caller?.apiKeyId === undefined) throw new Error('M365 Copilot Web requires caller.apiKeyId');
      if (options.connectWebSocket === undefined) throw new Error('M365 Copilot Web requires connectWebSocket');
      const fresh = await readFresh(record.id, true);
      const modelData = providerDataFor(model);
      const probeError = ensureToneReceipt(fresh.state, model, modelData.tone);
      if (probeError !== null) return { ok: false, modelKey: model.id, response: probeError };
      const routeProfileDigest = await digestM365RouteProfile({ modelId: model.id, tone: modelData.tone, surface: 'chat', framingRevision: 1 });
      let begun: Awaited<ReturnType<typeof beginNetworkTurn>>;
      try {
        begun = await beginNetworkTurn({
          upstreamId: record.id,
          model,
          tone: modelData.tone,
          apiKeyId: options.caller.apiKeyId,
          expectedCredentialId: fresh.state.credential.credentialId,
          requestedHandle: m365HandleFromChatMessages(body.messages),
          history,
          promptPrefix: [],
          routeProfileDigest,
          signal,
          options,
        });
      } catch (error) {
        if (error instanceof M365BusyError) return { ok: false, modelKey: model.id, response: m365BusyResponse(error) };
        if (error instanceof M365ProbeRequiredError) return { ok: false, modelKey: model.id, response: probeRequiredResponse(error) };
        throw error;
      }
      if ('error' in begun) return { ok: true, modelKey: model.id, events: errorEvents(begun.error) };
      return { ok: true, modelKey: model.id, events: finalizedChatEvents({ upstreamId: record.id, running: begun, history }) };
    },
    callOpenAIResponses: async (model, body, action, signal, rawOptions) => {
      if (action === 'compact') return invalidResponses(action, model.id, 'M365 Copilot Web relies on the Responses compact shim');
      const invalid = responsesValidationError(body);
      if (invalid !== null) return invalidResponses(action, model.id, invalid);
      let canonical: ReturnType<typeof canonicalizeM365ResponsesInput>;
      try { canonical = canonicalizeM365ResponsesInput(body); } catch (error) { return invalidResponses(action, model.id, error instanceof Error ? error.message : String(error)); }
      const options = rawOptions as M365CallOptions;
      if (options.caller?.apiKeyId === undefined) throw new Error('M365 Copilot Web requires caller.apiKeyId');
      if (options.connectWebSocket === undefined) throw new Error('M365 Copilot Web requires connectWebSocket');
      const fresh = await readFresh(record.id, true);
      const modelData = providerDataFor(model);
      const probeError = ensureToneReceipt(fresh.state, model, modelData.tone);
      if (probeError !== null) return { action, ok: false, modelKey: model.id, response: probeError };
      const routeProfileDigest = await digestM365RouteProfile({
        modelId: model.id,
        tone: modelData.tone,
        surface: 'responses',
        instructionsDigest: canonical.instructions === null ? null : await digestM365Text(canonical.instructions),
        framingRevision: 1,
      });
      const promptPrefix = canonical.instructions === null ? [] : [{ role: 'developer' as const, content: canonical.instructions }];
      let begun: Awaited<ReturnType<typeof beginNetworkTurn>>;
      try {
        begun = await beginNetworkTurn({
          upstreamId: record.id,
          model,
          tone: modelData.tone,
          apiKeyId: options.caller.apiKeyId,
          expectedCredentialId: fresh.state.credential.credentialId,
          requestedHandle: canonical.requestedHandle,
          history: canonical.history,
          promptPrefix,
          routeProfileDigest,
          signal,
          options,
        });
      } catch (error) {
        if (error instanceof M365BusyError) return { action, ok: false, modelKey: model.id, response: m365BusyResponse(error) };
        if (error instanceof M365ProbeRequiredError) return { action, ok: false, modelKey: model.id, response: probeRequiredResponse(error) };
        throw error;
      }
      if ('error' in begun) return { action, ok: true, modelKey: model.id, events: errorEvents(begun.error) };
      return { action, ok: true, modelKey: model.id, events: finalizedResponsesEvents({ upstreamId: record.id, running: begun, history: canonical.history, body, modelId: model.id }) };
    },
    callAlphaSearch: () => unsupportedCall('Alpha Search'),
    callOpenAICompletions: () => unsupportedCall('OpenAI Completions'),
    callAnthropicMessages: () => unsupportedStream('Anthropic Messages'),
    callAnthropicMessagesCountTokens: () => unsupportedCall('Anthropic Messages count_tokens'),
    callOpenAIEmbeddings: () => unsupportedCall('OpenAI Embeddings'),
    callOpenAIImagesGenerations: () => unsupportedCall('OpenAI Image Generations'),
    callOpenAIImagesEdits: () => unsupportedCall('OpenAI Image Edits'),
    callOpenAIAudioTranscriptions: () => unsupportedCall('OpenAI Audio Transcriptions'),
    callRerank: () => Promise.reject(new Error('M365 Copilot Web provider does not support rerank')),
  };
  return {
    upstreamId: record.id,
    kind: 'm365-copilot-web',
    name: record.name,
    inboundHeaderAllowlist: [],
    disabledPublicModelIds: record.disabledPublicModelIds,
    modelPrefix: record.modelPrefix,
    modelsCache: record.modelsCache,
    instance,
  };
};
