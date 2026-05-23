import { getRepo } from '../../../repo/index.ts';
import type { TelemetryModelIdentity, TokenUsage } from '../../../repo/types.ts';

const currentHour = (): string => new Date().toISOString().slice(0, 13);

export const hasTokenUsage = (usage: TokenUsage): boolean => usage.inputTokens > 0 || usage.outputTokens > 0 || usage.cacheReadTokens > 0 || usage.cacheCreationTokens > 0;

export const tokenUsage = (inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0): TokenUsage => ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheCreationTokens,
});

export const tokenUsageFromPromptTokenResponse = (value: unknown): TokenUsage | null => {
  if (!value || typeof value !== 'object') return null;
  const usage = (value as { usage?: { prompt_tokens?: unknown } }).usage;
  return typeof usage?.prompt_tokens === 'number' ? tokenUsage(usage.prompt_tokens) : null;
};

export const recordTokenUsage = async (keyId: string, modelIdentity: TelemetryModelIdentity, usage: TokenUsage): Promise<void> => {
  await Promise.all([
    getRepo().usage.record({
      keyId,
      model: modelIdentity.model,
      upstream: modelIdentity.upstream,
      modelKey: modelIdentity.modelKey,
      hour: currentHour(),
      requests: 1,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      cost: modelIdentity.cost,
    }),
    (async () => {
      const key = await getRepo().apiKeys.getById(keyId);
      if (!key) return;
      await getRepo().apiKeys.save({
        ...key,
        lastUsedAt: new Date().toISOString(),
      });
    })(),
  ]);
};

export const recordTokenUsageForApiKey = async (apiKeyId: string | undefined, modelIdentity: TelemetryModelIdentity, usage: TokenUsage): Promise<void> => {
  // Dashboard playground requests authenticate with ADMIN_KEY and intentionally
  // have no API key id; usage is not recorded for those.
  if (!apiKeyId) return;
  await recordTokenUsage(apiKeyId, modelIdentity, usage);
};
