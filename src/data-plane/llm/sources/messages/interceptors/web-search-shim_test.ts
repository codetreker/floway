import { test } from 'vitest';

import {
  collectAndRewriteMessagesWebSearchEventsToNative,
  decodeWebSearchCitationPayload,
  decodeWebSearchResultPayload,
  encodeWebSearchCitationPayload,
  encodeWebSearchResultPayload,
  type MessagesWebSearchShimState,
  prepareMessagesWebSearchShimRequest,
  rewriteMessagesWebSearchResponseToNative,
  withMessagesWebSearchShim,
} from './web-search-shim.ts';
import { initRepo } from '../../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../../repo/memory.ts';
import { assertEquals, assertExists } from '../../../../../test-assert.ts';
import type {
  MessagesAssistantContentBlock,
  MessagesClientTool,
  MessagesPayload,
  MessagesResponse,
  MessagesStreamEventData,
  MessagesTextBlock,
  MessagesToolResultBlock,
  MessagesToolResultContentBlock,
  MessagesUserContentBlock,
} from '../../../../shared/protocol/messages.ts';
import { type WebSearchProvider } from '../../../../tools/web-search/provider.ts';
import { DEFAULT_SEARCH_CONFIG } from '../../../../tools/web-search/search-config.ts';
import type { WebSearchProviderResult } from '../../../../tools/web-search/types.ts';
import type { MessagesExchangeContext } from '../../../interceptors.ts';
import { messagesResultToEvents } from '../../../shared/protocol/messages.ts';
import { type ProtocolFrame } from '../../../shared/stream/types.ts';
import { collectMessagesProtocolEventsToResponse } from '../events/to-response.ts';
import { messagesProtocolFrameToSSEFrame } from '../events/to-sse.ts';

const testTelemetryModelIdentity = {
  model: 'test-model',
  upstream: 'test-upstream',
  modelKey: 'test-model-key',
};

const exchangeContext = (payload: MessagesPayload, apiKeyId?: string): MessagesExchangeContext => ({
  sourceApi: 'messages',
  targetApi: 'messages',
  model: payload.model,
  upstream: 'test-upstream',
  upstreamModel: {} as never,
  provider: {} as never,
  enabledFixes: new Set(),
  payload,
  ...(apiKeyId !== undefined ? { apiKeyId } : {}),
});

const encodeUnsignedPayload = (payload: unknown): string => `cgws1.${btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;

const makeNativeReplayPayload = (): MessagesPayload => ({
  model: 'claude-test',
  max_tokens: 64,
  tools: [{ type: 'web_search_20260209', max_uses: 2 }],
  messages: [
    { role: 'user', content: 'latest React docs' },
    {
      role: 'assistant',
      content: [
        {
          type: 'server_tool_use',
          id: 'srvtoolu_1',
          name: 'web_search',
          input: { query: 'latest React docs' },
        },
        {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: [
            {
              type: 'web_search_result',
              url: 'https://react.dev',
              title: 'React',
              encrypted_content: encodeWebSearchResultPayload({
                content: [{ type: 'text', text: 'Official React documentation' }],
              }),
            },
          ],
        },
        {
          type: 'text',
          text: 'Use the React docs.',
          citations: [
            {
              type: 'web_search_result_location',
              url: 'https://react.dev',
              title: 'React',
              encrypted_index: encodeWebSearchCitationPayload({
                search_result_index: 0,
                start_block_index: 0,
                end_block_index: 0,
              }),
              cited_text: 'Official React documentation',
            },
          ],
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_calc_1',
          content: '4',
        },
      ],
    },
  ],
});

const activeMessagesWebSearchShimState = (overrides: Partial<Extract<MessagesWebSearchShimState, { mode: 'active' }>> = {}): Extract<MessagesWebSearchShimState, { mode: 'active' }> => ({
  mode: 'active',
  toolVersion: 'web_search_20260209',
  maxUses: 2,
  priorSearchUseCount: 0,
  requestSearchResultOwnership: [],
  ...overrides,
});

const makeUpstreamToolUseResponse = (toolUses: Array<{ name: string; id: string; input: Record<string, unknown> }>): MessagesResponse => ({
  id: 'msg_upstream',
  type: 'message',
  role: 'assistant',
  model: 'claude-test',
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: {
    input_tokens: 10,
    output_tokens: 3,
  },
  content: toolUses.map(toolUse => ({
    type: 'tool_use',
    id: toolUse.id,
    name: toolUse.name,
    input: toolUse.input,
  })),
});

const fakeProviderOk: WebSearchProvider = () =>
  Promise.resolve({
    type: 'ok',
    results: [
      {
        source: 'https://react.dev',
        title: 'React',
        pageAge: '2026-04-01',
        content: [{ type: 'text', text: 'Official React docs' }],
      },
    ],
  });

const activeProvider = (search: WebSearchProvider, apiKeyId?: string) =>
  Object.assign(search, {
    providerName: 'tavily' as const,
    search,
    ...(apiKeyId ? { apiKeyId } : {}),
  });

const fakeProviderError =
  (errorCode: Extract<WebSearchProviderResult, { type: 'error' }>['errorCode']): WebSearchProvider =>
    () =>
      Promise.resolve({ type: 'error', errorCode });

const toAsyncIterable = async function* <T>(values: Iterable<T>): AsyncGenerator<T> {
  for (const value of values) {
    yield value;
  }
};

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];

  for await (const event of events) {
    collected.push(event);
  }

  return collected;
};

const messagesResponseToProtocolFrames = (response: MessagesResponse): ProtocolFrame<MessagesStreamEventData>[] => messagesResultToEvents(response);

test('web search shim payload codecs use minimal cgws1 payloads', () => {
  const encryptedContent = encodeWebSearchResultPayload({
    content: [{ type: 'text', text: 'Claude Shannon was born in 1916.' }],
  });

  assertExists(decodeWebSearchResultPayload(encryptedContent));
  assertEquals(decodeWebSearchResultPayload('foreign.payload'), null);

  const encryptedIndex = encodeWebSearchCitationPayload({
    search_result_index: 0,
    start_block_index: 0,
    end_block_index: 0,
  });

  assertEquals(decodeWebSearchCitationPayload(encryptedIndex)?.search_result_index, 0);

  const encodedExtraResult = encodeUnsignedPayload({
    content: [{ type: 'text', text: 'Claude Shannon was born in 1916.' }],
    extra: true,
  });
  assertEquals(decodeWebSearchResultPayload(encodedExtraResult), null);

  const encodedExtraCitation = encodeUnsignedPayload({
    search_result_index: 0,
    start_block_index: 0,
    end_block_index: 0,
    extra: true,
  });
  assertEquals(decodeWebSearchCitationPayload(encodedExtraCitation), null);

  assertEquals(
    decodeWebSearchCitationPayload(
      encodeUnsignedPayload({
        search_result_index: -1,
        start_block_index: 0,
        end_block_index: 0,
      }),
    ),
    null,
  );

  assertEquals(
    decodeWebSearchCitationPayload(
      encodeUnsignedPayload({
        search_result_index: 0,
        start_block_index: -1,
        end_block_index: 0,
      }),
    ),
    null,
  );

  assertEquals(
    decodeWebSearchCitationPayload(
      encodeUnsignedPayload({
        search_result_index: 0,
        start_block_index: 2,
        end_block_index: 1,
      }),
    ),
    null,
  );
});

test('prepareMessagesWebSearchShimRequest rewrites both native tool versions to client tools without renaming web_search', () => {
  for (const type of ['web_search_20250305', 'web_search_20260209'] as const) {
    const prepared = prepareMessagesWebSearchShimRequest({
      model: 'claude-test',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'latest React docs' }],
      tools: [{ type, name: 'web_search', max_uses: 2 }],
      tool_choice: { type: 'tool', name: 'web_search' },
    });

    assertEquals(prepared.type, 'ok');
    if (prepared.type !== 'ok') throw new Error('expected ok result');
    const rewrittenTool = prepared.payload.tools?.[0] as MessagesClientTool;
    assertEquals(rewrittenTool.name, 'web_search');
    assertEquals(rewrittenTool.description, 'The web_search tool searches the internet and returns up-to-date information from web sources.');
    assertEquals(rewrittenTool.input_schema, {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query',
        },
      },
      required: ['query'],
    });
    assertEquals(prepared.payload.tool_choice, {
      type: 'tool',
      name: 'web_search',
    });
    assertEquals(prepared.state.mode, 'active');
    if (prepared.state.mode !== 'active') {
      throw new Error('expected active state');
    }
    assertEquals(prepared.state.toolVersion, type);
  }
});

test('prepareMessagesWebSearchShimRequest rejects duplicate native tools', () => {
  const prepared = prepareMessagesWebSearchShimRequest({
    model: 'claude-test',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'latest React docs' }],
    tools: [{ type: 'web_search_20250305' }, { type: 'web_search_20260209' }],
  });

  assertEquals(prepared, {
    type: 'invalid-request',
    message: 'Only one native web search tool definition is supported per request.',
  });
});

test('prepareMessagesWebSearchShimRequest rejects native web search tools whose name is not web_search', () => {
  for (const type of ['web_search_20250305', 'web_search_20260209'] as const) {
    const prepared = prepareMessagesWebSearchShimRequest({
      model: 'claude-test',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'latest React docs' }],
      tools: [{ type, name: 'WebSearch' }],
    });

    assertEquals(prepared, {
      type: 'invalid-request',
      message: `tools.0.${type}.name: Input should be 'web_search'`,
    });
  }
});

test('prepareMessagesWebSearchShimRequest rejects native web search name collisions with client tools', () => {
  const prepared = prepareMessagesWebSearchShimRequest({
    model: 'claude-test',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'latest React docs' }],
    tools: [
      { type: 'web_search_20260209', name: 'web_search' },
      {
        name: 'web_search',
        description: 'user-defined tool',
        input_schema: { type: 'object' },
      },
    ],
  });

  assertEquals(prepared, {
    type: 'invalid-request',
    message: 'Native web search tool name collides with another client tool: web_search.',
  });
});

test('prepareMessagesWebSearchShimRequest decodes our native-looking replay into upstream tool history', () => {
  const prepared = prepareMessagesWebSearchShimRequest(makeNativeReplayPayload());

  assertEquals(prepared.type, 'ok');
  if (prepared.type !== 'ok') throw new Error('expected ok result');

  const assistant = prepared.payload.messages[1];
  const user = prepared.payload.messages[2];

  assertEquals((assistant.content as MessagesAssistantContentBlock[])[0].type, 'tool_use');
  assertEquals(((assistant.content as MessagesAssistantContentBlock[])[1] as MessagesTextBlock).citations?.[0]?.type, 'search_result_location');
  assertEquals((((user.content as MessagesUserContentBlock[])[0] as MessagesToolResultBlock).content as MessagesToolResultContentBlock[])[0].type, 'search_result');
  assertEquals((user.content as MessagesUserContentBlock[]).length, 2);
  assertEquals(prepared.state.mode, 'active');
  if (prepared.state.mode !== 'active') {
    throw new Error('expected active state');
  }
  assertEquals(prepared.state.priorSearchUseCount, 1);
  assertEquals(prepared.state.requestSearchResultOwnership, ['owned']);
});

test('prepareMessagesWebSearchShimRequest leaves native-looking replay errors untouched', () => {
  const payload: MessagesPayload = {
    model: 'claude-test',
    max_tokens: 64,
    messages: [
      { role: 'user', content: 'latest React docs' },
      {
        role: 'assistant',
        content: [
          {
            type: 'server_tool_use',
            id: 'srvtoolu_1',
            name: 'web_search',
            input: { query: 'latest React docs' },
          },
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_1',
            content: {
              type: 'web_search_tool_result_error',
              error_code: 'too_many_requests',
            },
          },
        ],
      },
    ],
  };

  const prepared = prepareMessagesWebSearchShimRequest(payload);

  assertEquals(prepared.type, 'ok');
  if (prepared.type !== 'ok') throw new Error('expected ok result');

  assertEquals(prepared.state.mode === 'inactive', true);
  assertEquals(prepared.payload, payload);
});

test('prepareMessagesWebSearchShimRequest passes through foreign native-looking history that does not decode', () => {
  const payload: MessagesPayload = {
    model: 'claude-test',
    max_tokens: 64,
    messages: [
      { role: 'user', content: 'latest React docs' },
      {
        role: 'assistant',
        content: [
          {
            type: 'server_tool_use',
            id: 'srvtoolu_foreign',
            name: 'web_search',
            input: { query: 'latest React docs' },
          },
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_foreign',
            content: [
              {
                type: 'web_search_result',
                url: 'https://react.dev',
                title: 'React',
                encrypted_content: 'foreign.payload',
              },
            ],
          },
        ],
      },
    ],
  };

  const prepared = prepareMessagesWebSearchShimRequest(payload);

  assertEquals(prepared.type, 'ok');
  if (prepared.type !== 'ok') throw new Error('expected ok result');

  assertEquals(prepared.state.mode === 'inactive', true);
  assertEquals(prepared.payload, payload);
});

test('prepareMessagesWebSearchShimRequest creates a separate user tool_result message when the trailing user message is not a tool_result turn', () => {
  const payload: MessagesPayload = {
    model: 'claude-test',
    max_tokens: 64,
    messages: [
      { role: 'user', content: 'latest React docs' },
      {
        role: 'assistant',
        content: [
          {
            type: 'server_tool_use',
            id: 'srvtoolu_1',
            name: 'web_search',
            input: { query: 'latest React docs' },
          },
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_1',
            content: [
              {
                type: 'web_search_result',
                url: 'https://react.dev',
                title: 'React',
                encrypted_content: encodeWebSearchResultPayload({
                  content: [
                    {
                      type: 'text',
                      text: 'Official React documentation',
                    },
                  ],
                }),
              },
            ],
          },
        ],
      },
      { role: 'user', content: 'thanks' },
    ],
  };

  const prepared = prepareMessagesWebSearchShimRequest(payload);

  assertEquals(prepared.type, 'ok');
  if (prepared.type !== 'ok') throw new Error('expected ok result');

  assertEquals(prepared.payload.messages.length, 4);
  assertEquals(prepared.payload.messages[2].role, 'user');
  assertEquals(((prepared.payload.messages[2].content as MessagesUserContentBlock[])[0] as MessagesToolResultBlock).type, 'tool_result');
  assertEquals(prepared.payload.messages[3], {
    role: 'user',
    content: 'thanks',
  });
});

test('rewriteMessagesWebSearchResponseToNative converts pure web_search tool_use into pause_turn', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  const rewritten = await rewriteMessagesWebSearchResponseToNative(
    makeUpstreamToolUseResponse([
      {
        name: 'web_search',
        id: 'toolu_1',
        input: { query: 'latest React docs' },
      },
    ]),
    activeMessagesWebSearchShimState(),
    activeProvider(fakeProviderOk, 'key_usage'),
  );

  assertEquals(rewritten.stop_reason, 'pause_turn');
  assertEquals(rewritten.content[0].type, 'server_tool_use');
  assertEquals(rewritten.content[1].type, 'web_search_tool_result');
  assertEquals((rewritten.content[1] as { caller?: { type: string } }).caller, { type: 'direct' });
  assertEquals(rewritten.usage.server_tool_use?.web_search_requests, 1);
  assertEquals(await repo.searchUsage.listAll(), [
    {
      provider: 'tavily',
      keyId: 'key_usage',
      hour: new Date().toISOString().slice(0, 13),
      requests: 1,
    },
  ]);
});

test('rewriteMessagesWebSearchResponseToNative keeps remaining client tool_use in mixed turn', async () => {
  const rewritten = await rewriteMessagesWebSearchResponseToNative(
    makeUpstreamToolUseResponse([
      {
        name: 'web_search',
        id: 'toolu_1',
        input: { query: 'latest React docs' },
      },
      { name: 'calc', id: 'toolu_2', input: { expression: '2+2' } },
    ]),
    activeMessagesWebSearchShimState(),
    activeProvider(fakeProviderOk),
  );

  assertEquals(rewritten.stop_reason, 'tool_use');
  assertEquals(
    rewritten.content.some((block: MessagesAssistantContentBlock) => block.type === 'tool_use'),
    true,
  );
  assertEquals(
    rewritten.content.some((block: MessagesAssistantContentBlock) => block.type === 'server_tool_use'),
    true,
  );
});

test('rewriteMessagesWebSearchResponseToNative synthesizes max_uses_exceeded without calling the provider', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  let called = false;

  const rewritten = await rewriteMessagesWebSearchResponseToNative(
    makeUpstreamToolUseResponse([
      {
        name: 'web_search',
        id: 'toolu_1',
        input: { query: 'latest React docs' },
      },
    ]),
    activeMessagesWebSearchShimState({ maxUses: 1, priorSearchUseCount: 1 }),
    activeProvider(() => {
      called = true;
      return Promise.resolve({
        type: 'ok',
        results: [],
      });
    }, 'key_usage'),
  );

  assertEquals(called, false);
  assertEquals(rewritten.content[1], {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_1',
    caller: { type: 'direct' },
    content: {
      type: 'web_search_tool_result_error',
      error_code: 'max_uses_exceeded',
    },
  });
  assertEquals(rewritten.usage.server_tool_use, undefined);
  assertEquals(await repo.searchUsage.listAll(), []);
});

test('rewriteMessagesWebSearchResponseToNative maps provider errors into native-looking tool-result errors', async () => {
  const rewritten = await rewriteMessagesWebSearchResponseToNative(
    makeUpstreamToolUseResponse([
      {
        name: 'web_search',
        id: 'toolu_1',
        input: { query: 'latest React docs' },
      },
    ]),
    activeMessagesWebSearchShimState(),
    activeProvider(fakeProviderError('too_many_requests')),
  );

  assertEquals(rewritten.content[1], {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_1',
    caller: { type: 'direct' },
    content: {
      type: 'web_search_tool_result_error',
      error_code: 'too_many_requests',
    },
  });
  assertEquals(rewritten.stop_reason, 'pause_turn');
});

test('rewriteMessagesWebSearchResponseToNative uses invalid_tool_input for blank queries', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  const rewritten = await rewriteMessagesWebSearchResponseToNative(
    makeUpstreamToolUseResponse([
      {
        name: 'web_search',
        id: 'toolu_1',
        input: { query: '   ' },
      },
    ]),
    activeMessagesWebSearchShimState(),
    activeProvider(fakeProviderOk, 'key_usage'),
  );

  assertEquals(rewritten.content[1], {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_1',
    caller: { type: 'direct' },
    content: {
      type: 'web_search_tool_result_error',
      error_code: 'invalid_tool_input',
    },
  });
  assertEquals(rewritten.stop_reason, 'pause_turn');
  assertEquals(await repo.searchUsage.listAll(), []);
});

test('rewriteMessagesWebSearchResponseToNative uses query_too_long without recording usage', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  const rewritten = await rewriteMessagesWebSearchResponseToNative(
    makeUpstreamToolUseResponse([
      {
        name: 'web_search',
        id: 'toolu_1',
        input: { query: 'x'.repeat(1001) },
      },
    ]),
    activeMessagesWebSearchShimState(),
    activeProvider(fakeProviderOk, 'key_usage'),
  );

  assertEquals(rewritten.content[1], {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_1',
    caller: { type: 'direct' },
    content: {
      type: 'web_search_tool_result_error',
      error_code: 'query_too_long',
    },
  });
  assertEquals(rewritten.stop_reason, 'pause_turn');
  assertEquals(await repo.searchUsage.listAll(), []);
});

test('rewriteMessagesWebSearchResponseToNative forwards only definition-level domain policy to the provider', async () => {
  let providerRequest:
    | {
      query: string;
      allowedDomains?: string[];
      blockedDomains?: string[];
    }
    | undefined;

  const rewritten = await rewriteMessagesWebSearchResponseToNative(
    makeUpstreamToolUseResponse([
      {
        name: 'web_search',
        id: 'toolu_1',
        input: {
          query: 'latest React docs',
          allowed_domains: ['ignored.example.com'],
          blocked_domains: ['also-ignored.example.com'],
        },
      },
    ]),
    activeMessagesWebSearchShimState({
      allowedDomains: ['react.dev'],
      blockedDomains: ['example.com'],
    }),
    activeProvider(request => {
      providerRequest = {
        query: request.query,
        allowedDomains: request.allowedDomains,
        blockedDomains: request.blockedDomains,
      };
      return Promise.resolve({
        type: 'ok',
        results: [],
      });
    }),
  );

  assertEquals(providerRequest, {
    query: 'latest React docs',
    allowedDomains: ['react.dev'],
    blockedDomains: ['example.com'],
  });
  assertEquals(rewritten.stop_reason, 'pause_turn');
});

test('rewriteMessagesWebSearchResponseToNative counts thrown provider attempts toward max_uses within the same turn', async () => {
  let callCount = 0;

  const rewritten = await rewriteMessagesWebSearchResponseToNative(
    makeUpstreamToolUseResponse([
      {
        name: 'web_search',
        id: 'toolu_1',
        input: { query: 'latest React docs' },
      },
      {
        name: 'web_search',
        id: 'toolu_2',
        input: { query: 'latest React docs again' },
      },
    ]),
    activeMessagesWebSearchShimState({ maxUses: 1 }),
    activeProvider(() => {
      callCount += 1;
      return Promise.reject(new Error('provider exploded'));
    }),
  );

  assertEquals(callCount, 1);
  assertEquals(rewritten.usage.server_tool_use?.web_search_requests, 1);
  assertEquals(rewritten.content[1], {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_1',
    caller: { type: 'direct' },
    content: {
      type: 'web_search_tool_result_error',
      error_code: 'unavailable',
    },
  });
  assertEquals(rewritten.content[3], {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_2',
    caller: { type: 'direct' },
    content: {
      type: 'web_search_tool_result_error',
      error_code: 'max_uses_exceeded',
    },
  });
});

test('rewriteMessagesWebSearchResponseToNative rewrites search_result_location citations only for owned indices', async () => {
  const rewritten = await rewriteMessagesWebSearchResponseToNative(
    {
      id: 'msg_citations',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
      content: [
        {
          type: 'text',
          text: 'Use the docs.',
          citations: [
            {
              type: 'search_result_location',
              url: 'https://react.dev',
              title: 'React',
              search_result_index: 0,
              start_block_index: 0,
              end_block_index: 0,
              cited_text: 'Official docs',
            },
            {
              type: 'search_result_location',
              url: 'https://example.com',
              title: 'Foreign',
              search_result_index: 1,
              start_block_index: 0,
              end_block_index: 0,
              cited_text: 'Foreign docs',
            },
          ],
        },
      ],
    },
    activeMessagesWebSearchShimState({
      requestSearchResultOwnership: ['owned', 'foreign'],
    }),
    activeProvider(fakeProviderOk),
  );

  const textBlock = rewritten.content[0] as MessagesTextBlock;
  assertEquals(textBlock.citations?.[0]?.type, 'web_search_result_location');
  assertEquals(textBlock.citations?.[1]?.type, 'search_result_location');
});

test('collectAndRewriteMessagesWebSearchEventsToNative rewrites collected events once', async () => {
  const frames = collectAndRewriteMessagesWebSearchEventsToNative(
    toAsyncIterable(
      messagesResponseToProtocolFrames(
        makeUpstreamToolUseResponse([
          {
            name: 'web_search',
            id: 'toolu_1',
            input: { query: 'latest React docs' },
          },
        ]),
      ),
    ),
    activeMessagesWebSearchShimState(),
    activeProvider(fakeProviderOk),
  );

  const rewritten = await collectMessagesProtocolEventsToResponse(frames);

  assertEquals(rewritten.stop_reason, 'pause_turn');
  assertEquals(rewritten.content[0].type, 'server_tool_use');
  assertEquals(rewritten.content[1].type, 'web_search_tool_result');
});

test('rewriteMessagesWebSearchResponseToNative preserves user-defined web_search tool calls in replay-only mode', async () => {
  const { tools: _tools, ...replayPayload } = makeNativeReplayPayload();
  const prepared = prepareMessagesWebSearchShimRequest({
    ...replayPayload,
    tools: [
      {
        name: 'web_search',
        description: 'user-defined tool',
        input_schema: { type: 'object' },
      },
    ],
  });

  assertEquals(prepared.type, 'ok');
  if (prepared.type !== 'ok') throw new Error('expected ok result');

  let called = false;
  const upstreamResponse = makeUpstreamToolUseResponse([
    {
      name: 'web_search',
      id: 'toolu_1',
      input: { query: 'latest React docs' },
    },
  ]);

  const rewritten = await rewriteMessagesWebSearchResponseToNative(
    upstreamResponse,
    prepared.state,
    activeProvider(() => {
      called = true;
      return Promise.resolve({
        type: 'ok',
        results: [],
      });
    }),
  );

  assertEquals(called, false);
  assertEquals(rewritten, upstreamResponse);
});

test('withMessagesWebSearchShim returns internal-error when request requires disabled search config', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  await repo.searchConfig.save(DEFAULT_SEARCH_CONFIG);

  const result = await withMessagesWebSearchShim(
    exchangeContext({
      model: 'claude-test',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'latest React docs' }],
      tools: [{ type: 'web_search_20260209' }],
    }),
    () => Promise.reject(new Error('run should not be called')),
  );

  assertEquals(result.type, 'internal-error');
});

test('withMessagesWebSearchShim allows replay-only history when the search provider is disabled', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  await repo.searchConfig.save(DEFAULT_SEARCH_CONFIG);

  const { tools: _tools, ...payload } = makeNativeReplayPayload();

  const result = await withMessagesWebSearchShim(exchangeContext(payload), () =>
    Promise.resolve({
      type: 'events',
      events: toAsyncIterable(
        messagesResponseToProtocolFrames({
          id: 'msg_replay_only',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
          content: [
            {
              type: 'text',
              text: 'Use the docs.',
              citations: [
                {
                  type: 'search_result_location',
                  url: 'https://react.dev',
                  title: 'React',
                  search_result_index: 0,
                  start_block_index: 0,
                  end_block_index: 0,
                  cited_text: 'Official React documentation',
                },
              ],
            },
          ],
        }),
      ),
      modelIdentity: testTelemetryModelIdentity,
    }));

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('expected events result');

  const rewritten = await collectMessagesProtocolEventsToResponse(result.events);
  const textBlock = rewritten.content[0] as MessagesTextBlock;
  assertEquals(textBlock.citations?.[0]?.type, 'web_search_result_location');
});

test('withMessagesWebSearchShim emits native-like citation deltas for replay-only history', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  await repo.searchConfig.save(DEFAULT_SEARCH_CONFIG);

  const { tools: _tools, ...payload } = makeNativeReplayPayload();

  const result = await withMessagesWebSearchShim(exchangeContext(payload), () =>
    Promise.resolve({
      type: 'events',
      events: toAsyncIterable(
        messagesResponseToProtocolFrames({
          id: 'msg_replay_only_stream',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
          content: [
            {
              type: 'text',
              text: 'Use the docs.',
              citations: [
                {
                  type: 'search_result_location',
                  url: 'https://react.dev',
                  title: 'React',
                  search_result_index: 0,
                  start_block_index: 0,
                  end_block_index: 0,
                  cited_text: 'Official React documentation',
                },
              ],
            },
          ],
        }),
      ),
      modelIdentity: testTelemetryModelIdentity,
    }));

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('expected events result');

  const frames = (await collect(result.events)).map(messagesProtocolFrameToSSEFrame).filter(frame => frame !== null);
  const citationFrame = frames.find(frame => {
    if (frame.type !== 'sse' || frame.event !== 'content_block_delta') {
      return false;
    }

    return (JSON.parse(frame.data) as { delta?: { type?: string } }).delta?.type === 'citations_delta';
  });

  assertExists(citationFrame);
  const citation = (
    JSON.parse(citationFrame.data) as {
      delta: {
        citation: {
          type: string;
          url: string;
          title: string;
          encrypted_index: string;
        };
      };
    }
  ).delta.citation;

  assertEquals(citation.type, 'web_search_result_location');
  assertEquals(citation.url, 'https://react.dev');
  assertEquals(citation.title, 'React');
  assertEquals(decodeWebSearchCitationPayload(citation.encrypted_index), {
    search_result_index: 0,
    start_block_index: 0,
    end_block_index: 0,
  });
});
