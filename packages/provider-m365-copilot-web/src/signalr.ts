import { M365ProtocolError, M365UpstreamTurnError } from './errors.ts';

// SignalR JSON protocol records are separated by ASCII RS.
// https://github.com/cramt/m365-copilot-proxy/blob/d7c6d8080bf2bb769c1949c2dfbe60bb7ca929c3/packages/core/src/session.ts#L22
export const SIGNALR_RECORD_SEPARATOR = '\u001e';
export const M365_MAX_ANSWER_BYTES = 8 * 1024 * 1024;
const M365_ANSWER_BLOCK_BYTES = 64 * 1024;
const M365_ANSWER_BLOCK_FRAGMENTS = 1024;

export class SignalRRecordDecoder {
  #buffer = '';

  constructor(readonly maxRecordBytes = 1024 * 1024) {}

  push(chunk: string): unknown[] {
    this.#buffer += chunk;
    if (new TextEncoder().encode(this.#buffer).byteLength > this.maxRecordBytes && !this.#buffer.includes(SIGNALR_RECORD_SEPARATOR)) {
      throw new M365ProtocolError(`M365 SignalR record exceeds ${this.maxRecordBytes} bytes`);
    }
    const pieces = this.#buffer.split(SIGNALR_RECORD_SEPARATOR);
    this.#buffer = pieces.pop()!;
    return pieces.filter(piece => piece.length > 0).map(piece => {
      if (new TextEncoder().encode(piece).byteLength > this.maxRecordBytes) {
        throw new M365ProtocolError(`M365 SignalR record exceeds ${this.maxRecordBytes} bytes`);
      }
      try {
        return JSON.parse(piece);
      } catch (error) {
        throw new M365ProtocolError('M365 SignalR record is not valid JSON', { cause: error });
      }
    });
  }

  finish(): void {
    if (this.#buffer.length !== 0) throw new M365ProtocolError('M365 SignalR stream ended with a partial record');
  }
}

export interface M365TurnDiagnostics {
  answer: string;
  messageId: string | null;
  contentOrigin: string | null;
  messageType: string | null;
  turnCount: number | null;
  turnState: string | null;
  throttle: { current: number; max: number } | null;
}

export type M365SignalREffect =
  | { type: 'handshake-complete' }
  | { type: 'ping' }
  | { type: 'text'; text: string }
  | { type: 'terminal'; diagnostics: M365TurnDiagnostics }
  | { type: 'completion'; invocationId: string };

const objectOf = (value: unknown, where: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new M365ProtocolError(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
};

export class M365SignalRStateMachine {
  #handshakeComplete = false;
  #terminal = false;
  #answerBlocks: string[] = [];
  #pendingAnswerFragments: string[] = [];
  #pendingAnswerBytes = 0;
  #answerBytes = 0;
  #materializedAnswer: string | null = '';
  #diagnostics: M365TurnDiagnostics = {
    answer: '',
    messageId: null,
    contentOrigin: null,
    messageType: null,
    turnCount: null,
    turnState: null,
    throttle: null,
  };

  constructor(
    readonly expectedTurnCount?: number,
    readonly maxAnswerBytes = M365_MAX_ANSWER_BYTES,
  ) {}

  get answer(): string {
    if (this.#materializedAnswer === null) {
      this.#flushAnswerBlock();
      this.#materializedAnswer = this.#answerBlocks.join('');
      this.#answerBlocks = this.#materializedAnswer.length === 0 ? [] : [this.#materializedAnswer];
    }
    return this.#materializedAnswer;
  }
  get terminal(): boolean { return this.#terminal; }

  accept(record: unknown): M365SignalREffect[] {
    if (this.#terminal) throw new M365ProtocolError('M365 SignalR sent a frame after the terminal item');
    const frame = objectOf(record, 'M365 SignalR frame');
    if (!this.#handshakeComplete) {
      if (typeof frame.error === 'string' && frame.error.length > 0) {
        throw new M365ProtocolError(`M365 SignalR handshake failed: ${frame.error}`);
      }
      if ('type' in frame) throw new M365ProtocolError('M365 SignalR message arrived before the handshake response');
      this.#handshakeComplete = true;
      return [{ type: 'handshake-complete' }];
    }

    if (frame.type === 6) return [{ type: 'ping' }];
    if (frame.type === 7) {
      if (typeof frame.error === 'string' && frame.error.length > 0) {
        throw new M365ProtocolError(`M365 SignalR server closed the stream: ${frame.error}`);
      }
      this.#validateTerminal(false);
      this.#terminal = true;
      return [{ type: 'terminal', diagnostics: this.#terminalDiagnostics() }];
    }
    if (frame.type === 3) {
      if (typeof frame.invocationId !== 'string') throw new M365ProtocolError('M365 SignalR completion is missing invocationId');
      if (typeof frame.error === 'string' && frame.error.length > 0) {
        throw new M365ProtocolError(`M365 SignalR invocation failed: ${frame.error}`);
      }
      if (frame.invocationId !== '0') return [{ type: 'completion', invocationId: frame.invocationId }];
      this.#validateTerminal(false);
      this.#terminal = true;
      return [{ type: 'terminal', diagnostics: this.#terminalDiagnostics() }];
    }
    if (frame.type === 2) {
      const effects = this.#consumeFinalItem(frame.item);
      this.#validateTerminal(true);
      this.#terminal = true;
      return [...effects, { type: 'terminal', diagnostics: this.#terminalDiagnostics() }];
    }
    if (frame.type === 1 && frame.target === 'update') {
      if (!Array.isArray(frame.arguments)) throw new M365ProtocolError('M365 update frame is missing arguments');
      return frame.arguments.flatMap(argument => this.#consumeUpdate(argument));
    }
    throw new M365ProtocolError(`Unsupported M365 SignalR frame type ${String(frame.type)}`);
  }

  #append(text: string): M365SignalREffect[] {
    if (text.length === 0) return [];
    const bytes = new TextEncoder().encode(text).byteLength;
    if (this.#answerBytes + bytes > this.maxAnswerBytes) {
      throw new M365ProtocolError(`M365 answer exceeds ${this.maxAnswerBytes} bytes`);
    }
    this.#pendingAnswerFragments.push(text);
    this.#pendingAnswerBytes += bytes;
    this.#answerBytes += bytes;
    this.#materializedAnswer = null;
    if (this.#pendingAnswerBytes >= M365_ANSWER_BLOCK_BYTES || this.#pendingAnswerFragments.length >= M365_ANSWER_BLOCK_FRAGMENTS) {
      this.#flushAnswerBlock();
    }
    return [{ type: 'text', text }];
  }

  #flushAnswerBlock(): void {
    if (this.#pendingAnswerFragments.length === 0) return;
    this.#answerBlocks.push(this.#pendingAnswerFragments.join(''));
    this.#pendingAnswerFragments = [];
    this.#pendingAnswerBytes = 0;
  }

  #advanceSnapshot(next: string): M365SignalREffect[] {
    const answer = this.answer;
    if (answer.startsWith(next)) return [];
    if (!next.startsWith(answer)) {
      throw new M365ProtocolError('M365 SignalR replaced already-streamed answer text');
    }
    return this.#append(next.slice(answer.length));
  }

  #consumeUpdate(value: unknown): M365SignalREffect[] {
    const update = objectOf(value, 'M365 update argument');
    if (typeof update.writeAtCursor === 'string') return this.#append(update.writeAtCursor);
    if (Array.isArray(update.messages)) return this.#consumeMessages(update.messages);
    if (typeof update.throttling === 'object' && update.throttling !== null) {
      this.#readThrottle(update.throttling);
      return [];
    }
    throw new M365ProtocolError('M365 update argument has an unsupported shape');
  }

  #consumeFinalItem(value: unknown): M365SignalREffect[] {
    const item = objectOf(value, 'M365 final stream item');
    if (typeof item.turnState !== 'string') throw new M365ProtocolError('M365 final stream item is missing turnState');
    this.#diagnostics.turnState = item.turnState;
    if (item.throttling !== undefined) this.#readThrottle(item.throttling);
    if (!Array.isArray(item.messages)) throw new M365ProtocolError('M365 final stream item is missing messages');
    const effects = this.#consumeMessages(item.messages, false);
    const botMessages = item.messages
      .filter(message => typeof message === 'object' && message !== null && !Array.isArray(message))
      .map(message => message as Record<string, unknown>)
      .filter(message => message.author === 'bot' && message.messageType === undefined && typeof message.text === 'string');
    const current = botMessages.findLast(message => this.expectedTurnCount !== undefined && message.turnCount === this.expectedTurnCount)
      ?? botMessages.at(-1);
    return current === undefined ? effects : [...effects, ...this.#advanceSnapshot(current.text as string)];
  }

  #consumeMessages(messages: unknown[], includeText = true): M365SignalREffect[] {
    const effects: M365SignalREffect[] = [];
    for (const raw of messages) {
      const message = objectOf(raw, 'M365 bot message');
      if (message.author !== 'bot') continue;
      if (typeof message.messageId === 'string') this.#diagnostics.messageId = message.messageId;
      if (typeof message.contentOrigin === 'string') this.#diagnostics.contentOrigin = message.contentOrigin;
      if (typeof message.messageType === 'string') this.#diagnostics.messageType = message.messageType;
      if (typeof message.turnCount === 'number' && Number.isFinite(message.turnCount)) this.#diagnostics.turnCount = message.turnCount;
      if (typeof message.turnState === 'string') this.#diagnostics.turnState = message.turnState;
      if (includeText && message.messageType === undefined && typeof message.text === 'string') effects.push(...this.#advanceSnapshot(message.text));
    }
    return effects;
  }

  #readThrottle(value: unknown): void {
    const throttle = objectOf(value, 'M365 throttling');
    if (typeof throttle.numUserMessagesInConversation !== 'number'
      || typeof throttle.maxNumUserMessagesInConversation !== 'number') {
      throw new M365ProtocolError('M365 throttling payload is invalid');
    }
    this.#diagnostics.throttle = {
      current: throttle.numUserMessagesInConversation,
      max: throttle.maxNumUserMessagesInConversation,
    };
  }

  #validateTerminal(requireCompletedState: boolean): void {
    if (this.#diagnostics.messageType === 'Disengaged') {
      throw new M365UpstreamTurnError(502, 'm365_disengaged', 'M365 Copilot disengaged from the request');
    }
    if ((requireCompletedState && this.#diagnostics.turnState !== 'Completed')
      || (!requireCompletedState && this.#diagnostics.turnState !== null && this.#diagnostics.turnState !== 'Completed')) {
      throw new M365UpstreamTurnError(502, 'm365_incomplete_turn', `M365 Copilot ended in turn state '${this.#diagnostics.turnState}'`);
    }
    if (this.expectedTurnCount !== undefined && this.#diagnostics.turnCount !== null
      && this.#diagnostics.turnCount !== this.expectedTurnCount) {
      throw new M365UpstreamTurnError(502, 'm365_turn_mismatch', `M365 Copilot reported turn ${this.#diagnostics.turnCount}; expected ${this.expectedTurnCount}`);
    }
    if (this.#answerBytes === 0) {
      const throttle = this.#diagnostics.throttle;
      if (throttle !== null && throttle.current >= throttle.max) {
        throw new M365UpstreamTurnError(429, 'm365_conversation_limit', `M365 Copilot conversation limit reached (${throttle.current}/${throttle.max})`);
      }
      throw new M365UpstreamTurnError(502, 'm365_empty_turn', 'M365 Copilot returned an empty completed turn');
    }
  }

  #terminalDiagnostics(): M365TurnDiagnostics {
    return { ...this.#diagnostics, answer: this.answer };
  }
}
