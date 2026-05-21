import type { WebSearchProviderName } from '../../../shared/web-search-providers.ts';
import type { MessagesWebSearchErrorCode } from '../../shared/protocol/messages.ts';

export type { WebSearchProviderName } from '../../../shared/web-search-providers.ts';

export interface SearchConfig {
  provider: 'disabled' | WebSearchProviderName;
  tavily: { apiKey: string };
  microsoftGrounding: { apiKey: string };
}

export const DEFAULT_WEB_SEARCH_RESULT_COUNT = 10;

export type WebSearchProviderErrorCode = Exclude<MessagesWebSearchErrorCode, 'max_uses_exceeded'>;

export interface WebSearchProviderRequest {
  query: string;
  allowedDomains?: string[];
  blockedDomains?: string[];
  userLocation?: {
    city?: string;
    region?: string;
    country?: string;
    timezone?: string;
  };
}

export type WebSearchProviderResult =
  | {
    type: 'ok';
    results: Array<{
      source: string;
      title: string;
      pageAge?: string;
      content: Array<{ type: 'text'; text: string }>;
    }>;
  }
  | {
    type: 'error';
    errorCode: WebSearchProviderErrorCode;
    message?: string;
  };

export interface WebSearchPreviewResult {
  title: string;
  url: string;
  pageAge?: string;
  previewText: string;
}
