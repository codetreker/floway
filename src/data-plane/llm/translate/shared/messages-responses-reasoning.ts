import { makeResponsesReasoningId } from './reasoning.ts';
import type { MessagesRedactedThinkingBlock, MessagesThinkingBlock } from '../../../shared/protocol/messages.ts';
import type { ResponseInputReasoning } from '../../../shared/protocol/responses.ts';
import type { ResponsesReasoningItem } from '../../shared/protocol/responses.ts';

export type MessagesReasoningBlock = MessagesThinkingBlock | MessagesRedactedThinkingBlock;

export const messagesReasoningBlockToResponsesReasoning = (block: MessagesReasoningBlock, index: number): ResponseInputReasoning | null => {
  if (block.type === 'redacted_thinking') return null;

  return {
    type: 'reasoning',
    id: makeResponsesReasoningId(index),
    summary: block.thinking ? [{ type: 'summary_text', text: block.thinking }] : [],
  };
};

export const responsesReasoningToMessagesBlock = (item: ResponsesReasoningItem): MessagesThinkingBlock | null => {
  const thinking = item.summary?.length
    ? item.summary
        .map(part => part.text)
        .join('')
        .trim()
    : '';

  return thinking ? { type: 'thinking', thinking } : null;
};
