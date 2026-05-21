import type { SourceExecutionContext } from './execute.ts';
import type { TelemetryModelIdentity, TokenUsage } from '../../../repo/types.ts';
import { hasTokenUsage, type RecordUsage } from '../../shared/telemetry/usage.ts';
import type { EventResultMetadata, StreamExecuteResult } from '../shared/errors/result.ts';
import type { StreamCompletion } from '../shared/stream/proxy-sse.ts';

export interface SourceStreamState {
  failed: boolean;
  completed: boolean;
  usage: TokenUsage | null;
}

export const createSourceStreamState = (): SourceStreamState => ({
  failed: false,
  completed: false,
  usage: null,
});

export const rememberSourceFrameUsage = (state: SourceStreamState, usage: TokenUsage | null): void => {
  if (usage && hasTokenUsage(usage)) state.usage = usage;
};

export const recordSourceUsage = async (modelIdentity: TelemetryModelIdentity, usage: TokenUsage | null, recordUsage: RecordUsage): Promise<void> => {
  if (usage && hasTokenUsage(usage)) await recordUsage(modelIdentity, usage);
};

export const eventResultMetadata = async <TEvent>(result: Extract<StreamExecuteResult<TEvent>, { type: 'events' }>): Promise<EventResultMetadata> =>
  await (result.finalMetadata ??
    Promise.resolve({
      modelIdentity: result.modelIdentity,
      ...(result.performance ? { performance: result.performance } : {}),
    }));

export const recordSourcePerformance = (source: SourceExecutionContext, context: EventResultMetadata['performance'], failed: boolean): void => {
  source.recordRequestPerformance(context, failed, performance.now() - source.requestStartedAt);
};

export const sourceStreamFailed = (completion: StreamCompletion, state: SourceStreamState): boolean => completion === 'error' || state.failed || (completion === 'cancel' && !state.completed);
