// Generic upstream abstraction for OpenAI-compatible LLM providers.
// Each upstream owns its base URL, auth headers, and per-endpoint path rules.
//
// Callers identify the endpoint by a logical key (`messages`, `responses`,
// `chat_completions`, `embeddings`, `models`, `messages_count_tokens`); the
// upstream resolves it to the actual path that gets joined onto its base URL.
// Custom OpenAI-compatible upstreams may override individual paths via their
// stored `pathOverrides` config so admins can point one endpoint at a subpath
// without disturbing the others.

import type { EndpointKey } from '../../repo/types.ts';

export interface UpstreamFetchOptions {
  extraHeaders?: Record<string, string>;
}

export type UpstreamKind = 'copilot' | 'openai';

export interface Upstream {
  id: string;
  name: string;
  kind: UpstreamKind;
  // Endpoints this upstream is *configured* to support. Used as a fallback
  // when /models does not declare per-model `supported_endpoints` (Copilot
  // does; most third-party providers do not).
  supportedEndpoints: string[];
  // Flag ids the upstream opted into. Provider construction promotes this
  // low-level setting into ModelProvider.enabledFixes before target emitters
  // assemble optional interceptors.
  enabledFixes: ReadonlySet<string>;
  fetch(endpoint: EndpointKey, init: RequestInit, options?: UpstreamFetchOptions): Promise<Response>;
}
