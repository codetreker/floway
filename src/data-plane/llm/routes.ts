import type { Context, Hono } from 'hono';

import { serveChatCompletions } from './sources/chat-completions/serve.ts';
import { countGeminiTokens } from './sources/gemini/count-tokens/serve.ts';
import { serveGemini } from './sources/gemini/serve.ts';
import { countTokens } from './sources/messages/count-tokens/serve.ts';
import { serveMessages } from './sources/messages/serve.ts';
import { serveResponses } from './sources/responses/serve.ts';

const geminiRpcError = (code: number, status: string, message: string): Response => Response.json({ error: { code, message, status } }, { status: code });

const serveGeminiModelAction = async (c: Context): Promise<Response> => {
  const modelAction = c.req.param('modelAction');
  if (!modelAction) {
    return geminiRpcError(404, 'NOT_FOUND', 'Missing Gemini model action.');
  }

  const separator = modelAction.lastIndexOf(':');
  if (separator <= 0 || separator === modelAction.length - 1) {
    return geminiRpcError(404, 'NOT_FOUND', `Unknown Gemini model action: ${modelAction}`);
  }

  const model = modelAction.slice(0, separator).replace(/^models\//, '');
  const action = modelAction.slice(separator + 1);

  switch (action) {
  case 'generateContent':
    return await serveGemini(c, model, false);
  case 'streamGenerateContent':
    return await serveGemini(c, model, true);
  case 'countTokens':
    return await countGeminiTokens(c, model);
  default:
    return geminiRpcError(404, 'NOT_FOUND', `Unknown Gemini model action: ${action}`);
  }
};

export const mountLlmRoutes = (app: Hono) => {
  app.post('/v1/chat/completions', serveChatCompletions);
  app.post('/chat/completions', serveChatCompletions);
  app.post('/v1/responses', serveResponses);
  app.post('/responses', serveResponses);
  app.post('/v1/messages', serveMessages);
  app.post('/messages', serveMessages);
  app.post('/v1/messages/count_tokens', countTokens);
  app.post('/messages/count_tokens', countTokens);
  app.post('/v1beta/models/:modelAction{.+}', serveGeminiModelAction);
};
