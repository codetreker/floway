// Failures a protocol can render before reaching an upstream; unexpected
// throws bubble as-is.
export type LlmServeFailure =
  | { readonly kind: 'model-missing'; readonly model: string }
  | { readonly kind: 'model-unsupported'; readonly model: string }
  | { readonly kind: 'item-not-found'; readonly itemId: string }
  | { readonly kind: 'routing-unavailable'; readonly message: string };

class LlmServeFailureError extends Error {
  readonly failure: LlmServeFailure;

  constructor(failure: LlmServeFailure) {
    super(`LlmServeFailure: ${failure.kind}`);
    this.failure = failure;
  }
}

export const throwLlmServeFailure = (failure: LlmServeFailure): never => {
  throw new LlmServeFailureError(failure);
};

export const tryCatchLlmServeFailure = (error: unknown): LlmServeFailure | null =>
  error instanceof LlmServeFailureError ? error.failure : null;
