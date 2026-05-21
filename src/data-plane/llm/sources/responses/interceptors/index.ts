import { fixApplyPatchTools } from './fix-apply-patch-tools.ts';
import { stripUnsupportedTools } from './strip-unsupported-tools.ts';
import type { ResponsesInterceptor } from '../../../interceptors.ts';

export const responsesSourceInterceptors = [
  // fix-apply-patch-tools must run before strip-unsupported-tools so the
  // `apply_patch` Freeform tool is rewritten into a function tool before the
  // strip pass removes every remaining `custom` entry.
  fixApplyPatchTools,
  stripUnsupportedTools,
] satisfies readonly ResponsesInterceptor[];
