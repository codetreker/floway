import type { MessagesStreamEventData, MessagesTextCitation } from '../../../../shared/protocol/messages.ts';
import { type ProtocolFrame, type SseFrame, sseFrame } from '../../../shared/stream/types.ts';

const citationToSsePayload = (citation: MessagesTextCitation): unknown =>
  citation.type === 'search_result_location'
    ? {
        type: citation.type,
        source: citation.url,
        title: citation.title,
        search_result_index: citation.search_result_index,
        start_block_index: citation.start_block_index,
        end_block_index: citation.end_block_index,
        ...(citation.cited_text ? { cited_text: citation.cited_text } : {}),
      }
    : citation;

const citationsToSsePayload = (citations?: MessagesTextCitation[]): unknown[] | undefined => citations?.map(citationToSsePayload);

const messagesEventToSsePayload = (event: MessagesStreamEventData): unknown => {
  if (event.type === 'content_block_start') {
    const { content_block } = event;
    return content_block.type === 'text' && content_block.citations
      ? {
          ...event,
          content_block: {
            ...content_block,
            citations: citationsToSsePayload(content_block.citations),
          },
        }
      : event;
  }

  if (event.type !== 'content_block_delta') return event;

  const { delta } = event;
  if (delta.type === 'citations_delta') {
    return {
      ...event,
      delta: {
        ...delta,
        citation: citationToSsePayload(delta.citation),
      },
    };
  }

  if (delta.type === 'text_delta' && delta.citations) {
    return {
      ...event,
      delta: {
        ...delta,
        citations: citationsToSsePayload(delta.citations),
      },
    };
  }

  return event;
};

export const messagesProtocolFrameToSSEFrame = (frame: ProtocolFrame<MessagesStreamEventData>): SseFrame | null =>
  frame.type === 'event' ? sseFrame(JSON.stringify(messagesEventToSsePayload(frame.event)), frame.event.type) : null;
