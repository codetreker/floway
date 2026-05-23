import type { ResponseStreamEvent } from '@copilot-gateway/protocols/responses';

export type ResponseEvent<TType extends ResponseStreamEvent['type']> = Extract<ResponseStreamEvent, { type: TType }>;

export const responsePartKey = (outputIndex: number, partIndex: number): string => `${outputIndex}:${partIndex}`;
