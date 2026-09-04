import { describe, expect, it, vi } from 'vitest';

import { recordFixture, stateFixture } from './fixtures.ts';
import { createM365CopilotWebProvider } from '../src/provider.ts';
import { SIGNALR_RECORD_SEPARATOR } from '../src/signalr.ts';
import type { M365CopilotWebUpstreamState } from '../src/state.ts';
import type { WebSocketConnection, WebSocketConnector, WebSocketMessage } from '@floway-dev/http';
import type { OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import { initProviderRepo, type ProviderRepo, type UpstreamCallOptions } from '@floway-dev/provider';

const harness = () => {
  const now = Date.now();
  let state: M365CopilotWebUpstreamState = {
    ...stateFixture(),
    accessToken: { token: 'access', expiresAt: now + 3_600_000, refreshedAt: new Date(now).toISOString(), credentialGeneration: 1 },
    toneReceipts: {
      'm365-copilot-auto': { tone: 'magic', available: true, probedAt: new Date(now).toISOString(), expiresAt: now + 3_600_000 },
    },
  };
  const sentPrompts: string[] = [];
  const sentRecords: string[] = [];
  let enabled = true;
  let expireToneAfterSave = false;
  let loseLeaseAtTerminal = false;
  let failConnection: Error | null = null;
  let failCleanup: Error | null = null;
  let hangHeartbeatRenewal = false;
  let stateSaves = 0;
  let answerIndex = 0;
  const connectWebSocket: WebSocketConnector = async () => {
    if (failConnection !== null) throw failConnection;
    let controller!: ReadableStreamDefaultController<WebSocketMessage>;
    let closed = false;
    const readable = new ReadableStream<WebSocketMessage>({
      start(value) {
        controller = value;
        value.enqueue({ type: 'text', data: `{${SIGNALR_RECORD_SEPARATOR}`.replace('{', '{}') });
      },
    });
    const close = async () => {
      if (closed) return;
      closed = true;
      controller.close();
    };
    const connection: WebSocketConnection = {
      readable,
      writable: new WritableStream<WebSocketMessage>({
        write(message) {
          if (message.type !== 'text') return;
          sentRecords.push(message.data);
          if (!message.data.includes('"target":"chat"')) return;
          const chat = JSON.parse(message.data.split(SIGNALR_RECORD_SEPARATOR)[0]!);
          sentPrompts.push(chat.arguments[0].message.text);
          answerIndex++;
          controller.enqueue({
            type: 'text',
            data: JSON.stringify({ type: 1, target: 'update', arguments: [{ writeAtCursor: `answer-${answerIndex}` }] }) + SIGNALR_RECORD_SEPARATOR
              + JSON.stringify({ type: 2, item: { turnState: 'Completed', messages: [{ author: 'bot', messageId: `m${answerIndex}` }] } }) + SIGNALR_RECORD_SEPARATOR,
          });
        },
      }),
      protocol: '',
      closed: Promise.resolve({ code: 1000, reason: '', wasClean: true }),
      close,
    };
    return connection;
  };
  const record = recordFixture(state);
  initProviderRepo(() => ({
    upstreams: {
      getById: async () => ({ ...record, enabled, state }),
      saveState: async (_id: string, mutate: (current: unknown) => unknown) => {
        stateSaves++;
        if (failCleanup !== null && stateSaves === 2) throw failCleanup;
        if (hangHeartbeatRenewal && stateSaves === 4) await new Promise<void>(() => {});
        if (loseLeaseAtTerminal && stateSaves === 4) {
          state = { ...state, accountLease: { claimToken: 'competing-claim', claimExpiresAt: Date.now() + 60_000 } };
        }
        state = mutate(state) as M365CopilotWebUpstreamState;
        if (expireToneAfterSave) {
          expireToneAfterSave = false;
          state = {
            ...state,
            toneReceipts: {
              ...state.toneReceipts,
              'm365-copilot-auto': { ...state.toneReceipts['m365-copilot-auto']!, expiresAt: 0 },
            },
          };
        }
      },
    },
  } as unknown as ProviderRepo));
  const provider = createM365CopilotWebProvider(record);
  const options = {
    fetcher: async () => { throw new Error('unexpected fetch'); },
    connectWebSocket,
    caller: { apiKeyId: 'api-key' },
    waitUntil: () => {},
    headers: new Headers(),
    wrapUpstreamCall: <T>(dispatch: () => Promise<T>) => dispatch(),
  } as UpstreamCallOptions & { caller: { apiKeyId: string } };
  return {
    provider,
    options,
    sentPrompts,
    sentRecords,
    getState: () => state,
    disable: () => { enabled = false; },
    expireToneOnClaim: () => { expireToneAfterSave = true; },
    loseLeaseBeforeTerminal: () => { loseLeaseAtTerminal = true; },
    failConnectionAndCleanup: (connectionError: Error, cleanupError: Error) => {
      failConnection = connectionError;
      failCleanup = cleanupError;
    },
    hangHeartbeat: () => { hangHeartbeatRenewal = true; },
  };
};

describe('M365 provider roundtrip', () => {
  it('round-trips Chat session handles and dispatches only the new transcript suffix', async () => {
    const h = harness();
    const model = (await h.provider.instance.getProvidedModels(h.options.fetcher))[0]!;
    const first = await h.provider.instance.callOpenAIChatCompletions(model, { messages: [{ role: 'user', content: 'hello' }] }, undefined, h.options);
    expect(first.ok).toBe(true);
    const firstFrames = [];
    if (first.ok) for await (const frame of first.events) firstFrames.push(frame);
    const handle = firstFrames.flatMap(frame => frame.type === 'event' ? frame.event.choices : []).map(choice => choice.delta.reasoning_opaque).find(Boolean)!;
    expect(handle).toMatch(/^m365h1_[A-Za-z0-9_-]{43}$/);
    expect(Object.values(h.getState().sessions)[0]).toMatchObject({ status: 'active', turnCount: 1, historyLength: 2 });

    const second = await h.provider.instance.callOpenAIChatCompletions(model, {
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'answer-1', reasoning_opaque: handle },
        { role: 'user', content: 'next' },
      ],
    }, undefined, h.options);
    if (second.ok) for await (const _frame of second.events) { /* consume */ }
    expect(h.sentPrompts).toEqual(['<user>\nhello\n</user>', '<user>\nnext\n</user>']);
  });

  it('emits native Responses reasoning carrier and resumes from it', async () => {
    const h = harness();
    const model = (await h.provider.instance.getProvidedModels(h.options.fetcher))[0]!;
    const first = await h.provider.instance.callOpenAIResponses(model, {
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    }, 'generate', undefined, h.options);
    expect(first.action === 'generate' && first.ok).toBe(true);
    const events: OpenAIResponsesStreamEvent[] = [];
    if (first.action === 'generate' && first.ok) for await (const frame of first.events) if (frame.type === 'event') events.push(frame.event);
    const reasoning = events.find(event => event.type === 'response.output_item.done' && event.item.type === 'reasoning');
    const handle = reasoning && reasoning.type === 'response.output_item.done' && reasoning.item.type === 'reasoning' ? reasoning.item.encrypted_content : undefined;
    expect(handle).toMatch(/^m365h1_/);
    const messageDone = events.findIndex(event => event.type === 'response.output_item.done' && event.item.type === 'message');
    const reasoningAdded = events.findIndex(event => event.type === 'response.output_item.added' && event.item.type === 'reasoning');
    const completed = events.findIndex(event => event.type === 'response.completed');
    expect(messageDone).toBeGreaterThanOrEqual(0);
    expect(reasoningAdded).toBeGreaterThan(messageDone);
    expect(completed).toBeGreaterThan(reasoningAdded);

    const second = await h.provider.instance.callOpenAIResponses(model, {
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer-1' }] },
        { type: 'reasoning', id: 'reasoning', summary: [], encrypted_content: handle },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] },
      ],
    }, 'generate', undefined, h.options);
    if (second.action === 'generate' && second.ok) for await (const _frame of second.events) { /* consume */ }
    expect(h.sentPrompts).toEqual(['<user>\nhello\n</user>', '<user>\nnext\n</user>']);
  });

  it('rejects tools on both native surfaces', async () => {
    const h = harness();
    const model = (await h.provider.instance.getProvidedModels(h.options.fetcher))[0]!;
    const chat = await h.provider.instance.callOpenAIChatCompletions(model, {
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'x' } }],
    }, undefined, h.options);
    expect(chat.ok ? 200 : chat.response.status).toBe(400);
    const responses = await h.provider.instance.callOpenAIResponses(model, {
      input: [{ type: 'message', role: 'user', content: 'hello' }],
      tools: [{ type: 'function', name: 'x', parameters: null, strict: null }],
    }, 'generate', undefined, h.options);
    expect(responses.ok ? 200 : responses.response.status).toBe(400);
    const chatChoice = await h.provider.instance.callOpenAIChatCompletions(model, {
      messages: [{ role: 'user', content: 'hello' }],
      tool_choice: 'auto',
    }, undefined, h.options);
    expect(chatChoice.ok ? 200 : chatChoice.response.status).toBe(400);
    const responsesChoice = await h.provider.instance.callOpenAIResponses(model, {
      input: [{ type: 'message', role: 'user', content: 'hello' }],
      tool_choice: 'auto',
    }, 'generate', undefined, h.options);
    expect(responsesChoice.ok ? 200 : responsesChoice.response.status).toBe(400);
  });

  it('rejects a stale candidate after the upstream is disabled', async () => {
    const h = harness();
    const model = (await h.provider.instance.getProvidedModels(h.options.fetcher))[0]!;
    h.disable();
    await expect(h.provider.instance.getProvidedModels(h.options.fetcher)).resolves.toHaveLength(1);
    await expect(h.provider.instance.callOpenAIChatCompletions(model, { messages: [{ role: 'user', content: 'hello' }] }, undefined, h.options)).rejects.toThrow('disabled');
  });

  it('revalidates the tone receipt after acquiring the account claim', async () => {
    const h = harness();
    const model = (await h.provider.instance.getProvidedModels(h.options.fetcher))[0]!;
    h.expireToneOnClaim();
    const result = await h.provider.instance.callOpenAIChatCompletions(model, {
      messages: [{ role: 'user', content: 'hello' }],
    }, undefined, h.options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(409);
    expect(h.sentPrompts).toEqual([]);
    expect(h.getState().accountLease).toBeNull();
  });

  it('does not emit a Responses handle when the terminal lease fence is lost', async () => {
    const h = harness();
    const model = (await h.provider.instance.getProvidedModels(h.options.fetcher))[0]!;
    h.loseLeaseBeforeTerminal();
    const result = await h.provider.instance.callOpenAIResponses(model, {
      input: [{ type: 'message', role: 'user', content: 'hello' }],
    }, 'generate', undefined, h.options);
    expect(result.action === 'generate' && result.ok).toBe(true);
    const events: OpenAIResponsesStreamEvent[] = [];
    let streamError: unknown;
    if (result.action === 'generate' && result.ok) {
      try {
        for await (const frame of result.events) if (frame.type === 'event') events.push(frame.event);
      } catch (error) {
        streamError = error;
      }
    }
    expect(streamError).toMatchObject({ code: 'state_conflict' });
    expect(events.some(event => event.type === 'response.output_item.done' && event.item.type === 'reasoning')).toBe(false);
    expect(events.some(event => event.type === 'response.completed')).toBe(false);
    expect(Object.values(h.getState().sessions)[0]?.status).toBe('uncertain');
  });

  it('stops renewing and cancels a dispatched turn whose stream is never consumed', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const model = (await h.provider.instance.getProvidedModels(h.options.fetcher))[0]!;
      const result = await h.provider.instance.callOpenAIChatCompletions(model, {
        messages: [{ role: 'user', content: 'hello' }],
      }, undefined, h.options);
      expect(result.ok).toBe(true);
      expect(Object.values(h.getState().sessions)[0]?.status).toBe('uncertain');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.sentRecords.filter(record => record.includes('"target":"stop"'))).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts a dispatched turn when heartbeat renewal hangs while the consumer is paused', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.hangHeartbeat();
      const model = (await h.provider.instance.getProvidedModels(h.options.fetcher))[0]!;
      const result = await h.provider.instance.callOpenAIChatCompletions(model, {
        messages: [{ role: 'user', content: 'hello' }],
      }, undefined, h.options);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const iterator = result.events[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { type: 'event' } });
      await vi.advanceTimersByTimeAsync(40_000);
      expect(h.sentRecords.filter(record => record.includes('"target":"stop"'))).toHaveLength(1);
      await expect(iterator.next()).rejects.toThrow('heartbeat renewal timed out');
      expect(Object.values(h.getState().sessions)[0]?.status).toBe('uncertain');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves the originating failure when pre-dispatch cleanup also fails', async () => {
    const h = harness();
    const connectionError = new Error('connect failed');
    const cleanupError = new Error('cleanup failed');
    h.failConnectionAndCleanup(connectionError, cleanupError);
    const model = (await h.provider.instance.getProvidedModels(h.options.fetcher))[0]!;
    const error = await h.provider.instance.callOpenAIChatCompletions(model, {
      messages: [{ role: 'user', content: 'hello' }],
    }, undefined, h.options).catch(value => value);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({ cause: connectionError, errors: [connectionError, cleanupError] });
  });
});
