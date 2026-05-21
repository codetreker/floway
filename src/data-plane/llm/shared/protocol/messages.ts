import type { MessagesResponse, MessagesStreamEventData } from '../../../shared/protocol/messages.ts';
import { type EventFrame, eventFrame } from '../stream/types.ts';

export const messagesResultToEvents = (response: MessagesResponse): EventFrame<MessagesStreamEventData>[] => {
  const frames: EventFrame<MessagesStreamEventData>[] = [
    eventFrame({
      type: 'message_start',
      message: {
        id: response.id,
        type: response.type,
        role: response.role,
        content: [],
        model: response.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          ...response.usage,
          output_tokens: 0,
        },
      },
    }),
  ];

  response.content.forEach((block, index) => {
    if (block.type === 'text') {
      frames.push(
        eventFrame({
          type: 'content_block_start',
          index,
          content_block: {
            type: 'text',
            text: '',
            ...(block.citations?.length ? { citations: [] } : {}),
          },
        }),
      );

      for (const citation of block.citations ?? []) {
        frames.push(
          eventFrame({
            type: 'content_block_delta',
            index,
            delta: {
              type: 'citations_delta',
              citation,
            },
          }),
        );
      }

      if (block.text.length > 0) {
        frames.push(
          eventFrame({
            type: 'content_block_delta',
            index,
            delta: { type: 'text_delta', text: block.text },
          }),
        );
      }

      frames.push(eventFrame({ type: 'content_block_stop', index }));
      return;
    }

    if (block.type === 'tool_use') {
      frames.push(
        eventFrame({
          type: 'content_block_start',
          index,
          content_block: {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: {},
          },
        }),
      );
      frames.push(
        eventFrame({
          type: 'content_block_delta',
          index,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify(block.input),
          },
        }),
      );
      frames.push(eventFrame({ type: 'content_block_stop', index }));
      return;
    }

    if (block.type === 'server_tool_use') {
      frames.push(
        eventFrame({
          type: 'content_block_start',
          index,
          content_block: {
            type: 'server_tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          },
        }),
      );
      frames.push(eventFrame({ type: 'content_block_stop', index }));
      return;
    }

    if (block.type === 'web_search_tool_result') {
      frames.push(
        eventFrame({
          type: 'content_block_start',
          index,
          content_block: {
            type: 'web_search_tool_result',
            tool_use_id: block.tool_use_id,
            content: block.content,
          },
        }),
      );
      frames.push(eventFrame({ type: 'content_block_stop', index }));
      return;
    }

    if (block.type === 'thinking') {
      frames.push(
        eventFrame({
          type: 'content_block_start',
          index,
          content_block: { type: 'thinking', thinking: '' },
        }),
      );

      if (block.thinking.length > 0) {
        frames.push(
          eventFrame({
            type: 'content_block_delta',
            index,
            delta: { type: 'thinking_delta', thinking: block.thinking },
          }),
        );
      }

      if (typeof block.signature === 'string') {
        frames.push(
          eventFrame({
            type: 'content_block_delta',
            index,
            delta: { type: 'signature_delta', signature: block.signature },
          }),
        );
      }

      frames.push(eventFrame({ type: 'content_block_stop', index }));
      return;
    }

    frames.push(
      eventFrame({
        type: 'content_block_start',
        index,
        content_block: { type: 'redacted_thinking', data: block.data },
      }),
    );
    frames.push(eventFrame({ type: 'content_block_stop', index }));
  });

  frames.push(
    eventFrame({
      type: 'message_delta',
      delta: {
        stop_reason: response.stop_reason,
        stop_sequence: response.stop_sequence,
      },
      usage: {
        output_tokens: response.usage.output_tokens,
        ...(response.usage.cache_creation_input_tokens !== undefined
          ? {
              cache_creation_input_tokens: response.usage.cache_creation_input_tokens,
            }
          : {}),
        ...(response.usage.cache_read_input_tokens !== undefined ? { cache_read_input_tokens: response.usage.cache_read_input_tokens } : {}),
        ...(response.usage.server_tool_use !== undefined ? { server_tool_use: response.usage.server_tool_use } : {}),
      },
    }),
    eventFrame({ type: 'message_stop' }),
  );

  return frames;
};
