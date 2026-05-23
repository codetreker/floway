import type { ChatCompletionsInterceptor } from '../../../interceptors.ts';

/**
 * Chat Completions streaming only includes the final usage-only chunk when
 * `stream_options.include_usage` is enabled. We force that on here because
 * the gateway's source responders and usage tracking rely on those usage
 * frames for both streaming passthrough and non-stream reassembly.
 *
 * References:
 * - https://platform.openai.com/docs/api-reference/chat/create
 */
export const withUsageStreamOptionsIncluded: ChatCompletionsInterceptor = async (ctx, _request, run) => {
  // provider 已强制 stream=true；本 interceptor 仅追加 stream_options.include_usage 以让上游回传 usage
  ctx.payload.stream_options = ctx.payload.stream_options ? { ...ctx.payload.stream_options, include_usage: true } : { include_usage: true };

  return await run();
};
