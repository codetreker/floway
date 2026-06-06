import type { CopilotMessagesBoundaryInterceptor } from './types.ts';

const isContextWindowError = (text: string): boolean => text.includes('Request body is too large for model context window') || text.includes('context_length_exceeded');

/**
 * Copilot can report context-window failures using non-Messages strings, but
 * Messages clients expect a Messages-shaped `invalid_request_error`; Claude
 * Code uses that shape to trigger compaction instead of surfacing a raw
 * upstream error.
 *
 * References:
 * - https://docs.claude.com/en/docs/claude-code/common-workflows#prompt-too-long
 */
export const rewriteContextWindowError: CopilotMessagesBoundaryInterceptor = async (_ctx, _request, run) => {
  const result = await run();
  if (result.type !== 'upstream-error') return result;

  const body = new TextDecoder().decode(result.body);
  if (!isContextWindowError(body)) return result;

  return {
    ...result,
    type: 'upstream-error',
    status: 400,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: new TextEncoder().encode(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'prompt is too long: your prompt is too long. Please reduce the number of messages or use a model with a larger context window.',
        },
      }),
    ),
  };
};
