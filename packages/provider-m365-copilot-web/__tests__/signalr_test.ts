import { describe, expect, it } from 'vitest';

import { M365SignalRStateMachine, SIGNALR_RECORD_SEPARATOR, SignalRRecordDecoder } from '../src/signalr.ts';

describe('M365 SignalR codec', () => {
  it('decodes fragmented and coalesced records', () => {
    const decoder = new SignalRRecordDecoder();
    expect(decoder.push('{"a":')).toEqual([]);
    expect(decoder.push(`1}${SIGNALR_RECORD_SEPARATOR}{"b":2}${SIGNALR_RECORD_SEPARATOR}`)).toEqual([{ a: 1 }, { b: 2 }]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it('requires a valid handshake and reconstructs strict prefix text', () => {
    const machine = new M365SignalRStateMachine();
    expect(machine.accept({})).toEqual([{ type: 'handshake-complete' }]);
    expect(machine.accept({ type: 1, target: 'update', arguments: [{ messages: [{ author: 'bot', text: 'Hel' }] }] })).toEqual([{ type: 'text', text: 'Hel' }]);
    expect(machine.accept({ type: 1, target: 'update', arguments: [{ writeAtCursor: 'lo' }] })).toEqual([{ type: 'text', text: 'lo' }]);
    expect(machine.answer).toBe('Hello');
    expect(() => machine.accept({ type: 1, target: 'update', arguments: [{ messages: [{ author: 'bot', text: 'Hxllo!' }] }] })).toThrow('replaced already-streamed');
    expect(machine.answer).toBe('Hello');
  });

  it('requires a final stream item and captures authoritative diagnostics', () => {
    const machine = new M365SignalRStateMachine();
    machine.accept({});
    machine.accept({ type: 1, target: 'update', arguments: [{ writeAtCursor: 'done' }] });
    expect(machine.accept({
      type: 2,
      item: {
        turnState: 'Completed',
        throttling: { numUserMessagesInConversation: 2, maxNumUserMessagesInConversation: 30 },
        messages: [{ author: 'bot', messageId: 'm1', messageType: 'EndOfRequest', contentOrigin: 'DeepLeo', turnCount: 2 }],
      },
    })).toEqual([{
      type: 'terminal',
      diagnostics: {
        answer: 'done',
        messageId: 'm1', messageType: 'EndOfRequest', contentOrigin: 'DeepLeo', turnCount: 2,
        turnState: 'Completed', throttle: { current: 2, max: 30 },
      },
    }]);
    expect(machine.terminal).toBe(true);
  });

  it('surfaces handshake, close, and invocation errors', () => {
    expect(() => new M365SignalRStateMachine().accept({ error: 'denied' })).toThrow('handshake failed');
    const close = new M365SignalRStateMachine(); close.accept({});
    expect(() => close.accept({ type: 7, error: 'gone' })).toThrow('gone');
    const completion = new M365SignalRStateMachine(); completion.accept({});
    expect(() => completion.accept({ type: 3, invocationId: '0', error: 'bad turn' })).toThrow('bad turn');
    const missingFinal = new M365SignalRStateMachine(); missingFinal.accept({});
    expect(() => missingFinal.accept({ type: 3, invocationId: '0' })).toThrow('empty completed turn');
  });

  it('accepts a successful chat completion frame after streamed text', () => {
    const machine = new M365SignalRStateMachine(1);
    machine.accept({});
    machine.accept({ type: 1, target: 'update', arguments: [{ writeAtCursor: 'answer' }] });
    expect(machine.accept({ type: 3, invocationId: '0' })).toEqual([{
      type: 'terminal',
      diagnostics: {
        answer: 'answer',
        messageId: null,
        contentOrigin: null,
        messageType: null,
        turnCount: null,
        turnState: null,
        throttle: null,
      },
    }]);
  });

  it('accepts a clean SignalR close after streamed text', () => {
    const machine = new M365SignalRStateMachine();
    machine.accept({});
    machine.accept({ type: 1, target: 'update', arguments: [{ writeAtCursor: 'answer' }] });
    expect(machine.accept({ type: 7 })).toEqual([{
      type: 'terminal',
      diagnostics: {
        answer: 'answer',
        messageId: null,
        contentOrigin: null,
        messageType: null,
        turnCount: null,
        turnState: null,
        throttle: null,
      },
    }]);
  });

  it('rejects disengaged, empty, at-limit, mismatched, and post-terminal turns', () => {
    const disengaged = new M365SignalRStateMachine(); disengaged.accept({});
    expect(() => disengaged.accept({
      type: 2, item: { turnState: 'Completed', messages: [{ author: 'bot', text: 'no', messageType: 'Disengaged' }] },
    })).toThrow('disengaged');

    const atLimit = new M365SignalRStateMachine(); atLimit.accept({});
    try {
      atLimit.accept({
        type: 2,
        item: {
          turnState: 'Completed', messages: [],
          throttling: { numUserMessagesInConversation: 30, maxNumUserMessagesInConversation: 30 },
        },
      });
    } catch (error) {
      expect(error).toMatchObject({ httpStatus: 429, code: 'm365_conversation_limit' });
    }

    const mismatch = new M365SignalRStateMachine(2); mismatch.accept({});
    expect(() => mismatch.accept({
      type: 2, item: { turnState: 'Completed', messages: [{ author: 'bot', text: 'ok', turnCount: 3 }] },
    })).toThrow('expected 2');

    const terminal = new M365SignalRStateMachine(); terminal.accept({});
    terminal.accept({ type: 2, item: { turnState: 'Completed', messages: [{ author: 'bot', text: 'ok' }] } });
    expect(() => terminal.accept({ type: 6 })).toThrow('after the terminal');
  });

  it('ignores prior-turn bot text in the final conversation summary', () => {
    const machine = new M365SignalRStateMachine(2);
    machine.accept({});
    machine.accept({ type: 1, target: 'update', arguments: [{ writeAtCursor: 'current answer' }] });
    expect(() => machine.accept({
      type: 2,
      item: {
        turnState: 'Completed',
        messages: [
          { author: 'bot', text: 'prior answer', turnCount: 1 },
          { author: 'bot', text: 'current answer', turnCount: 2 },
        ],
      },
    })).not.toThrow();
    expect(machine.answer).toBe('current answer');
  });

  it('bounds cumulative UTF-8 answer bytes and appends cursor chunks linearly', () => {
    const bounded = new M365SignalRStateMachine(undefined, 5);
    bounded.accept({});
    bounded.accept({ type: 1, target: 'update', arguments: [{ writeAtCursor: 'abc' }] });
    bounded.accept({ type: 1, target: 'update', arguments: [{ writeAtCursor: 'de' }] });
    expect(() => bounded.accept({ type: 1, target: 'update', arguments: [{ writeAtCursor: 'f' }] })).toThrow('exceeds 5 bytes');

    const chunked = new M365SignalRStateMachine(undefined, 128 * 1024);
    chunked.accept({});
    for (let index = 0; index < 100_000; index++) {
      chunked.accept({ type: 1, target: 'update', arguments: [{ writeAtCursor: 'x' }] });
    }
    expect(chunked.answer).toHaveLength(100_000);
  });
});
