import type { SseFrame, StreamFrame } from '../../shared/stream/types.ts';

export interface ParseTargetStreamFramesOptions {
  protocol: string;
  malformedJsonEventName?: string;
}

export type ParsedTargetStreamFrame<TJson> = { type: 'json'; data: TJson } | { type: 'done' } | { type: 'sse-json'; data: unknown; frame: SseFrame };

export const parseTargetStreamFrames = async function* <TJson>(frames: AsyncIterable<StreamFrame<TJson>>, options: ParseTargetStreamFramesOptions): AsyncGenerator<ParsedTargetStreamFrame<TJson>> {
  for await (const frame of frames) {
    if (frame.type === 'json') {
      yield { type: 'json', data: frame.data };
      continue;
    }

    const data = frame.data.trim();
    if (!data) continue;
    if (data === '[DONE]') {
      yield { type: 'done' };
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch (error) {
      const eventName = frame.event ?? options.malformedJsonEventName;
      const eventContext = eventName ? ` for event "${eventName}"` : '';
      throw new Error(`Malformed upstream ${options.protocol} SSE JSON${eventContext}: ${data}`, { cause: error });
    }

    yield { type: 'sse-json', data: parsed, frame };
  }
};
