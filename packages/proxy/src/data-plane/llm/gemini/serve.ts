import { geminiAttempt } from './attempt.ts';
import { renderGeminiFailure } from './errors.ts';
import { planGeminiRouting } from './routing.ts';
import type { StatefulResponsesStore } from '../responses/items/store.ts';
import { enumerateProviderCandidates } from '../shared/candidates.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiPayload, GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import type { ExecuteResult, PlainResult } from '@floway-dev/provider';

export interface GeminiServeGenerateArgs {
  readonly payload: GeminiPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  // Per-request model id (Gemini carries it in the URL path, not the body),
  // resolved by the HTTP entry and threaded through here so candidate
  // enumeration and failure rendering all see the same value.
  readonly model: string;
}

export interface GeminiServeCountTokensArgs {
  readonly payload: GeminiPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  readonly model: string;
}

export const geminiServe = {
  generate: async (args: GeminiServeGenerateArgs): Promise<ExecuteResult<ProtocolFrame<GeminiStreamEvent>>> => {
    const { payload, ctx, store, model } = args;
    const { candidates, sawModel } = await enumerateProviderCandidates({
      apiKeyUpstreamIds: ctx.apiKeyUpstreamIds,
      model,
      // Gemini has no native upstream target in the provider API; prefer
      // Chat Completions, then Messages, then Responses.
      pickTarget: endpoints => endpoints.chatCompletions ? 'chat-completions' : endpoints.messages ? 'messages' : endpoints.responses ? 'responses' : null,
    });
    const decision = await planGeminiRouting({ payload, candidates, store });
    if (decision.kind === 'failure') return renderGeminiFailure(decision.failure, 'generate');

    // Any non-throwing attempt result — events, upstream-error, or
    // internal-error — IS the answer for this request: an upstream 4xx/5xx
    // from the first viable candidate is final, not a hint to try another
    // upstream.
    const [candidate] = decision.candidates;
    if (candidate === undefined) {
      return renderGeminiFailure(
        sawModel
          ? { kind: 'model-unsupported', model }
          : { kind: 'model-missing', model },
        'generate',
      );
    }
    return await geminiAttempt.generate({ payload, ctx, store, candidate });
  },

  countTokens: async (args: GeminiServeCountTokensArgs): Promise<ExecuteResult<ProtocolFrame<GeminiStreamEvent>> | PlainResult> => {
    const { payload, ctx, store, model } = args;
    const { candidates, sawModel } = await enumerateProviderCandidates({
      apiKeyUpstreamIds: ctx.apiKeyUpstreamIds,
      model,
      // Gemini countTokens has no native upstream support; only providers
      // exposing the Messages endpoint qualify because we translate Gemini
      // → Messages and call Messages count_tokens upstream.
      pickTarget: endpoints => endpoints.messages ? 'messages' : null,
    });
    const decision = await planGeminiRouting({ payload, candidates, store });
    if (decision.kind === 'failure') return renderGeminiFailure(decision.failure, 'countTokens');

    // PlainResult always represents a final response — both 2xx and upstream
    // errors come back as a `plain` envelope, so the first candidate's result
    // is the answer. Provider-level transport errors throw and propagate.
    const [candidate] = decision.candidates;
    if (candidate === undefined) {
      return renderGeminiFailure(
        sawModel
          ? { kind: 'model-unsupported', model }
          : { kind: 'model-missing', model },
        'countTokens',
      );
    }
    return await geminiAttempt.countTokens({ payload, ctx, store, candidate });
  },
};
