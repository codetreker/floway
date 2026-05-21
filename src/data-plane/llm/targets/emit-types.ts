import type { BackgroundScheduler } from '../../../runtime/background.ts';
import type { ProviderTargetInterceptors } from '../../providers/types.ts';
import type { LlmExchangeMeta } from '../interceptors.ts';
import type { ExecuteResult } from '../shared/errors/result.ts';
import type { ProtocolFrame, StreamFrame } from '../shared/stream/types.ts';

export interface EmitInput<TPayload extends { model: string }> extends LlmExchangeMeta {
  payload: TPayload;
  targetInterceptors?: ProviderTargetInterceptors;
  clientStream?: boolean;
  runtimeLocation?: string;
  scheduleBackground?: BackgroundScheduler;
}

export type EmitResult<TEvent> = ExecuteResult<ProtocolFrame<TEvent>>;

export type RawEmitResult<TJson> = ExecuteResult<StreamFrame<TJson>>;
