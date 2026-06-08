import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult } from '@floway-dev/provider';

// Threads a translate trip around an inner attempt. The trip itself is async
// (the real `@floway-dev/translate` pair functions resolve a `Promise`), so
// `translate` returns the trip object behind a promise. The pair functions
// take `(src, ctx)`; this helper's `translate` parameter stays unary so each
// caller closes over its own `ctx` (`p => translateXViaY(p, ctx)`).
export const traverseTranslation = async <SP, TP, SE, TE>(
  payload: SP,
  translate: (p: SP) => Promise<{ target: TP; events: (e: AsyncIterable<ProtocolFrame<TE>>) => AsyncIterable<ProtocolFrame<SE>> }>,
  innerAttempt: (translated: TP) => Promise<ExecuteResult<ProtocolFrame<TE>>>,
): Promise<ExecuteResult<ProtocolFrame<SE>>> => {
  const trip = await translate(payload);
  const inner = await innerAttempt(trip.target);
  if (inner.type !== 'events') return inner;
  return { ...inner, events: trip.events(inner.events) };
};
