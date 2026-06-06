import type { LlmServeFailure } from '../shared/errors.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ExecuteResult } from '@floway-dev/provider';

// Anthropic Messages error envelope used to render pre-stream
// `LlmServeFailure`s.
const anthropicErrorResult = (
  status: number,
  type: string,
  message: string,
): ExecuteResult<ProtocolFrame<MessagesStreamEvent>> => ({
  type: 'upstream-error',
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: new TextEncoder().encode(JSON.stringify({
    type: 'error',
    error: { type, message },
  })),
});

// `endpoint` selects between `/messages` and `/messages/count_tokens` only in
// the `model-unsupported` message string.
export const renderMessagesFailure = (
  failure: LlmServeFailure,
  endpoint: 'generate' | 'countTokens',
): ExecuteResult<ProtocolFrame<MessagesStreamEvent>> => {
  const endpointPath = endpoint === 'countTokens' ? '/messages/count_tokens' : '/messages';
  switch (failure.kind) {
  case 'item-not-found':
    return anthropicErrorResult(400, 'invalid_request_error', `Item with id '${failure.itemId}' not found.`);
  case 'routing-unavailable':
    return anthropicErrorResult(400, 'invalid_request_error', failure.message);
  case 'model-missing':
    return anthropicErrorResult(404, 'not_found_error', `Model ${failure.model} is not available on any configured upstream.`);
  case 'model-unsupported':
    return anthropicErrorResult(400, 'invalid_request_error', `Model ${failure.model} does not support the ${endpointPath} endpoint.`);
  }
};
