import type { WebSearchProvider, WebSearchProviderName, WebSearchProviderRequest, WebSearchProviderResult } from './types.ts';
import { recordSearchUsage } from './usage.ts';

export const searchWebAndRecordUsage = async (opts: {
  provider: WebSearchProvider;
  providerName: WebSearchProviderName;
  keyId: string;
  request: WebSearchProviderRequest;
}): Promise<WebSearchProviderResult> => {
  try {
    return await opts.provider.search(opts.request);
  } finally {
    // Telemetry must never mask the provider result; log and swallow
    // recording failures.
    try {
      await recordSearchUsage({
        provider: opts.providerName,
        keyId: opts.keyId,
        action: 'search',
      });
    } catch (error) {
      console.error('Web search usage record error:', error);
    }
  }
};

// Explicit no-record search for the admin playground path (no apiKey
// to attribute usage against). Callers MUST use this rather than
// passing `keyId: undefined` to `searchWebAndRecordUsage` — recording
// is not a silent skip.
export const searchWebWithoutRecordingUsage = (opts: {
  provider: WebSearchProvider;
  request: WebSearchProviderRequest;
}): Promise<WebSearchProviderResult> => opts.provider.search(opts.request);
