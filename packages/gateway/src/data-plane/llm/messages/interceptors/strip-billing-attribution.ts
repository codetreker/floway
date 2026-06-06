import type { MessagesInterceptor } from './types.ts';

/**
 * Claude Code injects `x-anthropic-billing-header` lines containing a per-turn
 * `cch=` hash. Some upstreams treat this metadata as ordinary prompt text, so
 * prompt caching stops hitting even when the real prompt did not change. The
 * cleanup is wire-shape-agnostic — every provider benefits whether the wire
 * stays Messages or the gateway translates onward — so it lives on the
 * gateway-side Messages source chain.
 *
 * References:
 * - https://github.com/Menci/Floway/pull/9
 */
const BILLING_HEADER_LINE_RE = /x-anthropic-billing-header[^\n]*/g;
const CCH_HASH_RE = /cch=[0-9a-f]{5,};?/gi;

const stripText = (text: string): string => text.replace(BILLING_HEADER_LINE_RE, '').replace(CCH_HASH_RE, '').trim();

export const stripBillingAttribution: MessagesInterceptor = (ctx, _request, run) => {
  const { payload } = ctx;

  if (typeof payload.system === 'string') {
    payload.system = stripText(payload.system);
    if (!payload.system) delete payload.system;
  } else if (Array.isArray(payload.system)) {
    for (const block of payload.system) {
      block.text = stripText(block.text);
    }
    payload.system = payload.system.filter(block => block.text.length > 0);
    if (payload.system.length === 0) delete payload.system;
  }

  return run();
};
