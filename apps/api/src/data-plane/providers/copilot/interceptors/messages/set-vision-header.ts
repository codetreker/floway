import type { MessagesInvocation, RequestContext } from '../../../../llm/interceptors.ts';

/**
 * Copilot rejects Anthropic `image` blocks as plain text unless the private
 * `copilot-vision-request: true` header is set. Detection scans the final
 * post-mutation payload (after other Messages target interceptors have run)
 * over the top-level `message.content` array.
 *
 * Generic in the run-result type because pre-Path A the equivalent vision
 * detection ran on every Copilot Messages HTTP exchange (chat AND
 * count_tokens). Keeping a single generic interceptor lets both the streaming
 * Messages target chain (`ExecuteResult<...>`) and the count_tokens chain
 * (`Response`) share one definition.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/commit/1f6b98924ae092db9b2010846c32e5cbf10817df
 */
export const withVisionHeaderSet = async <TResult>(ctx: MessagesInvocation, _request: RequestContext, run: () => Promise<TResult>): Promise<TResult> => {
  const hasImage = ctx.payload.messages.some(
    message => Array.isArray(message.content) && message.content.some(block => block.type === 'image'),
  );
  if (hasImage) {
    ctx.headers['copilot-vision-request'] = 'true';
  }

  return await run();
};
