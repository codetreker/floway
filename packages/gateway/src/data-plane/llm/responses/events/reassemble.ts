import type { ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

type ResponsesReassembleEvent =
  | ResponsesStreamEvent
  | {
    type: 'error';
    message?: string;
  };

export async function reassembleResponsesEvents(events: AsyncIterable<ResponsesReassembleEvent>): Promise<ResponsesResult> {
  for await (const event of events) {
    const rawEvent = event as unknown as Record<string, unknown>;
    const type = rawEvent.type as string;

    if (type === 'error') {
      const message = (rawEvent.message as string | undefined) ?? JSON.stringify(event);
      throw new Error(`Upstream SSE error: ${message}`);
    }

    if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
      return rawEvent.response as ResponsesResult;
    }
  }

  throw new Error('SSE stream ended without a terminal response event');
}
