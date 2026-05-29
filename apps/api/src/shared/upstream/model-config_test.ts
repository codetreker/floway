import { test } from 'vitest';

import { modelsField } from './model-config.ts';
import { assertEquals, assertThrows } from '../../test-assert.ts';

test('modelsField parses a full model entry', () => {
  const models = modelsField(
    [
      {
        upstreamModelId: 'gpt-prod',
        publicModelId: 'gpt-5',
        supportedEndpoints: ['/chat/completions', '/responses'],
        display_name: 'GPT Prod',
        limits: { max_context_window_tokens: 128000, max_output_tokens: 4096 },
        cost: { input: 2.5, output: 15, input_cache_read: 0.25, input_cache_write: 3.75 },
        flagOverrides: { enabled: true, values: { 'vendor-deepseek': false } },
      },
    ],
    'azure',
  );

  assertEquals(models, [
    {
      upstreamModelId: 'gpt-prod',
      publicModelId: 'gpt-5',
      kind: 'chat',
      supportedEndpoints: ['/chat/completions', '/responses'],
      display_name: 'GPT Prod',
      limits: { max_context_window_tokens: 128000, max_output_tokens: 4096 },
      cost: { input: 2.5, output: 15, input_cache_read: 0.25, input_cache_write: 3.75 },
      flagOverrides: { enabled: true, values: { 'vendor-deepseek': false } },
    },
  ]);
});

test('modelsField parses a minimal model entry', () => {
  const models = modelsField(
    [{ upstreamModelId: 'gpt-prod', supportedEndpoints: ['/chat/completions'] }],
    'custom',
  );

  assertEquals(models, [{ upstreamModelId: 'gpt-prod', kind: 'chat', supportedEndpoints: ['/chat/completions'] }]);
});

test('modelsField rejects a missing upstreamModelId', () => {
  assertThrows(
    () => modelsField([{ supportedEndpoints: ['/chat/completions'] }], 'azure'),
    Error,
    'Malformed azure models[0].upstreamModelId: must be a non-empty string',
  );
});

test('modelsField returns an empty array for an empty list', () => {
  assertEquals(modelsField([], 'custom'), []);
});

test('modelsField rejects a non-array', () => {
  assertThrows(
    () => modelsField({}, 'custom'),
    Error,
    'Malformed custom upstream config: models must be an array',
  );
});

test('modelsField rejects a non-object entry', () => {
  assertThrows(
    () => modelsField(['not-an-object'], 'azure'),
    Error,
    'Malformed azure models[0]: must be an object',
  );
});

test('modelsField rejects an empty supportedEndpoints array', () => {
  assertThrows(
    () => modelsField([{ upstreamModelId: 'gpt-prod', supportedEndpoints: [] }], 'azure'),
    Error,
    'Malformed azure models[0].supportedEndpoints: must be a non-empty string array',
  );
});

test('modelsField rejects an unsupported supportedEndpoints entry', () => {
  assertThrows(
    () => modelsField([{ upstreamModelId: 'gpt-prod', supportedEndpoints: ['/bogus'] }], 'azure'),
    Error,
    'Malformed azure models[0].supportedEndpoints: unsupported entry /bogus',
  );
});

test('modelsField derives kind from endpoints when omitted', () => {
  const [embedding] = modelsField([{ upstreamModelId: 'e', supportedEndpoints: ['/embeddings'] }], 'custom');
  assertEquals(embedding.kind, 'embedding');
  const [image] = modelsField([{ upstreamModelId: 'i', supportedEndpoints: ['/v1/images/generations', '/v1/images/edits'] }], 'custom');
  assertEquals(image.kind, 'image');
  const [chat] = modelsField([{ upstreamModelId: 'c', supportedEndpoints: ['/responses'] }], 'custom');
  assertEquals(chat.kind, 'chat');
});

test('modelsField accepts a valid kind and rejects an unknown one', () => {
  const models = modelsField(
    [{ upstreamModelId: 'm', kind: 'embedding', supportedEndpoints: ['/embeddings'] }],
    'custom',
  );
  assertEquals(models[0].kind, 'embedding');
  assertThrows(
    () => modelsField([{ upstreamModelId: 'm', kind: 'bogus', supportedEndpoints: ['/chat/completions'] }], 'custom'),
    Error,
    'Malformed custom models[0].kind: must be one of chat, embedding, image',
  );
});

test('modelsField accepts cost with only a subset of dimensions set', () => {
  const models = modelsField(
    [{ upstreamModelId: 'gpt-prod', supportedEndpoints: ['/chat/completions'], cost: { input: 2.5 } }],
    'azure',
  );
  assertEquals(models[0].cost, { input: 2.5 });
});

test('modelsField rejects cost with a negative input', () => {
  assertThrows(
    () =>
      modelsField(
        [{ upstreamModelId: 'gpt-prod', supportedEndpoints: ['/chat/completions'], cost: { input: -1, output: 1 } }],
        'azure',
      ),
    Error,
    'Malformed azure models[0].cost.input: must be a finite non-negative number',
  );
});

test('modelsField rejects a non-boolean flagOverrides.enabled', () => {
  assertThrows(
    () =>
      modelsField(
        [
          {
            upstreamModelId: 'gpt-prod',
            supportedEndpoints: ['/chat/completions'],
            flagOverrides: { enabled: 'yes', values: {} },
          },
        ],
        'azure',
      ),
    Error,
    'Malformed azure models[0].flagOverrides.enabled: must be a boolean',
  );
});

test('modelsField rejects flagOverrides with an unknown flag id', () => {
  assertThrows(
    () =>
      modelsField(
        [
          {
            upstreamModelId: 'gpt-prod',
            supportedEndpoints: ['/chat/completions'],
            flagOverrides: { enabled: true, values: { 'made-up-flag': true } },
          },
        ],
        'azure',
      ),
    Error,
    'Malformed azure models[0].flagOverrides.values: unknown flag ids: made-up-flag',
  );
});
