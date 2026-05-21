import { makeResponsesReasoningId } from './reasoning.ts';
import type { ChatReasoningItem } from '../../../shared/protocol/chat-completions.ts';
import type { ResponseInputItem, ResponseInputReasoning, ResponseOutputReasoning } from '../../../shared/protocol/responses.ts';

export type ChatReasoningSourceItem = Extract<ResponseInputItem, { type: 'reasoning' }> | ResponseOutputReasoning;

export type ResponseReasoningItem = ResponseInputReasoning | ResponseOutputReasoning;

export interface ChatReasoningProjection {
  items: ChatReasoningItem[];
  text?: string;
  opaque?: string;
}

export const createChatReasoningProjection = (): ChatReasoningProjection => ({
  items: [],
});

export const toChatReasoningItem = (item: ChatReasoningSourceItem): ChatReasoningItem => ({
  type: 'reasoning',
  id: item.id,
  summary: item.summary,
  ...(item.encrypted_content !== undefined ? { encrypted_content: item.encrypted_content } : {}),
});

export const addResponseReasoningToChatProjection = (projection: ChatReasoningProjection, item: ChatReasoningSourceItem): void => {
  projection.items.push(toChatReasoningItem(item));

  const text = item.summary.map(part => part.text).join('');
  const hasEncryptedContent = Object.hasOwn(item, 'encrypted_content');
  if (projection.text === undefined && projection.opaque === undefined && (text || hasEncryptedContent)) {
    if (text) projection.text = text;
    if (hasEncryptedContent) projection.opaque = item.encrypted_content;
  }
};

export const chatReasoningProjectionFields = (projection: ChatReasoningProjection) => ({
  ...(projection.text !== undefined ? { reasoning_text: projection.text } : {}),
  ...(projection.opaque !== undefined ? { reasoning_opaque: projection.opaque } : {}),
  ...(projection.items.length > 0 ? { reasoning_items: projection.items } : {}),
});

export const toResponseReasoningItem = <T extends ResponseReasoningItem>(item: ChatReasoningItem, fallbackId: string): T =>
  ({
    type: 'reasoning',
    id: item.id ?? fallbackId,
    summary: item.summary ?? [],
    ...(item.encrypted_content !== undefined ? { encrypted_content: item.encrypted_content } : {}),
  } as T);

export const scalarToResponseReasoningItem = <T extends ResponseReasoningItem>(reasoningText: string | null | undefined, reasoningOpaque: string | null | undefined, id: string): T | null => {
  const hasReasoningOpaque = reasoningOpaque !== undefined && reasoningOpaque !== null;
  if (!reasoningText && !hasReasoningOpaque) return null;

  return {
    type: 'reasoning',
    id,
    summary: reasoningText ? [{ type: 'summary_text', text: reasoningText }] : [],
    ...(hasReasoningOpaque ? { encrypted_content: reasoningOpaque } : {}),
  } as T;
};

export const translateChatReasoningItems = <T extends ResponseReasoningItem>(reasoningItems: ChatReasoningItem[] | null | undefined, nextIdIndex: () => number): T[] | null => {
  if (!reasoningItems?.length) return null;

  // `reasoning_items[]` is a LiteLLM-inspired compatibility workaround for
  // carrying Responses reasoning items through Chat without compressing multiple
  // opaque payloads into legacy scalar fields. Scalars remain first-group only.
  // References:
  // - https://github.com/BerriAI/litellm/blob/70492cee4282541256fb9ac963be94412b1a109c/litellm/completion_extras/litellm_responses_transformation/transformation.py#L59-L104
  // - https://github.com/BerriAI/litellm/blob/70492cee4282541256fb9ac963be94412b1a109c/litellm/completion_extras/litellm_responses_transformation/transformation.py#L1322-L1355
  const startIndex = nextIdIndex();
  return reasoningItems.map((item, index) => toResponseReasoningItem<T>(item, makeResponsesReasoningId(startIndex + index)));
};
