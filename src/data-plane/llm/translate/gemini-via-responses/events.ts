import { geminiResponse, mapTerminalFinishReason, mapUsage } from './result.ts';
import type { GeminiPart, GeminiStreamEvent } from '../../../shared/protocol/gemini.ts';
import type { ResponseOutputFunctionCall, ResponseOutputReasoning, ResponseStreamEvent } from '../../../shared/protocol/responses.ts';
import { eventFrame, type ProtocolFrame } from '../../shared/stream/types.ts';
import { appendGeminiThoughtSignature, flushGeminiThoughtSignature, type GeminiThoughtSignatureState, parseStrictJsonObject, signGeminiPart } from '../shared/gemini.ts';

const UPSTREAM_RESPONSES_MISSING_TERMINAL_MESSAGE = 'Upstream Responses stream ended without a terminal event.';

const upstreamResponsesEventsUntilTerminal = async function* (frames: AsyncIterable<ProtocolFrame<ResponseStreamEvent>>): AsyncGenerator<ResponseStreamEvent> {
  for await (const frame of frames) {
    if (frame.type === 'done') continue;

    yield frame.event;
    if (frame.event.type === 'response.completed' || frame.event.type === 'response.incomplete' || frame.event.type === 'response.failed' || frame.event.type === 'error') {
      return;
    }
  }

  throw new Error(UPSTREAM_RESPONSES_MISSING_TERMINAL_MESSAGE);
};

type ResponseTerminalEvent = Extract<ResponseStreamEvent, { type: 'response.completed' } | { type: 'response.incomplete' } | { type: 'response.failed' }>;

type ResponseEvent<T extends string> = Extract<ResponseStreamEvent, { type: T }>;

interface ResponseFunctionCallDraft {
  id?: string;
  name?: string;
  argsJson: string;
}

interface GeminiViaResponsesStreamState extends GeminiThoughtSignatureState {
  functionCalls: Map<number, ResponseFunctionCallDraft>;
  emittedReasoningKeys: Set<string>;
  emittedTextKeys: Set<string>;
}

const responsePartKey = (outputIndex: number, partIndex: number): string => `${outputIndex}:${partIndex}`;

const emitTextPart = (part: GeminiPart, state: GeminiViaResponsesStreamState): ProtocolFrame<GeminiStreamEvent> => eventFrame(geminiResponse([signGeminiPart(state, part)]));

const reasoningItemDoneFrames = function* (item: ResponseOutputReasoning, outputIndex: number, state: GeminiViaResponsesStreamState): Generator<ProtocolFrame<GeminiStreamEvent>> {
  for (const [summaryIndex, part] of item.summary.entries()) {
    const key = responsePartKey(outputIndex, summaryIndex);
    if (!part.text || state.emittedReasoningKeys.has(key)) continue;

    state.emittedReasoningKeys.add(key);
    yield eventFrame(geminiResponse([{ text: part.text, thought: true }]));
  }

  if (item.encrypted_content !== undefined) {
    appendGeminiThoughtSignature(state, item.encrypted_content);
  }
};

const functionCallDoneFrame = (item: ResponseOutputFunctionCall, outputIndex: number, state: GeminiViaResponsesStreamState): ProtocolFrame<GeminiStreamEvent> => {
  const current = state.functionCalls.get(outputIndex);
  state.functionCalls.delete(outputIndex);

  const draft = current ?? {
    id: item.call_id,
    name: item.name,
    argsJson: item.arguments,
  };
  const argsJson = current?.argsJson ?? item.arguments;

  if (!draft.name) {
    throw new Error('Responses function call ended without a name.');
  }

  return emitTextPart(
    {
      functionCall: {
        ...(draft.id !== undefined ? { id: draft.id } : {}),
        name: draft.name,
        args: argsJson ? parseStrictJsonObject(argsJson, 'Responses function call arguments') : {},
      },
    },
    state,
  );
};

const handleTerminal = (event: ResponseTerminalEvent, state: GeminiViaResponsesStreamState): ProtocolFrame<GeminiStreamEvent> =>
  eventFrame(geminiResponse(flushGeminiThoughtSignature(state), mapTerminalFinishReason(event), mapUsage(event.response.usage)));

export const translateToSourceEvents = async function* (frames: AsyncIterable<ProtocolFrame<ResponseStreamEvent>>): AsyncGenerator<ProtocolFrame<GeminiStreamEvent>> {
  const state: GeminiViaResponsesStreamState = {
    functionCalls: new Map(),
    emittedReasoningKeys: new Set(),
    emittedTextKeys: new Set(),
  };

  for await (const event of upstreamResponsesEventsUntilTerminal(frames)) {
    switch (event.type) {
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_summary_text.done': {
      const textEvent = event as ResponseEvent<'response.reasoning_summary_text.delta'> | ResponseEvent<'response.reasoning_summary_text.done'>;
      const text = textEvent.type === 'response.reasoning_summary_text.delta' ? textEvent.delta : textEvent.text;
      if (!text) break;

      const key = responsePartKey(textEvent.output_index, textEvent.summary_index);
      if (textEvent.type === 'response.reasoning_summary_text.done' && state.emittedReasoningKeys.has(key)) break;

      state.emittedReasoningKeys.add(key);
      yield eventFrame(geminiResponse([{ text, thought: true }]));
      break;
    }

    case 'response.output_text.delta':
    case 'response.output_text.done': {
      const textEvent = event as ResponseEvent<'response.output_text.delta'> | ResponseEvent<'response.output_text.done'>;
      const text = textEvent.type === 'response.output_text.delta' ? textEvent.delta : textEvent.text;
      if (!text) break;

      const key = responsePartKey(textEvent.output_index, textEvent.content_index);
      if (textEvent.type === 'response.output_text.done' && state.emittedTextKeys.has(key)) break;

      state.emittedTextKeys.add(key);
      yield emitTextPart({ text }, state);
      break;
    }

    case 'response.output_item.added': {
      const addedEvent = event as ResponseEvent<'response.output_item.added'>;
      if (addedEvent.item.type === 'function_call') {
        state.functionCalls.set(addedEvent.output_index, {
          id: addedEvent.item.call_id,
          name: addedEvent.item.name,
          argsJson: addedEvent.item.arguments,
        });
      }
      break;
    }

    case 'response.function_call_arguments.delta': {
      const deltaEvent = event as ResponseEvent<'response.function_call_arguments.delta'>;
      const current = state.functionCalls.get(deltaEvent.output_index);
      if (current) current.argsJson += deltaEvent.delta;
      break;
    }

    case 'response.function_call_arguments.done': {
      const doneEvent = event as ResponseEvent<'response.function_call_arguments.done'>;
      const current = state.functionCalls.get(doneEvent.output_index);
      if (current) current.argsJson = doneEvent.arguments;
      break;
    }

    case 'response.output_item.done': {
      const doneEvent = event as ResponseEvent<'response.output_item.done'>;
      if (doneEvent.item.type === 'reasoning') {
        yield* reasoningItemDoneFrames(doneEvent.item, doneEvent.output_index, state);
      } else if (doneEvent.item.type === 'function_call') {
        yield functionCallDoneFrame(doneEvent.item, doneEvent.output_index, state);
      }
      break;
    }

    case 'response.completed':
    case 'response.incomplete':
    case 'response.failed':
      yield handleTerminal(event as ResponseTerminalEvent, state);
      break;

    case 'error': {
      const errorEvent = event as ResponseEvent<'error'>;
      throw new Error(`Upstream Responses stream error: ${errorEvent.message}`, { cause: errorEvent });
    }

    default:
      break;
    }
  }
};
