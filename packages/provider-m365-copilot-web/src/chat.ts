import { withM365Abort } from './deadline.ts';
import { M365ProtocolError } from './errors.ts';
import { resolveM365ChatHubPath } from './jwt.ts';
import { SIGNALR_RECORD_SEPARATOR, M365SignalRStateMachine, SignalRRecordDecoder, type M365TurnDiagnostics } from './signalr.ts';
import type { WebSocketConnection, WebSocketConnector, WebSocketMessage } from '@floway-dev/http';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

// This feature vector and frame vocabulary mirror the M365 web client. They
// are compatibility data, not product capability claims.
// https://github.com/cramt/m365-copilot-proxy/blob/d7c6d8080bf2bb769c1949c2dfbe60bb7ca929c3/packages/core/src/session.ts#L64-L128
const M365_VARIANTS = [
  'EnableMcpServerWidgets',
  'feature.EnableMcpServerWidgets',
  'feature.EnableLuForChatCIQ',
  'feature.enableChatCIQPlugin',
  'EnableRequestPlugins',
  'feature.EnableSensitivityLabels',
  'EnableUnsupportedUrlDetector',
  'feature.IsCustomEngineCopilotEnabled',
  'feature.bizchatfluxv3',
  'feature.enablechatpages',
  'feature.enableCodeCanvas',
  'feature.turnOnWorkTabRecommendation',
  'turnOffWorkTabUpsellFromClient',
  'feature.turnOnDARecommendation',
  'feature.IsStreamingModeInChatRequestEnabled',
  'IncludeSourceAttributionsConcise',
  'SkipPublishEmptyMessage',
  'feature.EnableDeduplicatingSourceAttributions',
  'Enable3PActionProgressMessages',
  'feature.enableClientWebRtc',
  'feature.EnableMeetingRecapOfSeriesMeetingWithCiq',
  'feature.EnableReferencesListCompleteSignal',
  'feature.StorageMessageSplitDisabled',
  'feature.EnableCuaTakeControlApi',
  'feature.cwcallowedos',
  'feature.disabledisallowedmsgs',
  'feature.enableCitationsForSynthesisData',
  'feature.enableGenerateGraphicArtOptionsSet',
  'cdximagen',
  'feature.EnableUpdatedUXForConfirmationDialog',
  'feature.EnableClientFileURLSupportForOfficeWebPaidCopilot',
  'feature.EnableDesignEditorImageGrounding',
  'feature.EnableDesignerEditor',
  'feature.OfficeWebToHelix',
  'feature.OfficeDesktopToHelix',
  'feature.M365TeamsHubToHelix',
  'feature.OwaHubToHelix',
  'feature.MonarchHubToHelix',
  'feature.Win32OutlookHubToHelix',
  'feature.MacOutlookHubToHelix',
  'Agt_bizchat_enableGpt5ForHelix',
].join(',');

// Captured M365 web-client upgrade headers.
// https://github.com/cramt/m365-copilot-proxy/blob/d7c6d8080bf2bb769c1949c2dfbe60bb7ca929c3/packages/core/src/session.ts#L407-L415
const WEB_SOCKET_HEADERS = [
  ['origin', 'https://m365.cloud.microsoft'],
  ['user-agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36'],
  ['accept-language', 'en-US,en;q=0.9'],
  ['cache-control', 'no-cache'],
  ['pragma', 'no-cache'],
] as const;

// Captured SignalR handshake, ping, chat, Metrics, and Stop frames.
// https://github.com/cramt/m365-copilot-proxy/blob/d7c6d8080bf2bb769c1949c2dfbe60bb7ca929c3/packages/core/src/session.ts#L420-L650
const HANDSHAKE_RECORD = JSON.stringify({ protocol: 'json', version: 1 }) + SIGNALR_RECORD_SEPARATOR;
const PING_RECORD = JSON.stringify({ type: 6 }) + SIGNALR_RECORD_SEPARATOR;
const STOP_RECORD = JSON.stringify({ arguments: [{}], invocationId: '1', target: 'stop', type: 1 }) + SIGNALR_RECORD_SEPARATOR;
const CONNECT_TIMEOUT_MS = 30_000;
const SIGNALR_HANDSHAKE_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 30 * 60 * 1000;
const STOP_ACK_TIMEOUT_MS = 5_000;

export interface M365ChatSession {
  sessionId: string;
  conversationId: string;
  turnCount: number;
}

export interface M365ChatTurnInput {
  connectWebSocket: WebSocketConnector;
  accessToken: string;
  configuredChatHubPath: string;
  configuredChatHubHost: 'substrate.office.com' | 'substrate.svc.cloud.microsoft';
  modelId: string;
  tone: string;
  prompt: string;
  session: M365ChatSession;
  locale: string;
  timeZone: string;
  timeZoneOffsetMinutes: number;
  signal?: AbortSignal;
  now?: () => Date;
  wrapUpstreamCall: <T>(dispatch: () => Promise<T>) => Promise<T>;
}

export interface M365ChatTurnStream {
  events: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>;
  diagnostics: Promise<M365TurnDiagnostics>;
  close(): Promise<void>;
  cancel(): Promise<void>;
}

export interface OpenedM365ChatTurn {
  dispatch(): Promise<M365ChatTurnStream>;
  close(): Promise<void>;
}

const textMessage = (data: string): WebSocketMessage => ({ type: 'text', data });

const writeRecord = async (writer: WritableStreamDefaultWriter<WebSocketMessage>, data: string, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  const writing = writer.write(textMessage(data));
  await (signal === undefined ? writing : withM365Abort(writing, signal));
};

const combineChatCleanupFailures = (primary: unknown, cleanupErrors: readonly unknown[]): unknown =>
  cleanupErrors.length === 0
    ? primary
    : new AggregateError([primary, ...cleanupErrors], 'M365 ChatHub operation and cleanup both failed', { cause: primary });

const readWithTimeout = async <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new M365ProtocolError(message)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
};

const buildChatAndMetricsRecords = (input: M365ChatTurnInput, requestId: string): string => {
  const now = (input.now ?? (() => new Date()))().toISOString();
  const args = {
    source: 'officeweb',
    clientCorrelationId: requestId,
    sessionId: input.session.sessionId,
    optionsSets: [],
    streamingMode: 'ConciseWithPadding',
    spokenTextMode: 'None',
    options: {},
    extraExtensionParameters: {},
    allowedMessageTypes: [
      'Chat', 'Suggestion', 'InternalSearchQuery', 'Disengaged', 'InternalLoaderMessage',
      'Progress', 'RenderCardRequest', 'SemanticSerp', 'GenerateContentQuery', 'SearchQuery',
      'ConfirmationCard', 'DeveloperLogs', 'EndOfRequest', 'ReferencesListComplete',
    ],
    sliceIds: [],
    threadLevelGptId: {},
    traceId: requestId,
    isStartOfSession: input.session.turnCount === 0,
    clientInfo: {
      clientPlatform: 'mcmcopilot-web',
      clientAppName: 'Office',
      clientEntrypoint: 'mcmcopilot-officeweb',
      clientSessionId: input.session.sessionId,
      clientAppType: 'Web',
      deviceOS: 'Linux',
      deviceType: 'Desktop',
    },
    message: {
      author: 'user',
      inputMethod: 'Keyboard',
      text: input.prompt,
      entityAnnotationTypes: ['People', 'File', 'Event', 'Email', 'TeamsMessage'],
      requestId,
      locationInfo: { timeZoneOffset: input.timeZoneOffsetMinutes / 60, timeZone: input.timeZone },
      locale: input.locale,
      messageType: 'Chat',
      experienceType: 'Default',
      adaptiveCards: [],
      clientPreferences: {},
    },
    plugins: [{ Id: 'BingWebSearch', Source: 'BuiltIn' }],
    isSbsSupported: true,
    tone: input.tone,
    renderReferencesBehindEOS: true,
    disconnectBehavior: 'continue',
  };
  const chat = { arguments: [args], invocationId: '0', target: 'chat', type: 4 };
  const metrics = {
    arguments: [{
      Timestamps: {
        ConnectionStart: now,
        UserInputStart: now,
        ConnectionEstablished: now,
        UserInputSubmit: now,
      },
    }],
    target: 'Metrics',
    type: 1,
  };
  return JSON.stringify(chat) + SIGNALR_RECORD_SEPARATOR + JSON.stringify(metrics) + SIGNALR_RECORD_SEPARATOR;
};

const connectChatHub = async (input: M365ChatTurnInput, requestId: string): Promise<WebSocketConnection> => {
  const identity = resolveM365ChatHubPath(input.configuredChatHubPath);
  const params = new URLSearchParams({
    chatsessionid: requestId,
    clientrequestid: requestId,
    'X-SessionId': input.session.sessionId,
    ConversationId: input.session.conversationId,
    access_token: input.accessToken,
    variants: M365_VARIANTS,
    source: '"officeweb"',
    product: 'Office',
    agentHost: 'Bizchat.FullScreen',
    licenseType: 'Starter',
    agent: 'web',
    scenario: 'OfficeWebIncludedCopilot',
  });
  const connectController = new AbortController();
  const forwardAbort = () => connectController.abort(input.signal?.reason);
  if (input.signal?.aborted) forwardAbort();
  else input.signal?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => connectController.abort(new M365ProtocolError('M365 ChatHub connection timed out')), CONNECT_TIMEOUT_MS);
  try {
    return await withM365Abort(input.connectWebSocket(
      `wss://${input.configuredChatHubHost}/m365Copilot/Chathub/${encodeURIComponent(identity)}?${params.toString()}`,
      { headers: WEB_SOCKET_HEADERS, signal: connectController.signal, maxMessageBytes: 1024 * 1024 },
    ), connectController.signal);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', forwardAbort);
  }
};

export const openM365ChatTurn = (input: M365ChatTurnInput): Promise<OpenedM365ChatTurn> => input.wrapUpstreamCall(async () => {
  const requestId = crypto.randomUUID();
  const connection = await connectChatHub(input, requestId);
  const writer = connection.writable.getWriter();
  const reader = connection.readable.getReader();
  const decoder = new SignalRRecordDecoder();
  const machine = new M365SignalRStateMachine(input.session.turnCount + 1);
  let dispatched = false;
  let locksReleased = false;
  const releaseLocks = () => {
    if (locksReleased) return;
    locksReleased = true;
    reader.releaseLock();
    writer.releaseLock();
  };
  try {
    await writeRecord(writer, HANDSHAKE_RECORD, input.signal);
    let handshakeComplete = false;
    while (!handshakeComplete) {
      const read = await readWithTimeout(input.signal === undefined ? reader.read() : withM365Abort(reader.read(), input.signal), SIGNALR_HANDSHAKE_TIMEOUT_MS, 'M365 SignalR handshake timed out');
      if (read.done) throw new M365ProtocolError('M365 ChatHub closed before the SignalR handshake completed');
      if (read.value.type !== 'text') throw new M365ProtocolError('M365 ChatHub sent a binary handshake message');
      for (const record of decoder.push(read.value.data)) {
        for (const effect of machine.accept(record)) {
          if (effect.type === 'handshake-complete') handshakeComplete = true;
          else if (effect.type === 'ping') await writeRecord(writer, PING_RECORD, input.signal);
          else throw new M365ProtocolError('M365 ChatHub sent turn data before chat dispatch');
        }
      }
    }
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try { await reader.cancel(error); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    try { releaseLocks(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    try { await connection.close(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    throw combineChatCleanupFailures(error, cleanupErrors);
  }

  return {
    close: async () => {
      releaseLocks();
      await connection.close();
    },
    dispatch: async () => {
      if (dispatched) throw new M365ProtocolError('M365 chat turn was dispatched more than once');
      dispatched = true;
      try {
        await writeRecord(writer, buildChatAndMetricsRecords(input, requestId), input.signal);
      } catch (error) {
        const cleanupErrors: unknown[] = [];
        try { await readWithTimeout(writeRecord(writer, STOP_RECORD), STOP_ACK_TIMEOUT_MS, 'M365 Stop write timed out'); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
        try { await reader.cancel(error); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
        try { await connection.close(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
        try { releaseLocks(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
        throw combineChatCleanupFailures(error, cleanupErrors);
      }

      let resolveDiagnostics!: (diagnostics: M365TurnDiagnostics) => void;
      let rejectDiagnostics!: (error: unknown) => void;
      const diagnostics = new Promise<M365TurnDiagnostics>((resolve, reject) => {
        resolveDiagnostics = resolve;
        rejectDiagnostics = reject;
      });
      let diagnosticsSettled = false;
      const settleDiagnostics = (value: M365TurnDiagnostics) => {
        if (diagnosticsSettled) return;
        diagnosticsSettled = true;
        resolveDiagnostics(value);
      };
      const failDiagnostics = (error: unknown) => {
        if (diagnosticsSettled) return;
        diagnosticsSettled = true;
        rejectDiagnostics(error);
      };
      let stopSentAt: number | null = null;
      let eventsStarted = false;
      const requestStop = async () => {
        if (stopSentAt !== null) return;
        stopSentAt = Date.now();
        await writeRecord(writer, STOP_RECORD);
      };
      const cancel = async () => {
        const cancellationError = input.signal?.reason ?? new M365ProtocolError('M365 Chat turn was cancelled');
        await readWithTimeout(requestStop(), STOP_ACK_TIMEOUT_MS, 'M365 Stop write timed out').catch(() => undefined);
        const closing = connection.close().catch(() => undefined);
        const cancellingRead = reader.cancel(cancellationError).catch(() => undefined);
        await Promise.all([closing, cancellingRead]);
        if (!eventsStarted) {
          failDiagnostics(cancellationError);
          releaseLocks();
        }
      };
      const eagerAbort = () => { void cancel(); };
      if (input.signal?.aborted) eagerAbort();
      else input.signal?.addEventListener('abort', eagerAbort, { once: true });

      const events = (async function* (): AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
        eventsStarted = true;
        const created = Math.floor(Date.now() / 1000);
        let terminal = false;
        let aborted = false;
        let signalAbort!: () => void;
        const abortGate = new Promise<void>(resolve => { signalAbort = resolve; });
        const turnDeadline = Date.now() + TURN_TIMEOUT_MS;
        const abort = () => {
          if (aborted) return;
          aborted = true;
          void requestStop().catch(() => undefined);
          signalAbort();
        };
        if (input.signal?.aborted) abort();
        else input.signal?.addEventListener('abort', abort, { once: true });
        try {
          if (aborted) throw input.signal?.reason ?? new DOMException('Aborted', 'AbortError');
          yield eventFrame({
            id: requestId,
            object: 'chat.completion.chunk',
            created,
            model: input.modelId,
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
          });

          let pendingRead = reader.read();
          while (true) {
            const deadline = stopSentAt === null
              ? turnDeadline
              : Math.min(turnDeadline, stopSentAt + STOP_ACK_TIMEOUT_MS);
            const readOrAbort = await readWithTimeout(
              Promise.race([
                pendingRead.then(read => ({ type: 'read' as const, read })),
                ...(stopSentAt === null ? [abortGate.then(() => ({ type: 'abort' as const }))] : []),
              ]),
              Math.max(0, deadline - Date.now()),
              stopSentAt === null ? 'M365 ChatHub turn timed out' : 'M365 ChatHub did not acknowledge Stop',
            );
            if (readOrAbort.type === 'abort') continue;
            const read = readOrAbort.read;
            if (read.done) break;
            const message = read.value;
            if (message.type !== 'text') throw new M365ProtocolError('M365 ChatHub sent a binary WebSocket message');
            for (const record of decoder.push(message.data)) {
              for (const effect of machine.accept(record)) {
                if (effect.type === 'handshake-complete') {
                  throw new M365ProtocolError('M365 ChatHub repeated the SignalR handshake');
                } else if (effect.type === 'ping') {
                  await writeRecord(writer, PING_RECORD, input.signal);
                } else if (effect.type === 'text') {
                  yield eventFrame({
                    id: requestId,
                    object: 'chat.completion.chunk',
                    created,
                    model: input.modelId,
                    choices: [{ index: 0, delta: { content: effect.text }, finish_reason: null }],
                  });
                } else if (effect.type === 'terminal') {
                  terminal = true;
                  settleDiagnostics(effect.diagnostics);
                  await connection.close();
                } else if (effect.type === 'completion') {
                  if (stopSentAt === null || effect.invocationId !== '1') {
                    throw new M365ProtocolError(`M365 ChatHub sent unexpected completion for invocation ${effect.invocationId}`);
                  }
                  await connection.close();
                }
              }
            }
            if (terminal) break;
            pendingRead = reader.read();
          }
          decoder.finish();
          if (aborted) throw input.signal?.reason ?? new DOMException('Aborted', 'AbortError');
          if (!terminal) throw new M365ProtocolError('M365 ChatHub closed before a terminal stream item');

          yield eventFrame({
            id: requestId,
            object: 'chat.completion.chunk',
            created,
            model: input.modelId,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          });
          yield doneFrame();
        } catch (error) {
          await reader.cancel(error).catch(() => undefined);
          failDiagnostics(error);
          throw error;
        } finally {
          input.signal?.removeEventListener('abort', abort);
          input.signal?.removeEventListener('abort', eagerAbort);
          releaseLocks();
          if (!terminal) await connection.close().catch(() => undefined);
        }
      })();
      return {
        events,
        diagnostics,
        close: async () => {
          input.signal?.removeEventListener('abort', eagerAbort);
          await connection.close();
          if (!eventsStarted) releaseLocks();
        },
        cancel,
      };
    },
  };
});
