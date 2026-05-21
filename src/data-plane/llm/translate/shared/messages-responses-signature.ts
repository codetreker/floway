import { makeResponsesReasoningId } from './reasoning.ts';
import type { MessagesRedactedThinkingBlock, MessagesThinkingBlock } from '../../../shared/protocol/messages.ts';
import type { ResponseInputReasoning, ResponseOutputReasoning } from '../../../shared/protocol/responses.ts';

export type MessagesReasoningBlock = MessagesThinkingBlock | MessagesRedactedThinkingBlock;

export type ResponsesReasoningItem = ResponseInputReasoning | ResponseOutputReasoning;

/**
 * Pack a Responses reasoning item's `id` and `encrypted_content` into an
 * Anthropic `thinking.signature` / `redacted_thinking.data` string using
 * `${encrypted_content}@${id}`.
 *
 * Why: Responses reasoning `encrypted_content` is tied to its item id, and
 * upstreams that verify reasoning continuity reject a next-turn submission
 * whose `id` does not match the id baked into the blob with
 * `400 invalid_request_body: "Encrypted content item_id did not match the
 * target item id."`. Anthropic `thinking` / `redacted_thinking` blocks have no
 * id slot, so when we translate Responses output to Messages we must smuggle
 * the original Responses id alongside the blob, then recover it on the way
 * back up. The `${encrypted_content}@${id}` layout keeps this bridge compact
 * and remains compatible with existing gateway-issued transcripts.
 *
 * Scope: this helper is exclusive to the Messages<->Responses translation
 * pair. The packed signature is the bridge contract that downstream Messages
 * clients echo back on the next turn; it is not a general Anthropic signature
 * format, and other translation pairs should not interpret it.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/blob/79b9f491aad13259cb27e8a82faf690474b159a4/src/routes/messages/responses-translation.ts#L427-L440
 * - https://github.com/caozhiyuan/copilot-api/blob/79b9f491aad13259cb27e8a82faf690474b159a4/src/routes/messages/responses-translation.ts#L565
 * - https://github.com/caozhiyuan/copilot-api/blob/79b9f491aad13259cb27e8a82faf690474b159a4/src/routes/messages/responses-stream-translation.ts#L237
 * - https://github.com/caozhiyuan/copilot-api/issues/63
 * - https://github.com/caozhiyuan/copilot-api/issues/73
 */
export const packReasoningSignature = (id: string, encryptedContent: string): string => `${encryptedContent}@${id}`;

/**
 * Inverse of {@link packReasoningSignature}.
 *
 * Returns `{ id, encryptedContent }` when the input matches the packed
 * `${encrypted_content}@${id}` shape, and `{ id: null, encryptedContent }`
 * otherwise — so signatures not issued by this gateway (e.g. native Anthropic
 * sessions resumed through this translation path, or stored sessions predating
 * the packing change) round-trip as-is and the caller falls back to a
 * synthesized id. Splits on the last `@`: base64 `encrypted_content` cannot
 * contain `@`, but using `lastIndexOf` matches caozhiyuan's parser and is
 * resilient if the upstream format ever widens.
 */
export const unpackReasoningSignature = (signature: string): { id: string | null; encryptedContent: string } => {
  const splitIndex = signature.lastIndexOf('@');
  if (splitIndex <= 0 || splitIndex === signature.length - 1) {
    return { id: null, encryptedContent: signature };
  }
  return {
    id: signature.slice(splitIndex + 1),
    encryptedContent: signature.slice(0, splitIndex),
  };
};

export const messagesReasoningBlockToResponsesReasoning = (block: MessagesReasoningBlock, index: number): ResponseInputReasoning => {
  if (block.type === 'redacted_thinking') {
    const unpacked = unpackReasoningSignature(block.data);
    return {
      type: 'reasoning',
      id: unpacked.id ?? makeResponsesReasoningId(index),
      summary: [],
      encrypted_content: unpacked.encryptedContent,
    };
  }

  const unpacked = typeof block.signature === 'string' ? unpackReasoningSignature(block.signature) : null;

  return {
    type: 'reasoning',
    id: unpacked?.id ?? makeResponsesReasoningId(index),
    summary: block.thinking ? [{ type: 'summary_text', text: block.thinking }] : [],
    ...(unpacked ? { encrypted_content: unpacked.encryptedContent } : {}),
  };
};

/**
 * Materialize Responses reasoning as the only Messages assistant block shapes
 * that can round-trip it: plaintext summaries as `thinking`, opaque-only blobs
 * as `redacted_thinking`, and empty reasoning as no block.
 */
export const responsesReasoningToMessagesBlock = (item: ResponsesReasoningItem): MessagesReasoningBlock | null => {
  const thinking = item.summary?.length
    ? item.summary
        .map(part => part.text)
        .join('')
        .trim()
    : '';
  const encryptedContent = item.encrypted_content;

  if (!thinking) {
    return encryptedContent === undefined
      ? null
      : {
          type: 'redacted_thinking',
          data: packReasoningSignature(item.id, encryptedContent),
        };
  }

  return {
    type: 'thinking',
    thinking,
    ...(encryptedContent !== undefined ? { signature: packReasoningSignature(item.id, encryptedContent) } : {}),
  };
};
