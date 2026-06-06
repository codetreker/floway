import { ProviderModelsUnavailableError } from '@floway-dev/provider';

// A custom upstream's `/models` endpoint failing is the user's first signal
// that their upstream is misconfigured — relay the verbatim status/body so
// the caller sees the upstream's diagnostic, not a generic gateway envelope.
// Network-level failures (no httpResponse) return null; callers fall through
// to their own internal-error rendering for those because there is no
// upstream body to relay.
export const providerModelsUnavailableResponse = (error: unknown): Response | null => {
  if (!(error instanceof ProviderModelsUnavailableError) || !error.httpResponse) return null;
  const { status, headers, body } = error.httpResponse;
  return new Response(body, { status, headers });
};
