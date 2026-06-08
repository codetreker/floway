// Codex-only Responses workarounds. The chain is a boundary the Codex provider
// runs inside its own call methods, so the gateway main flow never knows that
// Codex has Responses interceptors at all.

import { hoistSystemInputToInstructions } from './hoist-system-input-to-instructions.ts';
import { injectDefaultInstructions } from './inject-default-instructions.ts';
import { injectSessionId } from './inject-session-id.ts';
import { stripUnsupportedFields } from './strip-unsupported-fields.ts';
import type { ResponsesBoundaryCtx } from './types.ts';
import type { Interceptor } from '@floway-dev/interceptor';

// Order rationale (only the first pair has a real ordering invariant):
//
//   hoist-system-input-to-instructions runs FIRST so any role:"system" item
//   it pulls into `instructions` is then visible to inject-default-instructions
//   (which would otherwise overwrite an empty instructions with the bland
//   default and lose the operator-supplied rule).
//
// strip-unsupported-fields and inject-session-id are independent: neither
// reads or writes a field the other touches. The position of inject-session-id
// last is conventional but not load-bearing — it hashes only `instructions +
// first user-message text`, neither of which is mutated by the other three.
//
// Each interceptor is generic over the terminal result type: the streaming
// `/responses` chain runs to ProviderStreamResult, the compaction chain runs
// to ProviderCompactionResult, and both feed the same boundary ctx. Codex
// interceptors are pure payload/header mutators, so the streaming variant
// returns ProviderStreamResult directly (no per-frame lift/lower).
export const codexResponsesChain = <TResult>(): readonly Interceptor<ResponsesBoundaryCtx, object, TResult>[] => [
  hoistSystemInputToInstructions,
  injectDefaultInstructions,
  stripUnsupportedFields,
  injectSessionId,
];
