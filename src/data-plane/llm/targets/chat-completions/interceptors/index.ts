import { withReasoningDisabledOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import { withUsageStreamOptionsIncluded } from './include-usage-stream-options.ts';
import { withDeepseekReasoningDialect } from './normalize-reasoning-dialect.ts';
import { withUsageNormalized } from './normalize-usage.ts';
import type { ProviderTargetInterceptors } from '../../../../providers/types.ts';
import type { ChatCompletionsInterceptor } from '../../../interceptors.ts';
import type { OptionalInterceptor } from '../../optional-interceptor.ts';

interface ChatCompletionsInterceptorProvider {
  enabledFixes: ReadonlySet<string>;
  targetInterceptors?: ProviderTargetInterceptors;
}

// Always-on Chat Completions target interceptors. Both gate the gateway's
// usage-tracking pipeline:
//   - `include-usage-stream-options` ensures upstreams emit a final usage
//     chunk in streaming mode.
//   - `normalize-usage` normalizes vendor variants (DeepSeek / Kimi /
//     standard OpenAI) into the OpenAI standard usage shape so telemetry
//     reads one contract.
// Turning either off would silently break per-key telemetry, so neither
// is surfaced as a flag.
const baseInterceptors = [withUsageStreamOptionsIncluded, withUsageNormalized] as const satisfies readonly ChatCompletionsInterceptor[];

export const chatCompletionsOptionalInterceptors = [
  {
    fixId: 'deepseek-reasoning-dialect',
    run: withDeepseekReasoningDialect,
  },
  {
    fixId: 'disable-reasoning-on-forced-tool-choice',
    run: withReasoningDisabledOnForcedToolChoice,
  },
] as const satisfies readonly OptionalInterceptor<ChatCompletionsInterceptor>[];

export const interceptorsForChatCompletions = (provider: ChatCompletionsInterceptorProvider): readonly ChatCompletionsInterceptor[] => [
  ...baseInterceptors,
  ...(provider.targetInterceptors?.chatCompletions ?? []),
  ...chatCompletionsOptionalInterceptors.filter(({ fixId }) => provider.enabledFixes.has(fixId)).map(({ run }) => run),
];
