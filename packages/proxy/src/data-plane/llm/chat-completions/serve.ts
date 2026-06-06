import { chatCompletionsAttempt } from './attempt.ts';
import { renderChatCompletionsFailure } from './errors.ts';
import { planChatCompletionsRouting } from './routing.ts';
import type { StatefulResponsesStore } from '../responses/items/store.ts';
import { enumerateProviderCandidates } from '../shared/candidates.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import type { ChatCompletionsPayload, ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult } from '@floway-dev/provider';

export interface ChatCompletionsServeGenerateArgs {
  readonly payload: ChatCompletionsPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
}

export const chatCompletionsServe = {
  generate: async (args: ChatCompletionsServeGenerateArgs): Promise<ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>> => {
    const { payload, ctx, store } = args;
    const { candidates, sawModel } = await enumerateProviderCandidates({
      apiKeyUpstreamIds: ctx.apiKeyUpstreamIds,
      model: payload.model,
      pickTarget: endpoints =>
        endpoints.chatCompletions ? 'chat-completions'
          : endpoints.messages ? 'messages'
            : endpoints.responses ? 'responses'
              : null,
    });
    const decision = await planChatCompletionsRouting({ payload, candidates, store });
    if (decision.kind === 'failure') return renderChatCompletionsFailure(decision.failure);

    // Any non-throwing attempt result — events, upstream-error, or
    // internal-error — IS the answer for this request: an upstream 4xx/5xx
    // from the first viable candidate is final, not a hint to try another
    // upstream.
    const [candidate] = decision.candidates;
    if (candidate === undefined) {
      return renderChatCompletionsFailure(
        sawModel
          ? { kind: 'model-unsupported', model: payload.model }
          : { kind: 'model-missing', model: payload.model },
      );
    }
    return await chatCompletionsAttempt.generate({ payload, ctx, store, candidate });
  },
};
