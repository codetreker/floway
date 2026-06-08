import { type CallCodexResponsesOptions, callCodexResponses } from './fetch.ts';
import type { ResponsesCompactPayload, ResponsesInputItem, ResponsesPayload, ResponsesResult } from '@floway-dev/protocols/responses';
import { COMPACTION_TRIGGER, compactionResponse, type ProviderCompactionResult } from '@floway-dev/provider';

export interface CallCodexResponsesCompactOptions extends Omit<CallCodexResponsesOptions, 'body'> {
  body: Omit<ResponsesCompactPayload, 'model' | 'store'>;
}

// Codex natively understands the trailing `compaction_trigger` input item but
// only delivers the resulting `compaction` output via the streaming
// `response.output_item.done` event — `response.completed.output` is empty.
// We append the trigger, drive the same lifecycle helper as the normal
// /responses call (refresh + 429 quota + 401 retry), drain the SSE frames,
// and reshape via the shared `compactionResponse` helper so the envelope
// matches the Copilot path.
export const callCodexResponsesCompact = async (opts: CallCodexResponsesCompactOptions): Promise<ProviderCompactionResult> => {
  const originalInput: ResponsesInputItem[] = typeof opts.body.input === 'string'
    ? [{ type: 'message', role: 'user', content: opts.body.input }]
    : opts.body.input;
  const triggerInput: ResponsesInputItem[] = [...originalInput, COMPACTION_TRIGGER];

  const triggeredBody: Omit<ResponsesPayload, 'model'> = { ...opts.body, input: triggerInput };
  const result = await callCodexResponses({ ...opts, body: triggeredBody });

  if (!result.ok) return { ok: false, response: result.response, modelKey: opts.model.id };

  let baseEnvelope: ResponsesResult | null = null;
  const compactionItems: ResponsesResult['output'] = [];
  for await (const frame of result.events) {
    if (frame.type !== 'event') continue;
    const event = frame.event;
    if (event.type === 'response.created' || event.type === 'response.in_progress' || event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
      // Keep the latest envelope; `completed` carries usage + final status.
      baseEnvelope = event.response;
    } else if (event.type === 'response.output_item.done' && event.item.type === 'compaction') {
      compactionItems.push(event.item);
    }
  }

  if (!baseEnvelope) throw new Error('Codex compaction stream ended without a base response envelope');

  // Restitch the captured compaction item(s) into the envelope's empty output
  // so compactionResponse can find them; the shared helper enforces exactly
  // one and rebuilds the retained-message prefix.
  const synthesized: ResponsesResult = { ...baseEnvelope, output: compactionItems };
  return { ok: true, result: compactionResponse(originalInput, synthesized), modelKey: opts.model.id };
};
