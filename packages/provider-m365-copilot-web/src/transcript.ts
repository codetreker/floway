import { M365CopilotWebError } from './errors.ts';
import { isM365SessionHandle } from './session-state.ts';
import type { OpenAIChatCompletionsMessage } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

export interface M365CanonicalMessage {
  role: 'system' | 'developer' | 'user' | 'assistant';
  content: string;
}

export interface M365RouteProfile {
  modelId: string;
  tone: string;
  surface: 'chat' | 'responses';
  instructionsDigest?: string | null;
  framingRevision: number;
}

const canonicalJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (typeof value !== 'object' || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) result[key] = canonicalJsonValue(child);
  }
  return result;
};

const textContent = (message: OpenAIChatCompletionsMessage): string => {
  if (typeof message.content === 'string') return message.content;
  if (message.content === null) return '';
  return message.content.map(part => {
    if (part.type === 'text') return part.text;
    throw new M365CopilotWebError('unsupported_content', `M365 Copilot Web does not support ${part.type} chat content`);
  }).join('');
};

export const canonicalizeM365ChatMessages = (
  messages: readonly OpenAIChatCompletionsMessage[],
): M365CanonicalMessage[] => messages.map(message => {
  if (message.role === 'tool' || message.tool_calls !== undefined) {
    throw new M365CopilotWebError('tools_unsupported', 'M365 Copilot Web does not support tool messages or tool calls');
  }
  return { role: message.role, content: textContent(message) };
});

export const m365HandleFromChatMessages = (messages: readonly OpenAIChatCompletionsMessage[]): string | undefined => {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== 'assistant') continue;
    return isM365SessionHandle(message.reasoning_opaque) ? message.reasoning_opaque : undefined;
  }
  return undefined;
};

export const formatM365CanonicalMessages = (messages: readonly M365CanonicalMessage[]): string =>
  messages.map(message => `<${message.role}>\n${message.content}\n</${message.role}>`).join('\n\n');

const digest = async (value: unknown): Promise<string> => {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalJsonValue(value)));
  const result = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(result)].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

export const digestM365History = async (messages: readonly M365CanonicalMessage[]): Promise<string> => await digest(messages);
export const digestM365RouteProfile = async (profile: M365RouteProfile): Promise<string> => await digest(profile);
export const digestM365Text = async (text: string): Promise<string> => await digest(text);

export const canonicalizeM365ResponsesInput = (
  body: Omit<CanonicalOpenAIResponsesPayload, 'model'>,
): { history: M365CanonicalMessage[]; requestedHandle?: string; instructions: string | null } => {
  const history: M365CanonicalMessage[] = [];
  let requestedHandle: string | undefined;
  for (const item of body.input) {
    if (item.type === 'reasoning') {
      if (item.summary.length > 0) throw new M365CopilotWebError('unsupported_reasoning', 'M365 Copilot Web does not support reasoning summaries');
      if (isM365SessionHandle(item.encrypted_content)) requestedHandle = item.encrypted_content;
      continue;
    }
    if (item.type !== 'message') throw new M365CopilotWebError('unsupported_input', `M365 Copilot Web does not support Responses input item '${item.type}'`);
    if (item.phase !== undefined && item.phase !== null) throw new M365CopilotWebError('unsupported_input', 'M365 Copilot Web does not support phased Responses messages');
    const content = typeof item.content === 'string'
      ? item.content
      : item.content.map(part => {
          if (part.type === 'input_text' || part.type === 'output_text') return part.text;
          throw new M365CopilotWebError('unsupported_content', `M365 Copilot Web does not support Responses content '${part.type}'`);
        }).join('');
    history.push({ role: item.role, content });
  }
  return {
    history,
    ...(requestedHandle ? { requestedHandle } : {}),
    instructions: body.instructions ?? null,
  };
};
