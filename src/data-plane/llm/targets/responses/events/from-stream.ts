import { responsesResultToEvents, type SequencedResponseStreamEvent } from './from-result.ts';
import type { ResponsesResult, ResponseStreamEvent } from '../../../../shared/protocol/responses.ts';
import { doneFrame, eventFrame, type ProtocolFrame, type StreamFrame } from '../../../shared/stream/types.ts';
import { parseTargetStreamFrames } from '../../events/from-stream.ts';

export const responsesStreamFramesToEvents = (frames: AsyncIterable<StreamFrame<ResponsesResult>>): AsyncGenerator<ProtocolFrame<SequencedResponseStreamEvent>> =>
  (async function* () {
    for await (const frame of parseTargetStreamFrames<ResponsesResult>(frames, {
      protocol: 'Responses',
      malformedJsonEventName: 'response',
    })) {
      if (frame.type === 'json') {
        yield* responsesResultToEvents(frame.data);
      } else if (frame.type === 'done') {
        yield doneFrame();
      } else {
        const event = frame.data as ResponseStreamEvent;
        yield eventFrame(
          frame.frame.event && !(event as { type?: string }).type
            ? ({
                ...event,
                type: frame.frame.event,
              } as SequencedResponseStreamEvent)
            : (event as SequencedResponseStreamEvent),
        );
      }
    }
  })();
