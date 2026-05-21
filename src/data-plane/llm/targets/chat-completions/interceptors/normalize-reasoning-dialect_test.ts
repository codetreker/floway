import { test } from 'vitest';

import { withDeepseekReasoningDialect } from './normalize-reasoning-dialect.ts';
import { chatCompletionsExchangeContext, testTelemetryModelIdentity } from './test-helpers.ts';
import { assertEquals } from '../../../../../test-assert.ts';
import type { ChatCompletionChunk, ChatCompletionResponse, ChatCompletionsPayload } from '../../../../shared/protocol/chat-completions.ts';
import type { ChatCompletionsExchangeResult } from '../../../interceptors.ts';
import { eventResult } from '../../../shared/errors/result.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '../../../shared/stream/types.ts';
import { chatCompletionResultToEvents } from '../events/from-result.ts';

type DeepseekReasoningDelta = ChatCompletionChunk['choices'][number]['delta'] & {
  reasoning_content?: string;
};

const baseRequest = (): ChatCompletionsPayload => ({
  model: 'deepseek-reasoner',
  messages: [
    { role: 'user', content: 'first turn' },
    {
      role: 'assistant',
      content: null,
      reasoning_text: 'let me check the docs',
      reasoning_opaque: 'opaque-blob',
      reasoning_items: [{ type: 'reasoning', summary: [] }],
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'lookup', arguments: '{}' },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'result',
    },
    { role: 'user', content: 'next turn' },
  ],
});

const exchangeCtx = (payload: ChatCompletionsPayload = baseRequest()): ReturnType<typeof chatCompletionsExchangeContext> =>
  chatCompletionsExchangeContext(payload, new Set(['deepseek-reasoning-dialect']));

const collectFrames = async (result: ChatCompletionsExchangeResult): Promise<ProtocolFrame<ChatCompletionChunk>[]> => {
  if (result.type !== 'events') throw new Error('expected events result');
  const out: ProtocolFrame<ChatCompletionChunk>[] = [];
  for await (const frame of result.events) out.push(frame);
  return out;
};

test('withDeepseekReasoningDialect renames outbound reasoning_text on a deepseek upstream', async () => {
  const ctx = exchangeCtx();

  let observed: ChatCompletionsPayload | null = null;
  await withDeepseekReasoningDialect(ctx, () => {
    observed = ctx.payload;
    return Promise.resolve(
      eventResult(
        (async function* () {
          yield* [];
        })(),
        testTelemetryModelIdentity,
      ),
    );
  });

  const assistant = observed!.messages[1] as unknown as Record<string, unknown>;
  assertEquals(assistant.reasoning_content, 'let me check the docs');
  assertEquals(assistant.reasoning_text, undefined);
  assertEquals(assistant.reasoning_opaque, undefined);
  assertEquals(assistant.reasoning_items, undefined);
  // Non-reasoning fields stay intact so the tool-call replay still works.
  assertEquals((assistant.tool_calls as unknown[]).length, 1);
});

test('withDeepseekReasoningDialect synthesizes reasoning_content from reasoning_items when reasoning_text is absent', async () => {
  const ctx = exchangeCtx({
    model: 'deepseek-reasoner',
    messages: [
      { role: 'user', content: 'first turn' },
      {
        role: 'assistant',
        content: null,
        reasoning_items: [
          {
            type: 'reasoning',
            id: 'rs_1',
            summary: [
              { type: 'summary_text', text: 'step one. ' },
              { type: 'summary_text', text: 'step two.' },
            ],
            encrypted_content: 'opaque-blob',
          },
        ],
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'result' },
    ],
  });

  let observed: ChatCompletionsPayload | null = null;
  await withDeepseekReasoningDialect(ctx, () => {
    observed = ctx.payload;
    return Promise.resolve(
      eventResult(
        (async function* () {
          yield* [];
        })(),
        testTelemetryModelIdentity,
      ),
    );
  });

  const assistant = observed!.messages[1] as unknown as Record<string, unknown>;
  assertEquals(assistant.reasoning_content, 'step one. step two.');
  assertEquals(assistant.reasoning_text, undefined);
  assertEquals(assistant.reasoning_opaque, undefined);
  assertEquals(assistant.reasoning_items, undefined);
});

test('withDeepseekReasoningDialect strips reasoning_items even when no summaries are available', async () => {
  const ctx = exchangeCtx({
    model: 'deepseek-reasoner',
    messages: [
      { role: 'user', content: 'first turn' },
      {
        role: 'assistant',
        content: 'answer',
        reasoning_items: [
          {
            type: 'reasoning',
            encrypted_content: 'opaque-only',
          },
        ],
        reasoning_opaque: 'opaque-chain',
      },
    ],
  });

  let observed: ChatCompletionsPayload | null = null;
  await withDeepseekReasoningDialect(ctx, () => {
    observed = ctx.payload;
    return Promise.resolve(
      eventResult(
        (async function* () {
          yield* [];
        })(),
        testTelemetryModelIdentity,
      ),
    );
  });

  const assistant = observed!.messages[1] as unknown as Record<string, unknown>;
  assertEquals(assistant.reasoning_content, undefined);
  assertEquals(assistant.reasoning_items, undefined);
  assertEquals(assistant.reasoning_opaque, undefined);
  assertEquals(assistant.content, 'answer');
});

test('withDeepseekReasoningDialect renames inbound protocol reasoning_content deltas', async () => {
  const ctx = exchangeCtx();
  const upstreamChunk: ChatCompletionChunk = {
    id: 'chunk_1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'deepseek-reasoner',
    choices: [
      {
        index: 0,
        delta: { reasoning_content: 'thinking...' } as DeepseekReasoningDelta,
        finish_reason: null,
      },
    ],
  };

  const result = await withDeepseekReasoningDialect(ctx, () =>
    Promise.resolve(
      eventResult(
        (async function* () {
          yield eventFrame(upstreamChunk);
        })(),
        testTelemetryModelIdentity,
      ),
    ));

  const frames = await collectFrames(result);
  assertEquals(frames.length, 1);
  const frame = frames[0];
  if (frame.type !== 'event') throw new Error('expected event frame');
  const delta = frame.event.choices[0].delta as Record<string, unknown>;
  assertEquals(delta.reasoning_text, 'thinking...');
  assertEquals(delta.reasoning_content, undefined);
});

test('withDeepseekReasoningDialect preserves reasoning_content from non-stream JSON responses', async () => {
  const ctx = exchangeCtx();
  const upstreamResponse: ChatCompletionResponse = {
    id: 'chatcmpl_deepseek_json',
    object: 'chat.completion',
    created: 1,
    model: 'deepseek-reasoner',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'answer',
          reasoning_text: null,
          reasoning_content: 'json thinking',
        } as unknown as ChatCompletionResponse['choices'][number]['message'],
        finish_reason: 'stop',
      },
    ],
  };

  const result = await withDeepseekReasoningDialect(ctx, () =>
    Promise.resolve(
      eventResult(
        (async function* () {
          yield* chatCompletionResultToEvents(upstreamResponse);
        })(),
        testTelemetryModelIdentity,
      ),
    ));

  const frames = await collectFrames(result);
  const reasoningFrame = frames.find(frame => frame.type === 'event' && frame.event.choices[0]?.delta.reasoning_text !== undefined);

  assertEquals(reasoningFrame?.type === 'event' ? reasoningFrame.event.choices[0]?.delta.reasoning_text : undefined, 'json thinking');
});

test('withDeepseekReasoningDialect leaves protocol done frames untouched', async () => {
  const ctx = exchangeCtx();
  const done = doneFrame();

  const result = await withDeepseekReasoningDialect(ctx, () =>
    Promise.resolve(
      eventResult(
        (async function* () {
          yield done;
        })(),
        testTelemetryModelIdentity,
      ),
    ));

  assertEquals(await collectFrames(result), [done]);
});
