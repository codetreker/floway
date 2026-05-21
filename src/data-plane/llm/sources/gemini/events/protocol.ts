import type { GeminiErrorResponse, GeminiStreamEvent } from '../../../../shared/protocol/gemini.ts';

export const GEMINI_MISSING_TERMINAL_MESSAGE = 'Gemini stream ended without a terminal event.';

export const isGeminiErrorEvent = (event: GeminiStreamEvent): event is GeminiErrorResponse => 'error' in event;

export const isGeminiFinishedEvent = (event: GeminiStreamEvent): boolean => 'candidates' in event && event.candidates?.some(candidate => candidate.finishReason !== undefined) === true;

export const isGeminiTerminalEvent = (event: GeminiStreamEvent): boolean => isGeminiErrorEvent(event) || isGeminiFinishedEvent(event);
