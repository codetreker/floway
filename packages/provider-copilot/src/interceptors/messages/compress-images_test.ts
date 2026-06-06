import { test } from 'vitest';

import { claudeImageCaps, withInlineImagesCompressed } from './compress-images.ts';
import type { MessagesBoundaryCtx } from './types.ts';
import { fitWithin, type ImageDimensions, type ImageProcessor, initImageProcessor } from '@floway-dev/platform';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubUpstreamModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {})(), testTelemetryModelIdentity));

// Records the bytes and resolved target dimensions handed to the processor and
// returns a fixed [1,2,3] WebP payload, which base64-encodes to "AQID".
const spyProcessor = (): { processor: ImageProcessor; inputs: Uint8Array[]; targets: (ImageDimensions | null)[] } => {
  const inputs: Uint8Array[] = [];
  const targets: (ImageDimensions | null)[] = [];
  const processor: ImageProcessor = {
    compressToWebp(input, target) {
      inputs.push(input);
      targets.push(target);
      return Promise.resolve(new Uint8Array([1, 2, 3]));
    },
  };
  return { processor, inputs, targets };
};

const invocation = (payload: MessagesPayload, upstreamModelId = 'claude-test'): MessagesBoundaryCtx => ({
  payload,
  headers: {},
  model: stubUpstreamModel({ id: upstreamModelId, endpoints: { messages: {} } }),
});

test('compresses a top-level image block to WebP', async () => {
  const { processor, inputs } = spyProcessor();
  initImageProcessor(processor);

  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      },
    ],
  });

  await withInlineImagesCompressed(ctx, stubRequest, okEvents);

  const block = (ctx.payload.messages[0].content as Array<{ type: string; source?: { media_type: string; data: string } }>)[1];
  assertEquals(block.source?.media_type, 'image/webp');
  assertEquals(block.source?.data, 'AQID');
  // "AAAA" decodes to three zero bytes.
  assertEquals([...inputs[0]], [0, 0, 0]);
});

test('compresses an image nested inside tool_result content', async () => {
  const { processor } = spyProcessor();
  initImageProcessor(processor);

  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_image',
            content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
          },
        ],
      },
    ],
  });

  await withInlineImagesCompressed(ctx, stubRequest, okEvents);

  const toolResult = (ctx.payload.messages[0].content as Array<{ content: Array<{ source?: { media_type: string; data: string } }> }>)[0];
  assertEquals(toolResult.content[0].source?.media_type, 'image/webp');
  assertEquals(toolResult.content[0].source?.data, 'AQID');
});

test('leaves image-free payloads untouched and does not invoke the processor', async () => {
  const { processor, inputs } = spyProcessor();
  initImageProcessor(processor);

  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'plain' }] }],
  });

  await withInlineImagesCompressed(ctx, stubRequest, okEvents);

  assertEquals(inputs.length, 0);
});

test('selects the high-res Claude cap for Opus >= 4.7 and the standard cap otherwise', () => {
  const probe = { width: 3000, height: 3000 };
  // Opus 4.7 / 4.8 (and future Opus): ~3.59 MP area cap -> sqrt(3_588_000/9e6) -> 1894.
  for (const id of ['claude-opus-4.7', 'claude-opus-4.8', 'claude-opus-4.7-high', 'claude-opus-5']) {
    assertEquals(fitWithin(probe, claudeImageCaps(id)), { width: 1894, height: 1894 });
  }
  // Opus 4.5 / 4.6 + sonnet/haiku: standard ~1.18 MP cap -> sqrt(1_176_000/9e6) -> 1084.
  for (const id of ['claude-opus-4.5', 'claude-opus-4.6', 'claude-sonnet-4.6', 'claude-haiku-4.5']) {
    assertEquals(fitWithin(probe, claudeImageCaps(id)), { width: 1084, height: 1084 });
  }
});

test('high-res Opus clamps the long edge to 2576 on very wide images', () => {
  // 8000x1000: long-edge factor 2576/8000=0.322 is tighter than the area
  // factor sqrt(3_588_000/8e6)=0.67, so the long edge binds -> 2576x322.
  assertEquals(fitWithin({ width: 8000, height: 1000 }, claudeImageCaps('claude-opus-4.7')), { width: 2576, height: 322 });
});
