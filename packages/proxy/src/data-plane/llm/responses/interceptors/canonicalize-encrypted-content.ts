import type { ResponsesInterceptor } from './types.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { type ExecuteResult, eventResult } from '@floway-dev/provider';

// Some upstreams (e.g. Azure) re-encrypt `encrypted_content` on every
// serialization, so an item's `output_item.done` blob differs byte-wise from
// its `response.completed` copy (same plaintext, fresh IV). Codex trusts the
// done frame, the OpenAI SDKs the completed frame; we pin both to the done blob
// so a single value reaches every consumer. Attached to every Responses target.

const itemId = (item: { id?: unknown }): string | null => {
  const id = item.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
};

const canonicalizeEncryptedContent = async function* (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  const canonical = new Map<string, string>();

  for await (const frame of frames) {
    if (frame.type !== 'event') {
      yield frame;
      continue;
    }
    const event = frame.event;

    if (event.type === 'response.output_item.done') {
      const id = itemId(event.item);
      const value = (event.item as { encrypted_content?: unknown }).encrypted_content;
      const encryptedContent = typeof value === 'string' && value.length > 0 ? value : null;
      if (id !== null && encryptedContent !== null) canonical.set(id, encryptedContent);
      yield frame;
      continue;
    }

    if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      const output = event.response.output.map(item => {
        const id = itemId(item);
        const replacement = id === null ? undefined : canonical.get(id);
        return replacement === undefined ? item : { ...item, encrypted_content: replacement };
      });
      yield eventFrame({ ...event, response: { ...event.response, output: output as typeof event.response.output } });
      continue;
    }

    yield frame;
  }
};

export const withReasoningEncryptedContentCanonicalized: ResponsesInterceptor = async (_ctx, _request, run) => {
  const result: ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> = await run();
  if (result.type !== 'events') return result;

  return eventResult(canonicalizeEncryptedContent(result.events), result.modelIdentity, result.performance, result.finalMetadata);
};
