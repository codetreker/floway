import type { ProviderCandidate } from './candidates.ts';
import type { LlmServeFailure } from './errors.ts';

export type RoutingDecision =
  | { readonly kind: 'success'; readonly candidates: readonly ProviderCandidate[] }
  | { readonly kind: 'failure'; readonly failure: LlmServeFailure };
