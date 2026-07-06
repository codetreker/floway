import type { ClaudeCodeMessagesBoundaryCtx } from './types.ts';
import { IDENTITY_BLOCK } from '../../system-blocks.ts';
import type { MessagesTextBlock } from '@floway-dev/protocols/messages';

// system[1]; relies on injectBillingBlock having materialized payload.system as an array (see ./index.ts chain order).
export const injectIdentityBlock = async <TResult>(
  ctx: ClaudeCodeMessagesBoundaryCtx,
  _request: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const system = ctx.payload.system as MessagesTextBlock[];
  ctx.payload = { ...ctx.payload, system: [...system, IDENTITY_BLOCK] };
  return await run();
};
