import { withReasoningDisabledOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import { withCyberPolicyRetried } from './retry-cyber-policy.ts';
import type { ProviderTargetInterceptors } from '../../../../providers/types.ts';
import type { ResponsesInterceptor } from '../../../interceptors.ts';
import type { OptionalInterceptor } from '../../optional-interceptor.ts';

const baseInterceptors: readonly ResponsesInterceptor[] = [];

export const responsesOptionalInterceptors = [
  { fixId: 'retry-cyber-policy', run: withCyberPolicyRetried },
  {
    fixId: 'disable-reasoning-on-forced-tool-choice',
    run: withReasoningDisabledOnForcedToolChoice,
  },
] as const satisfies readonly OptionalInterceptor<ResponsesInterceptor>[];

export const interceptorsForResponses = (provider: { enabledFixes: ReadonlySet<string>; targetInterceptors?: ProviderTargetInterceptors }): readonly ResponsesInterceptor[] => [
  ...baseInterceptors,
  ...(provider.targetInterceptors?.responses ?? []),
  ...responsesOptionalInterceptors.filter(({ fixId }) => provider.enabledFixes.has(fixId)).map(({ run }) => run),
];
