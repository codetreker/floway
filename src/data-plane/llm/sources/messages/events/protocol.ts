import type { MessagesStreamEventData } from '../../../../shared/protocol/messages.ts';

export const MESSAGES_MISSING_TERMINAL_MESSAGE = 'Messages stream ended without a message_stop event.';

export const isMessagesTerminalEvent = (event: Pick<MessagesStreamEventData, 'type'>): boolean => event.type === 'message_stop' || event.type === 'error';
