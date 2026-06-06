import type { LlmServeFailure } from '../shared/errors.ts';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult } from '@floway-dev/provider';

// OpenAI error envelope. `param`/`code` reproduce OpenAI's native fields; a
// stored-item miss must byte-match OpenAI's own "not found" body.
const openAiErrorResult = (
  status: number,
  message: string,
  extra?: { param: string; code: string | null },
): ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>> => ({
  type: 'upstream-error',
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: new TextEncoder().encode(JSON.stringify({
    error: { message, type: 'invalid_request_error', ...extra },
  })),
});

export const renderChatCompletionsFailure = (
  failure: LlmServeFailure,
): ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>> => {
  switch (failure.kind) {
  case 'item-not-found':
    return openAiErrorResult(404, `Item with id '${failure.itemId}' not found.`, { param: 'input', code: null });
  case 'routing-unavailable':
    return openAiErrorResult(400, failure.message, { param: 'input', code: 'responses_item_routing_unavailable' });
  case 'model-missing':
    return openAiErrorResult(404, `Model ${failure.model} is not available on any configured upstream.`);
  case 'model-unsupported':
    return openAiErrorResult(400, `Model ${failure.model} does not support the /chat/completions endpoint.`);
  }
};
