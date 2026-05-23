import type { WebSearchProvider, WebSearchProviderName, WebSearchProviderRequest, WebSearchProviderResult } from './types.ts';
import { recordWebSearchUsage } from './usage.ts';

export const searchWebAndRecordUsage = async (opts: {
  provider: WebSearchProvider;
  providerName: WebSearchProviderName;
  keyId: string;
  request: WebSearchProviderRequest;
}): Promise<WebSearchProviderResult> => {
  try {
    return await opts.provider(opts.request);
  } finally {
    try {
      await recordWebSearchUsage(opts.keyId, opts.providerName, 1);
    } catch (error) {
      console.error('Web search usage record error:', error);
    }
  }
};

export const searchWebWithoutRecordingUsage = async (opts: { provider: WebSearchProvider; request: WebSearchProviderRequest }): Promise<WebSearchProviderResult> => await opts.provider(opts.request);
