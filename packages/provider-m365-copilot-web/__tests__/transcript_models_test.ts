import { describe, expect, it, vi } from 'vitest';

import { CONFIG, stateFixture } from './fixtures.ts';
import { M365_ALL_TONES_PROBE_TIMEOUT_MS, M365_MODELS, M365_TONE_PROBE_TIMEOUT_MS, probeAllM365Tones, probeM365Tone, projectM365Models } from '../src/models.ts';
import { SIGNALR_RECORD_SEPARATOR } from '../src/signalr.ts';
import { canonicalizeM365ChatMessages, canonicalizeM365ResponsesInput, digestM365History, digestM365RouteProfile } from '../src/transcript.ts';
import type { WebSocketConnection, WebSocketConnector, WebSocketMessage } from '@floway-dev/http';

const probeConnector = (observed: { sessionIds: string[]; conversationIds: string[]; starts: boolean[] }): WebSocketConnector => async url => {
  let controller!: ReadableStreamDefaultController<WebSocketMessage>;
  let closed = false;
  const readable = new ReadableStream<WebSocketMessage>({
    start(value) {
      controller = value;
      value.enqueue({ type: 'text', data: `{${SIGNALR_RECORD_SEPARATOR}`.replace('{', '{}') });
    },
  });
  const connection: WebSocketConnection = {
    readable,
    writable: new WritableStream<WebSocketMessage>({
      write(message) {
        if (message.type !== 'text' || !message.data.includes('"target":"chat"')) return;
        const chat = JSON.parse(message.data.split(SIGNALR_RECORD_SEPARATOR)[0]!);
        const request = chat.arguments[0];
        const parsedUrl = new URL(url);
        observed.sessionIds.push(parsedUrl.searchParams.get('X-SessionId')!);
        observed.conversationIds.push(parsedUrl.searchParams.get('ConversationId')!);
        observed.starts.push(request.isStartOfSession);
        const turnCount = observed.starts.length;
        controller.enqueue({
          type: 'text',
          data: JSON.stringify({ type: 1, target: 'update', arguments: [{ writeAtCursor: 'FLOWAY_M365_PROBE_OK' }] }) + SIGNALR_RECORD_SEPARATOR
            + JSON.stringify({ type: 2, item: { turnState: 'Completed', messages: [{ author: 'bot', messageId: `m${turnCount}`, turnCount }] } }) + SIGNALR_RECORD_SEPARATOR,
        });
      },
    }),
    protocol: '',
    closed: Promise.resolve({ code: 1000, reason: '', wasClean: true }),
    close: async () => {
      if (closed) return;
      closed = true;
      controller.close();
    },
  };
  return connection;
};

const hangingProbeConnector = (): WebSocketConnector => async () => {
  const readable = new ReadableStream<WebSocketMessage>({
    start(controller) { controller.enqueue({ type: 'text', data: `{${SIGNALR_RECORD_SEPARATOR}`.replace('{', '{}') }); },
  });
  return {
    readable,
    writable: new WritableStream<WebSocketMessage>(),
    protocol: '',
    closed: new Promise(() => {}),
    close: async () => {},
  };
};

describe('M365 transcript and models', () => {
  it('canonicalizes Chat and rejects all tool or image surfaces', () => {
    expect(canonicalizeM365ChatMessages([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }])).toEqual([{ role: 'user', content: 'hello' }]);
    expect(() => canonicalizeM365ChatMessages([{ role: 'tool', content: 'x', tool_call_id: 'call' }])).toThrow('tool');
    expect(() => canonicalizeM365ChatMessages([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }])).toThrow('image_url');
  });

  it('extracts Responses history and opaque handle', () => {
    const canonical = canonicalizeM365ResponsesInput({
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        { type: 'reasoning', id: 'r', summary: [], encrypted_content: `m365h1_${'a'.repeat(43)}` },
      ],
      instructions: 'be concise',
    });
    expect(canonical).toEqual({ history: [{ role: 'user', content: 'hello' }], requestedHandle: `m365h1_${'a'.repeat(43)}`, instructions: 'be concise' });
  });

  it('uses stable digests and publishes only live tone receipts', async () => {
    await expect(digestM365History([{ role: 'user', content: 'hello' }])).resolves.toMatch(/^[0-9a-f]{64}$/);
    await expect(digestM365RouteProfile({ modelId: 'm', tone: 't', surface: 'chat', framingRevision: 1 })).resolves.toMatch(/^[0-9a-f]{64}$/);
    const state = stateFixture();
    const now = Date.now();
    for (const model of M365_MODELS) state.toneReceipts[model.id] = { tone: model.tone, available: true, probedAt: new Date(now).toISOString(), expiresAt: now + 60_000 };
    const projected = projectM365Models(state, {}, {}, now);
    expect(projected).toHaveLength(M365_MODELS.length);
    expect(projected.every(model => model.endpoints.openaiChatCompletions && model.endpoints.openaiResponses && Object.keys(model.limits).length === 0 && model.pricing === undefined)).toBe(true);
  });

  it('probes every tone as a turn in one shared M365 conversation', async () => {
    const observed = { sessionIds: [] as string[], conversationIds: [] as string[], starts: [] as boolean[] };
    const receipts = await probeAllM365Tones({
      config: CONFIG,
      accessToken: 'access',
      connectWebSocket: probeConnector(observed),
    });
    expect(Object.keys(receipts)).toHaveLength(M365_MODELS.length);
    expect(new Set(observed.sessionIds).size).toBe(1);
    expect(new Set(observed.conversationIds).size).toBe(1);
    expect(observed.starts).toEqual([true, ...Array.from({ length: M365_MODELS.length - 1 }, () => false)]);
  });

  it('propagates caller abort and bounds per-tone and all-tone probe duration', async () => {
    const definition = M365_MODELS[0];
    const caller = new AbortController();
    const callerFailure = new Error('control caller aborted');
    const callerProbe = probeM365Tone({ config: CONFIG, definition, accessToken: 'access', connectWebSocket: hangingProbeConnector(), signal: caller.signal });
    const callerRejected = expect(callerProbe).rejects.toBe(callerFailure);
    caller.abort(callerFailure);
    await callerRejected;

    vi.useFakeTimers();
    try {
      const timedProbe = probeM365Tone({ config: CONFIG, definition, accessToken: 'access', connectWebSocket: hangingProbeConnector() });
      await vi.advanceTimersByTimeAsync(M365_TONE_PROBE_TIMEOUT_MS);
      await expect(timedProbe).resolves.toMatchObject({ available: false, diagnostic: 'M365 tone probe timed out' });

      const allProbes = probeAllM365Tones({ config: CONFIG, accessToken: 'access', connectWebSocket: hangingProbeConnector() });
      const allRejected = expect(allProbes).rejects.toMatchObject({ code: 'tone_probe_timeout', message: 'M365 tone probe run timed out' });
      await vi.advanceTimersByTimeAsync(M365_ALL_TONES_PROBE_TIMEOUT_MS);
      await allRejected;
    } finally {
      vi.useRealTimers();
    }
  });
});
