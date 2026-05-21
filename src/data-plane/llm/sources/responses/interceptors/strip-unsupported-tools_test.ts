import { test } from 'vitest';

import { stripUnsupportedToolsFromPayload } from './strip-unsupported-tools.ts';
import { assertEquals, assertFalse } from '../../../../../test-assert.ts';
import type { ResponsesPayload } from '../../../../shared/protocol/responses.ts';

test('stripUnsupportedToolsFromPayload removes image_generation tools', () => {
  const payload = {
    model: 'gpt-test',
    input: 'draw this',
    tools: [
      { type: 'image_generation' },
      {
        type: 'function',
        name: 'lookup',
        parameters: { type: 'object' },
        strict: false,
      },
    ],
    tool_choice: 'auto',
  } as ResponsesPayload;

  stripUnsupportedToolsFromPayload(payload);

  assertEquals(payload.tools?.length, 1);
  assertEquals(payload.tools?.[0].type, 'function');
  assertEquals(payload.tool_choice, 'auto');
});

test('stripUnsupportedToolsFromPayload removes forced image_generation tool_choice', () => {
  const payload = {
    model: 'gpt-test',
    input: 'draw this',
    tools: [{ type: 'image_generation' }],
    tool_choice: { type: 'image_generation' },
  } as ResponsesPayload;

  stripUnsupportedToolsFromPayload(payload);

  assertFalse('tools' in payload);
  assertFalse('tool_choice' in payload);
});

test('stripUnsupportedToolsFromPayload removes required tool_choice when no tools remain', () => {
  const payload = {
    model: 'gpt-test',
    input: 'draw this',
    tools: [{ type: 'image_generation' }],
    tool_choice: 'required',
  } as ResponsesPayload;

  stripUnsupportedToolsFromPayload(payload);

  assertFalse('tools' in payload);
  assertFalse('tool_choice' in payload);
});

test('stripUnsupportedToolsFromPayload removes Codex hosted server tools that lack a name', () => {
  // Codex emits hosted Responses entries (web_search, tool_search, namespace,
  // image_generation) alongside ordinary function tools. None carry a top-level
  // `name`/`parameters` pair, so leaking them into translation produces malformed
  // Anthropic Messages tool entries (`tools.N.custom.name: Field required`).
  const payload = {
    model: 'gpt-test',
    input: 'search the web',
    tools: [
      {
        type: 'function',
        name: 'lookup',
        parameters: { type: 'object' },
        strict: false,
      },
      { type: 'web_search' },
      { type: 'tool_search', execution: 'x', description: 'y', parameters: {} },
      { type: 'namespace', name: 'ns', tools: [] },
      { type: 'image_generation', output_format: 'png' },
    ],
    tool_choice: 'auto',
  } as ResponsesPayload;

  stripUnsupportedToolsFromPayload(payload);

  assertEquals(payload.tools?.length, 1);
  assertEquals(payload.tools?.[0].type, 'function');
  assertEquals(payload.tool_choice, 'auto');
});

test('stripUnsupportedToolsFromPayload removes a forced web_search tool_choice', () => {
  const payload = {
    model: 'gpt-test',
    input: 'search',
    tools: [{ type: 'web_search' }],
    tool_choice: { type: 'web_search' },
  } as ResponsesPayload;

  stripUnsupportedToolsFromPayload(payload);

  assertFalse('tools' in payload);
  assertFalse('tool_choice' in payload);
});

test('stripUnsupportedToolsFromPayload removes leftover custom Freeform tools', () => {
  // fix-apply-patch-tools rewrites `apply_patch` into a function tool before
  // this interceptor runs. Any remaining `custom` entry is a Freeform tool the
  // gateway has no shim for and would surface upstream as
  // `tools.N.custom.name: Field required`.
  const payload = {
    model: 'gpt-test',
    input: 'do x',
    tools: [
      {
        type: 'function',
        name: 'lookup',
        parameters: { type: 'object' },
        strict: false,
      },
      { type: 'custom', name: 'freeform_other', description: 'x' },
    ],
    tool_choice: { type: 'custom', name: 'freeform_other' },
  } as ResponsesPayload;

  stripUnsupportedToolsFromPayload(payload);

  assertEquals(payload.tools?.length, 1);
  assertEquals(payload.tools?.[0].name, 'lookup');
  assertFalse('tool_choice' in payload);
});
