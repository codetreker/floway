import type { ResponseStreamEvent } from '../../../shared/protocol/responses.ts';

export type UpstreamResponseStreamEvent = ResponseStreamEvent & {
  sequence_number?: number;
};

export type ResponseEvent<TType extends ResponseStreamEvent['type']> = Extract<ResponseStreamEvent, { type: TType }>;

export type ResponseCompletionEvent = ResponseEvent<'response.completed' | 'response.incomplete'>;

export const responsePartKey = (outputIndex: number, partIndex: number): string => `${outputIndex}:${partIndex}`;

export const isResponseCompletionEvent = (event: ResponseStreamEvent): event is ResponseCompletionEvent => event.type === 'response.completed' || event.type === 'response.incomplete';
