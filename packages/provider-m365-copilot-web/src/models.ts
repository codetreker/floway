import { openM365ChatTurn, type M365ChatSession } from './chat.ts';
import type { M365CopilotWebUpstreamConfig } from './config.ts';
import { createM365Deadline, withM365Abort } from './deadline.ts';
import { M365CopilotWebError, M365StateConflictError } from './errors.ts';
import { M365_TONE_RECEIPT_TTL_MS, type M365CopilotWebUpstreamState, type M365ToneReceiptState } from './state.ts';
import type { WebSocketConnector } from '@floway-dev/http';
import { kindForEndpoints } from '@floway-dev/protocols/common';
import { resolveEffectiveFlags, type FlagOverrides, type ProviderModel } from '@floway-dev/provider';

export interface M365ModelDefinition {
  id: string;
  displayName: string;
  tone: string;
}

export const M365_TONE_PROBE_TIMEOUT_MS = 90_000;
export const M365_ALL_TONES_PROBE_TIMEOUT_MS = 10 * 60 * 1000;

// This is a probe candidate inventory, not an availability claim. Every model
// remains hidden until the configured account has a live receipt for its tone.
// https://github.com/cramt/m365-copilot-proxy/blob/d7c6d8080bf2bb769c1949c2dfbe60bb7ca929c3/packages/core/src/copilot.ts#L8-L60
export const M365_MODELS = [
  { id: 'm365-copilot-auto', displayName: 'M365 Copilot Auto', tone: 'magic' },
  { id: 'm365-copilot-quick', displayName: 'M365 Copilot Quick', tone: 'Gpt_Quick' },
  { id: 'm365-copilot-think-deeper', displayName: 'M365 Copilot Think Deeper', tone: 'Gpt_Reasoning' },
  { id: 'm365-copilot-claude-sonnet', displayName: 'M365 Copilot Claude Sonnet', tone: 'Claude_Sonnet' },
  { id: 'm365-copilot-claude-sonnet-think-deeper', displayName: 'M365 Copilot Claude Sonnet Think Deeper', tone: 'Claude_Sonnet_Reasoning' },
  { id: 'm365-copilot-claude-opus', displayName: 'M365 Copilot Claude Opus', tone: 'Claude_Opus' },
  { id: 'm365-copilot-gpt-5.2-quick', displayName: 'M365 Copilot GPT-5.2 Quick', tone: 'Gpt_5_2_Quick' },
  { id: 'm365-copilot-gpt-5.2-think-deeper', displayName: 'M365 Copilot GPT-5.2 Think Deeper', tone: 'Gpt_5_2_Reasoning' },
  { id: 'm365-copilot-gpt-5.3-quick', displayName: 'M365 Copilot GPT-5.3 Quick', tone: 'Gpt_5_3_Quick' },
  { id: 'm365-copilot-gpt-5.3-think-deeper', displayName: 'M365 Copilot GPT-5.3 Think Deeper', tone: 'Gpt_5_3_Reasoning' },
  { id: 'm365-copilot-gpt-5.4-quick', displayName: 'M365 Copilot GPT-5.4 Quick', tone: 'Gpt_5_4_Quick' },
  { id: 'm365-copilot-gpt-5.4-think-deeper', displayName: 'M365 Copilot GPT-5.4 Think Deeper', tone: 'Gpt_5_4_Reasoning' },
  { id: 'm365-copilot-gpt-5.5', displayName: 'M365 Copilot GPT-5.5', tone: 'Gpt_5_5_Chat' },
  { id: 'm365-copilot-gpt-5.5-think-deeper', displayName: 'M365 Copilot GPT-5.5 Think Deeper', tone: 'Gpt_5_5_Reasoning' },
  { id: 'm365-copilot-gpt-5.6-think-deeper', displayName: 'M365 Copilot GPT-5.6 Think Deeper', tone: 'Gpt_5_6_Reasoning' },
] as const satisfies readonly M365ModelDefinition[];

export type M365ModelId = typeof M365_MODELS[number]['id'];
export type M365ToneId = typeof M365_MODELS[number]['tone'];

export interface M365ProviderModelData {
  tone: M365ToneId;
}

export const m365ModelDefinition = (modelId: string): typeof M365_MODELS[number] => {
  const definition = M365_MODELS.find(model => model.id === modelId);
  if (definition === undefined) throw new Error(`Unknown M365 Copilot model '${modelId}'`);
  return definition;
};

export const projectM365Models = (
  state: M365CopilotWebUpstreamState,
  upstreamOverrides: FlagOverrides,
  defaults: FlagOverrides,
  now = Date.now(),
): ProviderModel[] => {
  const enabledFlags = resolveEffectiveFlags([defaults, upstreamOverrides]);
  const endpoints = { openaiChatCompletions: {}, openaiResponses: {} } as const;
  return M365_MODELS.flatMap(definition => {
    const receipt = state.toneReceipts[definition.id];
    if (receipt?.available !== true || receipt.tone !== definition.tone || receipt.expiresAt <= now) return [];
    return [{
      id: definition.id,
      display_name: definition.displayName,
      owned_by: 'microsoft',
      limits: {},
      kind: kindForEndpoints(endpoints),
      endpoints,
      providerData: { tone: definition.tone } satisfies M365ProviderModelData,
      enabledFlags,
    }];
  });
};

export interface M365ToneProbeInput {
  definition: M365ModelDefinition;
  config: M365CopilotWebUpstreamConfig;
  accessToken: string;
  connectWebSocket: WebSocketConnector;
  session?: M365ChatSession;
  signal?: AbortSignal;
  wrapUpstreamCall?: <T>(dispatch: () => Promise<T>) => Promise<T>;
  leaseFailure?: Promise<never>;
  now?: Date;
}

const runM365ToneProbe = async (input: M365ToneProbeInput, onDispatched?: () => void): Promise<M365ToneReceiptState> => {
  const now = input.now ?? new Date();
  const deadline = createM365Deadline(input.signal, M365_TONE_PROBE_TIMEOUT_MS, () => new M365CopilotWebError('tone_probe_timeout', 'M365 tone probe timed out'));
  try {
    const opened = await openM365ChatTurn({
      connectWebSocket: input.connectWebSocket,
      accessToken: input.accessToken,
      configuredChatHubHost: input.config.account.chatHubHost,
      configuredChatHubPath: input.config.account.chatHubPath,
      modelId: input.definition.id,
      tone: input.definition.tone,
      prompt: 'Reply with exactly: FLOWAY_M365_PROBE_OK',
      session: input.session ?? { sessionId: crypto.randomUUID(), conversationId: crypto.randomUUID(), turnCount: 0 },
      locale: input.config.locale,
      timeZone: input.config.timeZone,
      timeZoneOffsetMinutes: input.config.timeZoneOffsetMinutes,
      signal: deadline.signal,
      wrapUpstreamCall: input.wrapUpstreamCall ?? (dispatch => dispatch()),
    });
    const stream = await opened.dispatch();
    onDispatched?.();
    void stream.diagnostics.catch(() => undefined);
    let text = '';
    const iterator = stream.events[Symbol.asyncIterator]();
    let completed = false;
    try {
      while (true) {
        const result = await (input.leaseFailure === undefined ? iterator.next() : Promise.race([iterator.next(), input.leaseFailure]));
        if (result.done) break;
        if (result.value.type === 'event') text += result.value.event.choices[0]?.delta.content ?? '';
      }
      completed = true;
    } finally {
      await (completed ? stream.close() : stream.cancel()).catch(() => undefined);
      await iterator.return?.();
    }
    const diagnostics = await stream.diagnostics;
    const available = text.includes('FLOWAY_M365_PROBE_OK') && diagnostics.messageType !== 'Disengaged';
    return {
      tone: input.definition.tone,
      available,
      probedAt: now.toISOString(),
      expiresAt: now.getTime() + M365_TONE_RECEIPT_TTL_MS,
      ...(available ? {} : { diagnostic: `Unexpected probe response (${diagnostics.messageType ?? 'no message type'})` }),
    };
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason ?? new DOMException('Aborted', 'AbortError');
    if (error instanceof M365StateConflictError) throw error;
    return {
      tone: input.definition.tone,
      available: false,
      probedAt: now.toISOString(),
      expiresAt: now.getTime() + M365_TONE_RECEIPT_TTL_MS,
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  } finally {
    deadline.dispose();
  }
};

export const probeM365Tone = async (input: M365ToneProbeInput): Promise<M365ToneReceiptState> =>
  await runM365ToneProbe(input);

export const probeAllM365Tones = async (input: Omit<Parameters<typeof probeM365Tone>[0], 'definition'> & { renewLease?: () => Promise<void> }): Promise<Record<M365ModelId, M365ToneReceiptState>> => {
  const overall = createM365Deadline(input.signal, M365_ALL_TONES_PROBE_TIMEOUT_MS, () => new M365CopilotWebError('tone_probe_timeout', 'M365 tone probe run timed out'));
  const result = {} as Record<M365ModelId, M365ToneReceiptState>;
  // M365 carries the thread through sessionId/conversationId while tone remains
  // a per-turn chat argument, so the probe opens fresh sockets for one thread.
  // https://github.com/cramt/m365-copilot-proxy/blob/d7c6d8080bf2bb769c1949c2dfbe60bb7ca929c3/packages/core/src/session.ts#L606-L649
  const probeSession = { sessionId: crypto.randomUUID(), conversationId: crypto.randomUUID(), turnCount: 0 };
  try {
    for (const definition of M365_MODELS) {
      if (input.renewLease !== undefined) await withM365Abort(input.renewLease(), overall.signal);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;
      let rejectFailure!: (error: unknown) => void;
      const leaseFailure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
      const schedule = () => {
        if (input.renewLease === undefined) return;
        timer = setTimeout(() => {
          void withM365Abort(input.renewLease!(), overall.signal)
            .then(() => { if (!stopped) schedule(); })
            .catch(error => { if (!stopped) rejectFailure(error); });
        }, 60_000);
      };
      schedule();
      try {
        result[definition.id] = await runM365ToneProbe(
          { ...input, signal: overall.signal, definition, leaseFailure, session: { ...probeSession } },
          () => { probeSession.turnCount++; },
        );
      } finally {
        stopped = true;
        clearTimeout(timer);
      }
    }
    return result;
  } finally {
    overall.dispose();
  }
};
