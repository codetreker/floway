import { messagesInterceptors, messagesCountTokensInterceptors } from './interceptors/index.ts';
import type { MessagesInvocation } from './interceptors/types.ts';
import { chatCompletionsAttempt } from '../chat-completions/attempt.ts';
import { responsesAttempt } from '../responses/attempt.ts';
import { rewriteStoredResponsesItemsForCandidate } from '../responses/items/rewrite.ts';
import type { StatefulResponsesStore } from '../responses/items/store.ts';
import { providerStreamResultToExecuteResult } from '../shared/attempt-helpers.ts';
import type { ProviderCandidate } from '../shared/candidates.ts';
import { tryCatchLlmServeFailure } from '../shared/errors.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import { plainResultFromResponse } from '../shared/respond.ts';
import { traverseTranslation } from '../shared/translate-traverse.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesMessage, MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import { type ExecuteResult, type PlainResult } from '@floway-dev/provider';
import { translateMessagesViaChatCompletions, translateMessagesViaResponses } from '@floway-dev/translate';
import { messagesViaResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

export interface MessagesAttemptGenerateArgs {
  readonly payload: MessagesPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  readonly candidate: ProviderCandidate;
  readonly anthropicBeta?: readonly string[];
  // Optional invocation-headers inheritance from a source attempt that
  // translated INTO messages. Source-side interceptors write trace headers
  // into the source invocation; passing them in here keeps them on the wire
  // for the translated upstream call.
  readonly inheritedInvocationHeaders?: Record<string, string>;
}

export interface MessagesAttemptCountTokensArgs {
  readonly payload: MessagesPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  readonly candidate: ProviderCandidate;
  readonly anthropicBeta?: readonly string[];
  readonly inheritedInvocationHeaders?: Record<string, string>;
}

export const messagesAttempt = {
  generate: async (args: MessagesAttemptGenerateArgs): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> => {
    const { payload, ctx, store, candidate, anthropicBeta, inheritedInvocationHeaders } = args;
    const rewritten = await rewriteOrRenderMessagesFailure(payload, store, candidate);
    if (rewritten.failure) return rewritten.failure;
    const invocation: MessagesInvocation = {
      payload: rewritten.payload,
      candidate,
      ...(anthropicBeta !== undefined ? { anthropicBeta } : {}),
      headers: { ...(inheritedInvocationHeaders ?? {}) },
    };
    return await runInterceptors(invocation, ctx, messagesInterceptors, async () => {
      if (candidate.targetApi === 'messages') {
        const { model: _model, ...body } = invocation.payload;
        const providerResult = await candidate.binding.provider.callMessages(
          candidate.binding.upstreamModel,
          body,
          ctx.abortSignal,
          invocation.headers,
          invocation.anthropicBeta,
        );
        return await providerStreamResultToExecuteResult(providerResult, candidate);
      }
      if (candidate.targetApi === 'responses') {
        return await traverseTranslation(
          invocation.payload,
          p => translateMessagesViaResponses(p, { model: candidate.binding.upstreamModel.id }),
          translated => responsesAttempt.generate({
            payload: translated, ctx, store, candidate, snapshotMode: 'none', inheritedInvocationHeaders: invocation.headers,
          }),
        );
      }
      if (candidate.targetApi === 'chat-completions') {
        return await traverseTranslation(
          invocation.payload,
          p => translateMessagesViaChatCompletions(p, { model: candidate.binding.upstreamModel.id }),
          translated => chatCompletionsAttempt.generate({
            payload: translated, ctx, store, candidate, inheritedInvocationHeaders: invocation.headers,
          }),
        );
      }
      throw new Error(`messagesAttempt.generate: unexpected targetApi '${(candidate as { targetApi: string }).targetApi}'`);
    });
  },

  countTokens: async (args: MessagesAttemptCountTokensArgs): Promise<PlainResult> => {
    const { payload, ctx, store, candidate, anthropicBeta, inheritedInvocationHeaders } = args;
    if (candidate.targetApi !== 'messages') {
      throw new Error(`messagesAttempt.countTokens requires targetApi='messages', got '${candidate.targetApi}'`);
    }
    const rewritten = await rewriteOrRenderMessagesFailure(payload, store, candidate);
    if (rewritten.failure) {
      // count_tokens has no streaming envelope; surface the rewrite-time
      // failure as a synthetic PlainResult carrying the same body.
      return { type: 'plain', status: rewritten.failure.status, headers: rewritten.failure.headers, body: rewritten.failure.body };
    }
    const invocation: MessagesInvocation = {
      payload: rewritten.payload,
      candidate,
      ...(anthropicBeta !== undefined ? { anthropicBeta } : {}),
      headers: { ...(inheritedInvocationHeaders ?? {}) },
    };
    const response = await runInterceptors(invocation, ctx, messagesCountTokensInterceptors, async () => {
      const { model: _model, ...body } = invocation.payload;
      const { response } = await candidate.binding.provider.callMessagesCountTokens(
        candidate.binding.upstreamModel,
        body,
        ctx.abortSignal,
        invocation.headers,
        invocation.anthropicBeta,
      );
      return response;
    });
    return await plainResultFromResponse(response);
  },
};

// Rewrites stored Responses item carriers (assistant thinking blocks whose
// signature packs a gateway-stored reasoning id) to the upstream-owned id
// the chosen candidate's wire requires. Failures only originate from
// `item_reference` against a candidate without item_reference support, which
// the affinity walk already excluded — but defensive rewrite is cheap and
// keeps the attempt closed-loop.
const rewriteOrRenderMessagesFailure = async (
  payload: MessagesPayload,
  store: StatefulResponsesStore,
  candidate: ProviderCandidate,
): Promise<{ payload: MessagesPayload; failure?: undefined } | { payload?: undefined; failure: ExecuteResult<ProtocolFrame<MessagesStreamEvent>> & { type: 'upstream-error' } }> => {
  try {
    const rewrittenMessages = await rewriteStoredResponsesItemsForCandidate(
      payload.messages as readonly MessagesMessage[],
      messagesViaResponsesItemsView,
      store,
      candidate,
    );
    return { payload: { ...payload, messages: rewrittenMessages as MessagesMessage[] } };
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
          type: 'error',
          error: { type: 'invalid_request_error', message: `Item with id '${failure.itemId}' not found.` },
        })),
      },
    };
  }
};
