import { getRepo } from '../../../repo/index.ts';
import type { TokenUsage } from '../../../repo/types.ts';
import type { BillingDimension } from '@floway-dev/protocols/common';
import type { TelemetryModelIdentity } from '@floway-dev/provider';

const currentHour = (): string => new Date().toISOString().slice(0, 13);

const BILLING_DIMENSIONS: readonly BillingDimension[] = ['input', 'input_cache_read', 'input_cache_write', 'input_image', 'output', 'output_image'];

export const hasTokenUsage = (usage: TokenUsage): boolean => BILLING_DIMENSIONS.some(dimension => (usage[dimension] ?? 0) > 0);

// Drop zero / undefined dimensions so a usage map only carries the dimensions
// actually billed.
export const tokenUsage = (counts: TokenUsage): TokenUsage => {
  const out: TokenUsage = {};
  for (const dimension of BILLING_DIMENSIONS) {
    const value = counts[dimension] ?? 0;
    if (value > 0) out[dimension] = value;
  }
  return out;
};

export const tokenUsageFromPromptTokenResponse = (usage: unknown): TokenUsage | null => {
  if (!usage || typeof usage !== 'object') return null;
  const promptTokens = (usage as { prompt_tokens?: unknown }).prompt_tokens;
  return typeof promptTokens === 'number' ? tokenUsage({ input: promptTokens }) : null;
};

// OpenAI Images responses report usage as
// `{input_tokens, output_tokens, total_tokens, input_tokens_details, output_tokens_details}`,
// where the details objects split each total into `text_tokens` and
// `image_tokens`. We map that split onto the billing dimensions: bare
// input/output for the text modality, input_image/output_image for the image
// modality. The details splits are disjoint and sum to their respective total.
//
// When a details object is missing but its total is present, the whole total is
// charged on the bare dimension rather than inventing a split. A present field
// that is a non-number is treated as a malformed upstream payload (return
// null) rather than silently coerced — matching the anti-fallback rule in
// AGENTS.md.
export const tokenUsageFromImagesResponse = (usage: unknown): TokenUsage | null => {
  if (!usage || typeof usage !== 'object') return null;
  const { input_tokens: inputTotal, output_tokens: outputTotal, input_tokens_details: inputDetails, output_tokens_details: outputDetails } = usage as ImagesUsageShape;

  if (inputTotal !== undefined && typeof inputTotal !== 'number') return null;
  if (outputTotal !== undefined && typeof outputTotal !== 'number') return null;
  if (inputTotal === undefined && outputTotal === undefined) return null;

  const input = splitModalityCounts('input', 'input_image', inputTotal, inputDetails);
  if (input === null) return null;
  const output = splitModalityCounts('output', 'output_image', outputTotal, outputDetails);
  if (output === null) return null;

  return tokenUsage({ ...input, ...output });
};

interface ImagesUsageShape {
  input_tokens?: unknown;
  output_tokens?: unknown;
  input_tokens_details?: unknown;
  output_tokens_details?: unknown;
}

const splitModalityCounts = (
  textDimension: BillingDimension,
  imageDimension: BillingDimension,
  total: number | undefined,
  details: unknown,
): TokenUsage | null => {
  if (total === undefined) return {};
  if (details === undefined) return { [textDimension]: total };
  if (!details || typeof details !== 'object') return null;
  const { text_tokens: text, image_tokens: image } = details as { text_tokens?: unknown; image_tokens?: unknown };
  if (text !== undefined && typeof text !== 'number') return null;
  if (image !== undefined && typeof image !== 'number') return null;
  // A details object that carries neither split is as good as absent.
  if (text === undefined && image === undefined) return { [textDimension]: total };
  return { [textDimension]: text ?? 0, [imageDimension]: image ?? 0 };
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
      tokens: usage,
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
