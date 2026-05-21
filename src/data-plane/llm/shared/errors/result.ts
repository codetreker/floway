import type { InternalDebugError } from './internal-debug-error.ts';
import type { TelemetryModelIdentity } from '../../../../repo/types.ts';
import type { PerformanceTelemetryContext } from '../../../shared/telemetry/performance.ts';

export interface EventResult<T> {
  type: 'events';
  events: AsyncIterable<T>;
  modelIdentity: TelemetryModelIdentity;
  performance?: PerformanceTelemetryContext;
  finalMetadata?: Promise<EventResultMetadata>;
}

export interface EventResultMetadata {
  modelIdentity: TelemetryModelIdentity;
  performance?: PerformanceTelemetryContext;
}

export interface UpstreamErrorResult {
  type: 'upstream-error';
  status: number;
  headers: Headers;
  body: Uint8Array;
  performance?: PerformanceTelemetryContext;
}

export interface InternalErrorResult {
  type: 'internal-error';
  status: number;
  error: InternalDebugError;
  performance?: PerformanceTelemetryContext;
}

export type ExecuteResult<T> = EventResult<T> | UpstreamErrorResult | InternalErrorResult;

export const eventResult = <T>(
  events: AsyncIterable<T>,
  modelIdentity: TelemetryModelIdentity,
  performance?: PerformanceTelemetryContext,
  finalMetadata?: Promise<EventResultMetadata>,
): EventResult<T> => {
  const result: EventResult<T> = { type: 'events', events, modelIdentity };
  if (performance !== undefined) {
    result.performance = performance;
  }
  if (finalMetadata !== undefined) result.finalMetadata = finalMetadata;
  return result;
};

export const internalErrorResult = (status: number, error: InternalDebugError, performance?: PerformanceTelemetryContext): InternalErrorResult => ({
  type: 'internal-error',
  status,
  error,
  ...(performance ? { performance } : {}),
});
