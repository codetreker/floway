import { stripSafetySettings } from './strip-safety-settings.ts';
import { stripUnsupportedPartFields } from './strip-unsupported-part-fields.ts';
import { stripUnsupportedTools } from './strip-unsupported-tools.ts';
import { suppressThoughtParts } from './suppress-thought-parts.ts';
import type { GeminiInterceptor } from '../../../interceptors.ts';

export const geminiSourceInterceptors = [stripUnsupportedPartFields, stripUnsupportedTools, stripSafetySettings, suppressThoughtParts] satisfies readonly GeminiInterceptor[];
