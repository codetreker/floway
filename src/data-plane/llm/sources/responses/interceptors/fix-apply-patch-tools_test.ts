import { test } from 'vitest';

import { fixApplyPatchTools } from './fix-apply-patch-tools.ts';
import { assertEquals, assertFalse } from '../../../../../test-assert.ts';
import type { ResponsesPayload } from '../../../../shared/protocol/responses.ts';
import type { RequestContext, ResponsesInvocation } from '../../../interceptors.ts';
import { eventResult } from '../../../shared/errors/result.ts';

const testTelemetryModelIdentity = {
  model: 'test-model',
  upstream: 'test-upstream',
  modelKey: 'test-model-key',
};

const invocation = (payload: ResponsesPayload): ResponsesInvocation => ({
  sourceApi: 'responses',
  targetApi: 'responses',
  model: payload.model,
  upstream: 'test-upstream',
  upstreamModel: {} as never,
  provider: {} as never,
  enabledFixes: new Set(),
  payload,
});

const stubRequest: RequestContext = {
  requestStartedAt: 0,
  runtimeLocation: 'test',
  clientStream: false,
  recordUsage: async () => {},
  recordRequestPerformance: () => {},
};

const run = async (payload: ResponsesPayload): Promise<ResponsesPayload> => {
  await fixApplyPatchTools(invocation(payload), stubRequest, () => Promise.resolve(eventResult((async function* () {})(), testTelemetryModelIdentity)));
  return payload;
};

test('fixApplyPatchTools rewrites the apply_patch custom tool to a function tool', async () => {
  const payload = await run({
    model: 'gpt-test',
    input: 'edit',
    tools: [
      {
        type: 'custom',
        name: 'apply_patch',
        description: 'raw',
        format: { type: 'freeform', syntax: 'v4a', definition: '...' },
      },
    ],
  } as ResponsesPayload);

  assertEquals(payload.tools?.length, 1);
  const tool = payload.tools?.[0];
  assertEquals(tool?.type, 'function');
  assertEquals(tool?.name, 'apply_patch');
  assertEquals((tool as { parameters?: { required?: string[] } }).parameters?.required, ['input']);
});

test('fixApplyPatchTools leaves non-apply_patch custom tools untouched', async () => {
  // strip-unsupported-tools removes them after this interceptor runs; this
  // test pins the responsibility split.
  const payload = await run({
    model: 'gpt-test',
    input: 'edit',
    tools: [{ type: 'custom', name: 'freeform_other', description: 'x' }],
  } as ResponsesPayload);

  assertEquals(payload.tools?.length, 1);
  assertEquals(payload.tools?.[0].type, 'custom');
});

test('fixApplyPatchTools rewrites a forced apply_patch custom tool_choice', async () => {
  const payload = await run({
    model: 'gpt-test',
    input: 'edit',
    tools: [
      {
        type: 'function',
        name: 'apply_patch',
        parameters: {},
        strict: false,
      },
    ],
    tool_choice: { type: 'custom', name: 'apply_patch' },
  } as ResponsesPayload);

  assertEquals(payload.tool_choice, { type: 'function', name: 'apply_patch' });
});

test('fixApplyPatchTools is a no-op when no apply_patch tool is present', async () => {
  const payload = await run({
    model: 'gpt-test',
    input: 'edit',
    tools: [
      {
        type: 'function',
        name: 'lookup',
        parameters: {},
        strict: false,
      },
    ],
    tool_choice: 'auto',
  } as ResponsesPayload);

  assertEquals(payload.tools?.length, 1);
  assertEquals(payload.tools?.[0].name, 'lookup');
  assertEquals(payload.tool_choice, 'auto');
  assertFalse(Array.isArray(payload.tool_choice));
});
