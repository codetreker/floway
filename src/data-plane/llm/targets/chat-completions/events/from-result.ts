import type { ChatCompletionChunk, ChatCompletionResponse } from '../../../../shared/protocol/chat-completions.ts';
import { type DoneFrame, doneFrame, type EventFrame, eventFrame } from '../../../shared/stream/types.ts';

interface ChatCompletionResultToEventsOptions {
  includeUsageChunk?: boolean;
}

type ResultChoice = ChatCompletionResponse['choices'][number];
type ChunkChoice = ChatCompletionChunk['choices'][number];
type Delta = ChunkChoice['delta'];
type DeepseekResultMessage = ResultChoice['message'] & {
  reasoning_content?: unknown;
};
type DeepseekReasoningDelta = Delta & { reasoning_content?: string };

const makeChunk = (response: ChatCompletionResponse, choices: ChunkChoice[]): ChatCompletionChunk => ({
  id: response.id,
  object: 'chat.completion.chunk',
  created: response.created,
  model: response.model,
  choices,
});

const makeChoice = (choice: ResultChoice, delta: Delta, finishReason: ChunkChoice['finish_reason'] = null): ChunkChoice => ({
  index: choice.index,
  delta,
  finish_reason: finishReason,
});

const pushDeltaChunk = (frames: Array<EventFrame<ChatCompletionChunk> | DoneFrame>, response: ChatCompletionResponse, choices: ChunkChoice[]): void => {
  if (choices.length) frames.push(eventFrame(makeChunk(response, choices)));
};

export const chatCompletionResultToEvents = (response: ChatCompletionResponse, options: ChatCompletionResultToEventsOptions = {}): Array<EventFrame<ChatCompletionChunk> | DoneFrame> => {
  const includeUsageChunk = options.includeUsageChunk ?? true;
  const frames: Array<EventFrame<ChatCompletionChunk> | DoneFrame> = [
    eventFrame(
      makeChunk(
        response,
        response.choices.map(choice => makeChoice(choice, { role: 'assistant' })),
      ),
    ),
  ];

  pushDeltaChunk(
    frames,
    response,
    response.choices.flatMap(choice =>
      // Preserve the legacy DeepSeek scalar through JSON-to-protocol
      // projection so the dialect interceptor can normalize it like SSE.
      (choice.message.reasoning_text === undefined || choice.message.reasoning_text === null) &&
      (choice.message as DeepseekResultMessage).reasoning_content !== undefined &&
      typeof (choice.message as DeepseekResultMessage).reasoning_content === 'string'
        ? [
            makeChoice(choice, {
              reasoning_content: (choice.message as DeepseekResultMessage).reasoning_content,
            } as DeepseekReasoningDelta),
          ]
        : []),
  );

  pushDeltaChunk(
    frames,
    response,
    response.choices.flatMap(choice =>
      choice.message.reasoning_text !== undefined && choice.message.reasoning_text !== null ? [makeChoice(choice, { reasoning_text: choice.message.reasoning_text })] : []),
  );

  pushDeltaChunk(
    frames,
    response,
    response.choices.flatMap(choice =>
      choice.message.reasoning_opaque !== undefined && choice.message.reasoning_opaque !== null
        ? [
            makeChoice(choice, {
              reasoning_opaque: choice.message.reasoning_opaque,
            }),
          ]
        : []),
  );

  pushDeltaChunk(
    frames,
    response,
    response.choices.flatMap(choice =>
      choice.message.reasoning_items?.length
        ? [
            makeChoice(choice, {
              reasoning_items: choice.message.reasoning_items,
            }),
          ]
        : []),
  );

  pushDeltaChunk(
    frames,
    response,
    response.choices.flatMap(choice => (choice.message.content !== undefined && choice.message.content !== null ? [makeChoice(choice, { content: choice.message.content })] : [])),
  );

  response.choices.forEach(choice => {
    choice.message.tool_calls?.forEach((toolCall, index) => {
      frames.push(
        eventFrame(
          makeChunk(response, [
            makeChoice(choice, {
              tool_calls: [
                {
                  index,
                  id: toolCall.id,
                  type: toolCall.type,
                  function: toolCall.function,
                },
              ],
            }),
          ]),
        ),
      );
    });
  });

  frames.push(
    eventFrame(
      makeChunk(
        response,
        response.choices.map(choice => makeChoice(choice, {}, choice.finish_reason)),
      ),
    ),
  );

  if (includeUsageChunk && response.usage) {
    frames.push(
      eventFrame({
        id: response.id,
        object: 'chat.completion.chunk',
        created: response.created,
        model: response.model,
        choices: [],
        usage: response.usage,
      }),
    );
  }

  frames.push(doneFrame());
  return frames;
};
