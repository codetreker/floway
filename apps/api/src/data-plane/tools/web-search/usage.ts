import type { WebSearchProviderName } from './types.ts';
import { getRepo } from '../../../repo/index.ts';

const currentHour = (): string => new Date().toISOString().slice(0, 13);

export const recordWebSearchUsage = (keyId: string, provider: WebSearchProviderName, requests = 1): Promise<void> => getRepo().searchUsage.record(provider, keyId, currentHour(), requests);

export const queryWebSearchUsage = (opts: { provider?: WebSearchProviderName; keyId?: string; start: string; end: string }) => getRepo().searchUsage.query(opts);
