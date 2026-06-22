import { responsesAttempt } from './attempt.ts';
import type { ResponsesAttemptResult } from './interceptors/types.ts';
import type { ResponsesSnapshotMode, StatefulResponsesStore } from './items/store.ts';
import { prepareResponsesServePlan } from './serve-prep.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ExecuteResult } from '@floway-dev/provider';

export interface ResponsesServeGenerateArgs {
  readonly payload: ResponsesPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  // HTTP defaults to 'append'; WS overrides per-message based on `payload.store`.
  // The cross-protocol translation-in path never reaches this entry — it goes
  // straight into `responsesAttempt.generate`.
  readonly snapshotMode?: ResponsesSnapshotMode;
  readonly headers: Headers;
}

export interface ResponsesServeCompactArgs {
  readonly payload: ResponsesPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  readonly headers: Headers;
}

// Codex's RemoteCompactionV2 performs compaction through the generate path
// by appending a `compaction_trigger` control item to the input. Semantically
// this is the same operation as `/responses/compact`: the upstream replaces
// the prior history with a single `compaction` output, and any later
// `previous_response_id` should resolve to that blob alone — not the dropped
// history. Treat such a request like compact at the snapshot seam.
const containsCompactionTrigger = (input: ResponsesPayload['input']): boolean =>
  typeof input !== 'string' && input.some(item => item.type === 'compaction_trigger');

export const responsesServe = {
  generate: async (args: ResponsesServeGenerateArgs): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
    const { payload, ctx, store, snapshotMode = 'append', headers } = args;
    const plan = await prepareResponsesServePlan({
      payload, ctx, store,
      pickTarget: endpoints =>
        endpoints.responses ? 'responses'
          : endpoints.messages ? 'messages'
            : endpoints.chatCompletions ? 'chat-completions'
              : null,
    });
    if (plan.kind === 'failure') return plan.result;
    const effectiveSnapshotMode: ResponsesSnapshotMode = snapshotMode !== 'none' && containsCompactionTrigger(plan.prepared.input)
      ? 'replace'
      : snapshotMode;
    return await responsesAttempt.generate({ payload: plan.prepared, ctx, store, candidate: plan.candidate, snapshotMode: effectiveSnapshotMode, headers });
  },

  compact: async (args: ResponsesServeCompactArgs): Promise<ResponsesAttemptResult> => {
    const { payload, ctx, store, headers } = args;
    // Compact accepts `previous_response_id` (the official endpoint documents
    // it). When present we expand it the same way generate does so the
    // upstream sees the same item_reference + current input shape.
    const plan = await prepareResponsesServePlan({
      payload, ctx, store,
      pickTarget: endpoints => endpoints.responses ? 'responses' : null,
    });
    if (plan.kind === 'failure') return plan.result;
    return await responsesAttempt.compact({ payload: plan.prepared, ctx, store, candidate: plan.candidate, headers });
  },
};
