import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import type { UpstreamModel } from '@floway-dev/provider';

// Boundary ctx for Codex Responses interceptors. The same ctx feeds both the
// streaming `/responses` chain and the non-streaming compaction chain; only
// the terminal result type differs (see codexResponsesChain in ./index.ts).
export interface ResponsesBoundaryCtx {
  payload: ResponsesPayload;
  headers: Record<string, string>;
  readonly model: UpstreamModel;
}
