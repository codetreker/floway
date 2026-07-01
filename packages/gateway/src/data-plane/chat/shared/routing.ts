import type { ChatServeFailure } from './errors.ts';
import type { ModelCandidate } from '@floway-dev/provider';

export type RoutingDecision =
  | { readonly kind: 'success'; readonly candidates: readonly ModelCandidate[] }
  | { readonly kind: 'failure'; readonly failure: ChatServeFailure };
