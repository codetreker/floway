import type { MessagesResponse, MessagesStreamEventData } from '../../../../shared/protocol/messages.ts';
import { messagesResultToEvents } from '../../../shared/protocol/messages.ts';
import { doneFrame, eventFrame, type ProtocolFrame, type StreamFrame } from '../../../shared/stream/types.ts';
import { parseTargetStreamFrames } from '../../events/from-stream.ts';

export const messagesStreamFramesToEvents = (frames: AsyncIterable<StreamFrame<MessagesResponse>>): AsyncGenerator<ProtocolFrame<MessagesStreamEventData>> =>
  (async function* () {
    for await (const frame of parseTargetStreamFrames<MessagesResponse>(frames, {
      protocol: 'Messages',
      malformedJsonEventName: 'message',
    })) {
      if (frame.type === 'json') {
        yield* messagesResultToEvents(frame.data);
      } else if (frame.type === 'done') {
        yield doneFrame();
      } else {
        yield eventFrame(frame.data as MessagesStreamEventData);
      }
    }
  })();
