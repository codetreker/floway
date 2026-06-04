import type { Context, Hono } from 'hono';

import { chatCompletionsTraits } from './sources/chat-completions/traits.ts';
import { geminiTraits } from './sources/gemini/traits.ts';
import { messagesTraits } from './sources/messages/traits.ts';
import { responsesTraits } from './sources/responses/traits.ts';
import { responsesWebSocket } from './sources/responses/websocket.ts';
import { serveLlm } from './sources/serve.ts';

export const mountLlmRoutes = (app: Hono) => {
  const serveChatCompletions = serveLlm(chatCompletionsTraits, 'generate');
  const serveResponses = serveLlm(responsesTraits, 'generate');
  const serveResponsesCompact = serveLlm(responsesTraits, 'compact');
  const serveMessages = serveLlm(messagesTraits, 'generate');
  const serveMessagesCountTokens = serveLlm(messagesTraits, 'countTokens');
  const serveGeminiGenerate = serveLlm(geminiTraits, 'generate');
  const serveGeminiCountTokens = serveLlm(geminiTraits, 'countTokens');
  // Gemini encodes the action in the path: route `:countTokens` to the count
  // endpoint and everything else (including malformed actions) to generate,
  // whose setup renders the action error.
  const serveGemini = (c: Context) => (c.req.param('modelAction')?.endsWith(':countTokens') ? serveGeminiCountTokens : serveGeminiGenerate)(c);

  app.post('/v1/chat/completions', serveChatCompletions);
  app.post('/chat/completions', serveChatCompletions);
  app.post('/v1/responses', serveResponses);
  app.post('/responses', serveResponses);
  app.post('/v1/responses/compact', serveResponsesCompact);
  app.post('/responses/compact', serveResponsesCompact);
  app.get('/v1/responses', responsesWebSocket);
  app.get('/responses', responsesWebSocket);
  app.post('/v1/messages', serveMessages);
  app.post('/messages', serveMessages);
  app.post('/v1/messages/count_tokens', serveMessagesCountTokens);
  app.post('/messages/count_tokens', serveMessagesCountTokens);
  app.post('/v1beta/models/:modelAction{.+}', serveGemini);
};
