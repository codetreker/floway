import type { GatewayCtx } from './gateway-ctx.ts';
import { stampUpstreamCallStart } from './gateway-ctx.ts';
import { filterInboundHeadersForProvider } from './inbound-headers.ts';
import { createPerRequestWebSocketConnector } from '../../dial/per-request.ts';
import type { ModelCandidate, UpstreamCallOptions, WebSocketConnector } from '@floway-dev/provider';

// See UpstreamCallOptions in `@floway-dev/provider` for the contract on each
// field, especially header ownership.
export const buildUpstreamCallOptions = (
  candidate: ModelCandidate,
  ctx: GatewayCtx,
  headers: Headers,
): UpstreamCallOptions => {
  let connector: Promise<WebSocketConnector> | undefined;
  const connectWebSocket: WebSocketConnector = async (url, options) => {
    connector ??= createPerRequestWebSocketConnector(ctx.runtimeLocation)
      .then(forUpstream => forUpstream(candidate.provider.upstreamId));
    return await (await connector)(url, options);
  };
  return {
    fetcher: candidate.fetcher,
    caller: { apiKeyId: ctx.apiKeyId },
    connectWebSocket,
    waitUntil: ctx.backgroundScheduler,
    headers: filterInboundHeadersForProvider(headers, candidate.provider),
    wrapUpstreamCall: stampUpstreamCallStart(ctx.attempt),
  };
};
