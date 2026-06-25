import { chatCompletionsErrorPayloadMessage } from './index.ts';
import type { ChatCompletionsStreamEvent, ChatCompletionsResult, ChatCompletionsReasoningItem, ChatCompletionsToolCall } from './index.ts';
import { captureExtras } from '../common/reassemble-extras.ts';

// Field-fidelity contract: every field a Chat Completions upstream emits must
// reach the non-streaming client untouched. The stream path achieves this for
// free (`to-sse.ts` re-serialises each chunk via `JSON.stringify`), but
// non-streaming clients receive a single result object reassembled here, so
// any field this code does not explicitly carry over disappears.
//
// We split fields into two buckets:
//  - "known" fields with streaming semantics (string concat, array merge by
//    index) — handled by the typed accumulators below.
//  - everything else — captured generically via {@link captureExtras} and
//    replayed onto the assembled result.
//
// `reasoning_content` (the DeepSeek/Kimi dialect for reasoning text on Chat
// Completions) is the concrete case that motivated the extras path; the goal
// is that any future field — `audio_prompt_tokens`, `prompt_filter_results`,
// `this_is_a_non_standard_field_of_reasoning` — survives by default without a
// gateway code change.
//
// Stable scalar strings that the upstream repeats unchanged on every chunk —
// OpenAI's `system_fingerprint` and `service_tier` are the canonical examples
// — MUST be registered as known keys; otherwise the generic extras path
// concatenates them into a duplicated mess (`fp_xfp_xfp_x…`).

const KNOWN_DELTA_KEYS = new Set(['content', 'role', 'reasoning_text', 'reasoning_opaque', 'reasoning_items', 'tool_calls']);
const KNOWN_CHOICE_KEYS = new Set(['index', 'delta', 'finish_reason']);
const KNOWN_CHUNK_KEYS = new Set(['id', 'object', 'created', 'model', 'choices', 'usage', 'system_fingerprint', 'service_tier']);

export async function reassembleChatCompletionsEvents(chunks: AsyncIterable<ChatCompletionsStreamEvent>): Promise<ChatCompletionsResult> {
  let id = '';
  let model = '';
  let created = 0;
  let systemFingerprint: string | undefined;
  let serviceTier: ChatCompletionsResult['service_tier'];
  let content = '';
  let reasoningText = '';
  let reasoningOpaque = '';
  let hasReasoningOpaque = false;
  const reasoningItems: ChatCompletionsReasoningItem[] = [];
  let finishReason: ChatCompletionsResult['choices'][number]['finish_reason'] = 'stop';
  let lastUsage: ChatCompletionsResult['usage'] | undefined;

  const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();

  const chunkExtras: Record<string, unknown> = {};
  const choiceExtras: Record<string, unknown> = {};
  const messageExtras: Record<string, unknown> = {};

  for await (const chunk of chunks) {
    const errorMessage = chatCompletionsErrorPayloadMessage(chunk);
    if (errorMessage) {
      throw new Error(`Upstream Chat Completions SSE error: ${errorMessage}`);
    }

    if (!id && chunk.id) {
      id = chunk.id as string;
      model = chunk.model as string;
      created = chunk.created as number;
    }

    if (!systemFingerprint && typeof chunk.system_fingerprint === 'string' && chunk.system_fingerprint) {
      systemFingerprint = chunk.system_fingerprint;
    }
    if (!serviceTier && typeof chunk.service_tier === 'string' && chunk.service_tier) {
      serviceTier = chunk.service_tier;
    }

    if (chunk.usage) {
      lastUsage = chunk.usage as ChatCompletionsResult['usage'];
    }

    captureExtras(chunk as unknown as Record<string, unknown>, KNOWN_CHUNK_KEYS, chunkExtras);

    const choices = chunk.choices as unknown as Array<Record<string, unknown>> | undefined;
    if (!choices) continue;

    for (const choice of choices) {
      captureExtras(choice, KNOWN_CHOICE_KEYS, choiceExtras);

      const delta = choice.delta as Record<string, unknown> | undefined;
      if (delta) {
        captureExtras(delta, KNOWN_DELTA_KEYS, messageExtras);

        if (typeof delta.content === 'string') {
          content += delta.content;
        }
        if (typeof delta.reasoning_text === 'string') {
          reasoningText += delta.reasoning_text;
        }
        if (typeof delta.reasoning_opaque === 'string') {
          reasoningOpaque += delta.reasoning_opaque;
          hasReasoningOpaque = true;
        }
        if (Array.isArray(delta.reasoning_items)) {
          reasoningItems.push(...(delta.reasoning_items as ChatCompletionsReasoningItem[]));
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const toolCall of delta.tool_calls as Array<Record<string, unknown>>) {
            const idx = toolCall.index as number;
            const existing = toolCallsMap.get(idx);
            if (!existing) {
              toolCallsMap.set(idx, {
                id: (toolCall.id as string) ?? '',
                name: ((toolCall.function as Record<string, unknown>)?.name as string) ?? '',
                arguments: ((toolCall.function as Record<string, unknown>)?.arguments as string) ?? '',
              });
            } else {
              if (toolCall.id) existing.id = toolCall.id as string;
              const fn = toolCall.function as Record<string, unknown> | undefined;
              if (fn?.name) existing.name = fn.name as string;
              if (fn?.arguments) {
                existing.arguments += fn.arguments as string;
              }
            }
          }
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason as ChatCompletionsResult['choices'][number]['finish_reason'];
      }
    }
  }

  const toolCalls: ChatCompletionsToolCall[] = [];
  const sortedIndices = [...toolCallsMap.keys()].sort((a, b) => a - b);
  for (const idx of sortedIndices) {
    const toolCall = toolCallsMap.get(idx)!;
    toolCalls.push({
      id: toolCall.id,
      type: 'function',
      function: { name: toolCall.name, arguments: toolCall.arguments },
    });
  }

  const message = {
    role: 'assistant' as const,
    content: content || null,
    ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
    ...(reasoningText && { reasoning_text: reasoningText }),
    ...(hasReasoningOpaque ? { reasoning_opaque: reasoningOpaque } : {}),
    ...(reasoningItems.length > 0 && { reasoning_items: reasoningItems }),
    ...messageExtras,
  };

  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
        ...choiceExtras,
      },
    ],
    ...(systemFingerprint && { system_fingerprint: systemFingerprint }),
    ...(serviceTier && { service_tier: serviceTier }),
    ...(lastUsage && { usage: lastUsage }),
    ...chunkExtras,
  } as ChatCompletionsResult;
}
