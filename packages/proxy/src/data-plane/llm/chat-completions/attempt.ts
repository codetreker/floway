import { chatCompletionsInterceptors } from './interceptors/index.ts';
import type { ChatCompletionsInvocation } from './interceptors/types.ts';
import { messagesAttempt } from '../messages/attempt.ts';
import { responsesAttempt } from '../responses/attempt.ts';
import { rewriteStoredResponsesItemsForCandidate } from '../responses/items/rewrite.ts';
import type { StatefulResponsesStore } from '../responses/items/store.ts';
import { providerStreamResultToExecuteResult } from '../shared/attempt-helpers.ts';
import type { ProviderCandidate } from '../shared/candidates.ts';
import { tryCatchLlmServeFailure } from '../shared/errors.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import { traverseTranslation } from '../shared/translate-traverse.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { ChatCompletionsMessage, ChatCompletionsPayload, ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { type ExecuteResult } from '@floway-dev/provider';
import { translateChatCompletionsViaMessages, translateChatCompletionsViaResponses } from '@floway-dev/translate';
import { chatCompletionsViaResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

export interface ChatCompletionsAttemptArgs {
  readonly payload: ChatCompletionsPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  readonly candidate: ProviderCandidate;
  // Optional invocation-headers inheritance from a source attempt that
  // translated INTO chat-completions. Source-side interceptors (e.g. Messages
  // claude-agent / interaction-id setters) write trace headers into the
  // source `MessagesInvocation.headers` bag; passing them in here keeps them
  // on the wire for the translated upstream call.
  readonly inheritedInvocationHeaders?: Record<string, string>;
}

export const chatCompletionsAttempt = {
  generate: async (args: ChatCompletionsAttemptArgs): Promise<ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>> => {
    const { payload, ctx, store, candidate, inheritedInvocationHeaders } = args;
    const rewritten = await rewriteOrRenderChatCompletionsFailure(payload, store, candidate);
    if (rewritten.failure) return rewritten.failure;
    const invocation: ChatCompletionsInvocation = {
      payload: rewritten.payload,
      candidate,
      headers: { ...(inheritedInvocationHeaders ?? {}) },
    };
    return await runInterceptors(invocation, ctx, chatCompletionsInterceptors, async () => {
      if (candidate.targetApi === 'chat-completions') {
        return await callChatCompletionsAsExecuteResult(invocation.payload, ctx, candidate, invocation.headers);
      }
      if (candidate.targetApi === 'messages') {
        return await traverseTranslation(
          invocation.payload,
          p => translateChatCompletionsViaMessages(p, {
            model: candidate.binding.upstreamModel.id,
            fallbackMaxOutputTokens: candidate.binding.upstreamModel.limits.max_output_tokens,
          }),
          translated => messagesAttempt.generate({ payload: translated, ctx, store, candidate, inheritedInvocationHeaders: invocation.headers }),
        );
      }
      if (candidate.targetApi === 'responses') {
        return await traverseTranslation(
          invocation.payload,
          p => translateChatCompletionsViaResponses(p, { model: candidate.binding.upstreamModel.id }),
          translated => responsesAttempt.generate({ payload: translated, ctx, store, candidate, snapshotMode: 'none', inheritedInvocationHeaders: invocation.headers }),
        );
      }
      throw new Error(`chatCompletionsAttempt.generate: unexpected targetApi '${(candidate as { targetApi: string }).targetApi}'`);
    });
  },
};

// Mirror of `messagesAttempt` rewrite — Chat Completions carries stored
// Responses reasoning ids on `assistant.reasoning_items`, which the
// translate-package view exposes as Responses items so this same rewrite
// pass works across protocols.
const rewriteOrRenderChatCompletionsFailure = async (
  payload: ChatCompletionsPayload,
  store: StatefulResponsesStore,
  candidate: ProviderCandidate,
): Promise<{ payload: ChatCompletionsPayload; failure?: undefined } | { payload?: undefined; failure: ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>> & { type: 'upstream-error' } }> => {
  try {
    const rewrittenMessages = await rewriteStoredResponsesItemsForCandidate(
      payload.messages as readonly ChatCompletionsMessage[],
      chatCompletionsViaResponsesItemsView,
      store,
      candidate,
    );
    return { payload: { ...payload, messages: rewrittenMessages as ChatCompletionsMessage[] } };
  } catch (error) {
    const failure = tryCatchLlmServeFailure(error);
    if (failure === null) throw error;
    if (failure.kind !== 'item-not-found') throw error;
    return {
      failure: {
        type: 'upstream-error',
        status: 400,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: new TextEncoder().encode(JSON.stringify({
          error: { type: 'invalid_request_error', message: `Item with id '${failure.itemId}' not found.` },
        })),
      },
    };
  }
};

const callChatCompletionsAsExecuteResult = async (
  payload: ChatCompletionsPayload,
  ctx: GatewayCtx,
  candidate: ProviderCandidate,
  invocationHeaders: Record<string, string>,
): Promise<ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>> => {
  const { model: _model, ...body } = payload;
  const providerResult = await candidate.binding.provider.callChatCompletions(
    candidate.binding.upstreamModel,
    body,
    ctx.abortSignal,
    invocationHeaders,
  );
  return await providerStreamResultToExecuteResult(providerResult, candidate);
};
