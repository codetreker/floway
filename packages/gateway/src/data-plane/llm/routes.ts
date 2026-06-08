import type { Hono } from 'hono';

import { chatCompletionsHttp } from './chat-completions/http.ts';
import { geminiHttp } from './gemini/http.ts';
import { messagesHttp } from './messages/http.ts';
import { responsesHttp } from './responses/http.ts';
import { responsesWebSocket } from './responses/websocket.ts';

export const mountLlmRoutes = (app: Hono) => {
  app.post('/v1/chat/completions', chatCompletionsHttp.generate);
  app.post('/chat/completions', chatCompletionsHttp.generate);
  app.post('/v1/responses', responsesHttp.generate);
  app.post('/responses', responsesHttp.generate);
  app.post('/v1/responses/compact', responsesHttp.compact);
  app.post('/responses/compact', responsesHttp.compact);
  app.post('/v1/messages', messagesHttp.generate);
  app.post('/messages', messagesHttp.generate);
  app.post('/v1/messages/count_tokens', messagesHttp.countTokens);
  app.post('/messages/count_tokens', messagesHttp.countTokens);
  app.get('/v1/responses', responsesWebSocket);
  app.get('/responses', responsesWebSocket);
  // Gemini encodes both the model id and the action in one path segment
  // (e.g. `models/gemini-2.5-pro:streamGenerateContent`); `geminiHttp`
  // splits on the trailing `:` and fans out to the right sub-endpoint.
  app.post('/v1beta/models/:modelAction{.+}', geminiHttp);
};
