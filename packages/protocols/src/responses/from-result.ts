import type { ResponseOutputCustomToolCall, ResponseOutputFunctionCall, ResponseOutputItem, ResponseOutputMessage, ResponseOutputReasoning, ResponsesResult, ResponseStreamEvent, SequencedResponsesStreamEvent } from './index.ts';
import { type EventFrame, eventFrame } from '../common/index.ts';

const getTerminalEventName = (response: ResponsesResult): string => {
  if (response.status === 'failed') return 'response.failed';
  if (response.status === 'incomplete') return 'response.incomplete';
  if (response.status === 'in_progress') return 'response.in_progress';
  return 'response.completed';
};

const responseStartSnapshot = (response: ResponsesResult): ResponsesResult => {
  const { error: _error, incomplete_details: _incompleteDetails, output: _output, output_text: _outputText, ...snapshot } = response;

  // JSON fallback has no upstream incremental frames, so synthesize the same
  // empty in-progress envelope that a real stream would start with. Emitting
  // terminal output or errors here would duplicate later item/terminal events.
  return {
    ...snapshot,
    status: 'in_progress',
    output: [],
    output_text: '',
  };
};

const responseMessageEvents = (item: ResponseOutputMessage, outputIndex: number): ResponseStreamEvent[] => {
  const itemId = `msg_${outputIndex}`;
  const events: ResponseStreamEvent[] = [
    {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: {
        type: 'message',
        role: 'assistant',
        content: item.content.map(part => (part.type === 'output_text' ? { type: 'output_text', text: '' } : part)),
      },
    },
  ];

  item.content.forEach((part, contentIndex) => {
    if (part.type === 'output_text') {
      events.push({
        type: 'response.content_part.added',
        item_id: itemId,
        output_index: outputIndex,
        content_index: contentIndex,
        part: { type: 'output_text', text: '' },
      });

      if (part.text.length > 0) {
        events.push({
          type: 'response.output_text.delta',
          item_id: itemId,
          output_index: outputIndex,
          content_index: contentIndex,
          delta: part.text,
        });
      }

      events.push({
        type: 'response.output_text.done',
        item_id: itemId,
        output_index: outputIndex,
        content_index: contentIndex,
        text: part.text,
      });
      events.push({
        type: 'response.content_part.done',
        item_id: itemId,
        output_index: outputIndex,
        content_index: contentIndex,
        part,
      });
      return;
    }

    events.push({
      type: 'response.content_part.added',
      item_id: itemId,
      output_index: outputIndex,
      content_index: contentIndex,
      part,
    });
    events.push({
      type: 'response.content_part.done',
      item_id: itemId,
      output_index: outputIndex,
      content_index: contentIndex,
      part,
    });
  });

  events.push({
    type: 'response.output_item.done',
    output_index: outputIndex,
    item,
  });

  return events;
};

const responseReasoningEvents = (item: ResponseOutputReasoning, outputIndex: number): ResponseStreamEvent[] => {
  const events: ResponseStreamEvent[] = [
    {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: {
        type: 'reasoning',
        id: item.id,
        summary: [],
      },
    },
  ];

  item.summary.forEach((part, summaryIndex) => {
    events.push({
      type: 'response.reasoning_summary_part.added',
      item_id: item.id,
      output_index: outputIndex,
      summary_index: summaryIndex,
      part: { type: 'summary_text', text: '' },
    });

    if (part.text.length > 0) {
      events.push({
        type: 'response.reasoning_summary_text.delta',
        item_id: item.id,
        output_index: outputIndex,
        summary_index: summaryIndex,
        delta: part.text,
      });
      events.push({
        type: 'response.reasoning_summary_text.done',
        item_id: item.id,
        output_index: outputIndex,
        summary_index: summaryIndex,
        text: part.text,
      });
    }

    events.push({
      type: 'response.reasoning_summary_part.done',
      item_id: item.id,
      output_index: outputIndex,
      summary_index: summaryIndex,
      part,
    });
  });

  events.push({
    type: 'response.output_item.done',
    output_index: outputIndex,
    item,
  });

  return events;
};

const responseFunctionCallEvents = (item: ResponseOutputFunctionCall, outputIndex: number): ResponseStreamEvent[] => {
  const itemId = `fc_${outputIndex}`;
  const events: ResponseStreamEvent[] = [
    {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: {
        type: 'function_call',
        call_id: item.call_id,
        name: item.name,
        arguments: '',
        status: 'in_progress',
      },
    },
  ];

  if (item.arguments.length > 0) {
    events.push({
      type: 'response.function_call_arguments.delta',
      item_id: itemId,
      output_index: outputIndex,
      delta: item.arguments,
    });
  }

  events.push({
    type: 'response.function_call_arguments.done',
    item_id: itemId,
    output_index: outputIndex,
    arguments: item.arguments,
  });
  events.push({
    type: 'response.output_item.done',
    output_index: outputIndex,
    item,
  });

  return events;
};

const responseCustomToolCallEvents = (item: ResponseOutputCustomToolCall, outputIndex: number): ResponseStreamEvent[] => {
  const itemId = item.id ?? `ctc_${outputIndex}`;
  const events: ResponseStreamEvent[] = [
    {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: { ...item, input: '' },
    },
  ];

  if (item.input.length > 0) {
    events.push({
      type: 'response.custom_tool_call_input.delta',
      item_id: itemId,
      output_index: outputIndex,
      delta: item.input,
    });
  }

  events.push({
    type: 'response.custom_tool_call_input.done',
    item_id: itemId,
    output_index: outputIndex,
    input: item.input,
  });
  events.push({
    type: 'response.output_item.done',
    output_index: outputIndex,
    item,
  });

  return events;
};

const responseOutputItemEvents = (item: ResponseOutputItem, outputIndex: number): ResponseStreamEvent[] => {
  switch (item.type) {
  case 'message': return responseMessageEvents(item, outputIndex);
  case 'reasoning': return responseReasoningEvents(item, outputIndex);
  case 'function_call': return responseFunctionCallEvents(item, outputIndex);
  case 'custom_tool_call': return responseCustomToolCallEvents(item, outputIndex);
  }
};

export const responsesResultToEvents = (response: ResponsesResult): EventFrame<SequencedResponsesStreamEvent>[] => {
  const started = responseStartSnapshot(response);
  const events: ResponseStreamEvent[] = [
    { type: 'response.created', response: started },
    { type: 'response.in_progress', response: started },
    ...response.output.flatMap(responseOutputItemEvents),
    { type: getTerminalEventName(response), response },
  ];

  return events.map((event, sequenceNumber) => eventFrame({ ...event, sequence_number: sequenceNumber }));
};
