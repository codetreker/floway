import type { ResponsesBoundaryCtx } from './types.ts';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';

// Codex backend rejects any `role: "system"` message inside the `input`
// array with HTTP 400 `{"detail":"System messages are not allowed"}`. Standard
// OpenAI Responses API and Azure both accept it, but Codex/ChatGPT-subscription
// requires system content to live in the top-level `instructions` field.
//
// Two ways a system-role item can reach this interceptor:
//   1. A client posts directly to /v1/responses with one in `input`.
//   2. The chat-completions-via-responses translator emits one for any non-
//      prefix `role: "system"` message (the prefix is hoisted, but later turns
//      pass through verbatim).
//
// We pull every system-role text into `instructions` (appended after any
// existing instructions), then drop those items from `input`. `developer`
// role is left alone — Codex accepts it. Non-message items pass through
// untouched. Generic in the run-result type so the same definition feeds
// both the streaming `/responses` chain and the non-streaming
// `/responses/compact` chain.
export const hoistSystemInputToInstructions = async <TResult>(
  ctx: ResponsesBoundaryCtx,
  _request: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const input = ctx.payload.input;
  if (!Array.isArray(input)) return await run();

  const hoisted: string[] = [];
  const remaining: ResponsesInputItem[] = [];
  for (const item of input) {
    if (typeof item === 'object' && item !== null) {
      const obj = item as { type?: unknown; role?: unknown };
      // Implicit `type: "message"` is allowed (OpenAI accepts {role, content}
      // without explicit type), so fall through when type is missing.
      const isMessage = obj.type === undefined || obj.type === 'message';
      if (isMessage && obj.role === 'system') {
        const text = extractText(item);
        if (text) hoisted.push(text);
        continue;
      }
    }
    remaining.push(item);
  }

  if (hoisted.length === 0) return await run();

  const existing = typeof ctx.payload.instructions === 'string' ? ctx.payload.instructions : '';
  const merged = [existing, ...hoisted].filter(s => s.length > 0).join('\n\n');
  ctx.payload = { ...ctx.payload, instructions: merged, input: remaining };
  return await run();
};

const extractText = (item: ResponsesInputItem): string => {
  const content = (item as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: string; text?: unknown } => typeof part === 'object' && part !== null && 'type' in part)
    .map(part => {
      // Cover both input-shaped (`input_text`) and output-shaped
      // (`output_text`) text parts; either can appear if the caller cloned a
      // response message back into input.
      if ((part.type === 'input_text' || part.type === 'output_text') && typeof part.text === 'string') return part.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
};
