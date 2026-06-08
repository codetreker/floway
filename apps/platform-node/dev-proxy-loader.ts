// Dev-only preload that points Node's global undici fetch dispatcher at the
// HTTP(S)_PROXY env vars. Opt in by replacing `pnpm run dev:node` with the
// verbose form so this file is `--import`ed before entry.ts runs:
//
//   HTTPS_PROXY=http://127.0.0.1:1090 \
//     pnpm --filter @floway-dev/platform-node exec \
//       tsx --import ./dev-proxy-loader.ts entry.ts
//
// The worker's outbound fetches (Codex OAuth, /codex/models, etc.) then
// tunnel through the operator's local SOCKS-via-SSH adapter — useful when
// the local IP is geo-blocked. Ignored when no proxy env is set, so leaving
// it `--import`ed in a shell alias is harmless.

import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

if (process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
  console.log(`[dev-proxy] outbound fetch routed via ${process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY}`);
}
