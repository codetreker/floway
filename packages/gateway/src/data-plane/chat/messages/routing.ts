import { classifyResponsesItemAffinity } from '../responses/items/affinity.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { RoutingDecision } from '../shared/routing.ts';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ProviderCandidate } from '@floway-dev/provider';
import { messagesViaResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

export type MessagesRoutingDecision = RoutingDecision;

export const planMessagesRouting = async (input: {
  readonly payload: MessagesPayload;
  readonly candidates: readonly ProviderCandidate[];
  readonly ctx: ChatGatewayCtx;
}): Promise<MessagesRoutingDecision> =>
  await classifyResponsesItemAffinity({
    sourceItems: input.payload.messages,
    view: messagesViaResponsesItemsView,
    store: input.ctx.store,
    candidates: input.candidates,
  });
