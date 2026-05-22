import type { UpstreamErrorResult } from './result.ts';
import { ProviderModelsUnavailableError } from '../../../providers/models-store.ts';
import type { PerformanceTelemetryContext } from '../../../shared/telemetry/performance.ts';

interface ThrownUpstreamError {
  status: number;
  headers: Headers;
  body: string;
}

export const thrownUpstreamError = (error: unknown): ThrownUpstreamError | null => {
  if (error instanceof ProviderModelsUnavailableError && error.httpResponse) {
    return {
      status: error.httpResponse.status,
      headers: new Headers(error.httpResponse.headers),
      body: error.httpResponse.body,
    };
  }

  return null;
};

export const thrownUpstreamErrorResult = (error: unknown, performance?: PerformanceTelemetryContext): UpstreamErrorResult | null => {
  const upstreamError = thrownUpstreamError(error);
  if (!upstreamError) return null;

  return {
    type: 'upstream-error',
    status: upstreamError.status,
    headers: upstreamError.headers,
    body: new TextEncoder().encode(upstreamError.body),
    ...(performance ? { performance } : {}),
  };
};

export const readUpstreamError = async (response: Response): Promise<UpstreamErrorResult> => ({
  type: 'upstream-error',
  status: response.status,
  headers: new Headers(response.headers),
  body: new Uint8Array(await response.arrayBuffer()),
});

export const upstreamErrorToResponse = (error: UpstreamErrorResult): Response =>
  new Response(error.body.slice().buffer, {
    status: error.status,
    headers: new Headers(error.headers),
  });

export const decodeUpstreamErrorBody = (error: UpstreamErrorResult): string => new TextDecoder().decode(error.body);
