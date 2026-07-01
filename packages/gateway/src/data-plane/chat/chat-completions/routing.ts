import { classifyResponsesItemAffinity } from '../responses/items/affinity.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { RoutingDecision } from '../shared/routing.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ProviderCandidate } from '@floway-dev/provider';
import { chatCompletionsViaResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

export const planChatCompletionsRouting = async (input: {
  readonly payload: ChatCompletionsPayload;
  readonly candidates: readonly ProviderCandidate[];
  readonly ctx: ChatGatewayCtx;
}): Promise<RoutingDecision> =>
  await classifyResponsesItemAffinity({
    sourceItems: input.payload.messages,
    view: chatCompletionsViaResponsesItemsView,
    store: input.ctx.store,
    candidates: input.candidates,
  });
