import type { ResponseInputItem } from '@floway-dev/protocols/responses';
import type { ResponsesInterceptor } from '../../../../llm/interceptors.ts';

/**
 * Copilot's Responses endpoint requires the private
 * `copilot-vision-request: true` header to accept image inputs. Images can
 * appear as `input_image` blocks (current Responses) or legacy `image` blocks,
 * inside the top-level `message` items of `payload.input`.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/blob/main/src/routes/responses/utils.ts#L185-L210
 */
const messageHasVisionContent = (item: ResponseInputItem): boolean => {
  if (item.type !== 'message') return false;
  if (!Array.isArray(item.content)) return false;
  return item.content.some(block => {
    const type = (block as { type?: string }).type;
    return type === 'input_image' || type === 'image';
  });
};

export const withVisionHeaderSet: ResponsesInterceptor = async (ctx, _request, run) => {
  const input = ctx.payload.input;
  if (!Array.isArray(input)) return await run();

  if (input.some(item => messageHasVisionContent(item))) {
    ctx.headers['copilot-vision-request'] = 'true';
  }

  return await run();
};
