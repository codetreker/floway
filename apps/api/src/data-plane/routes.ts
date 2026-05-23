import type { Hono } from 'hono';

import { embeddings } from './embeddings/serve.ts';
import { mountLlmRoutes } from './llm/routes.ts';
import { serveGeminiModelInfo, serveGeminiModels } from './models/gemini.ts';
import { models } from './models/serve.ts';

export const mountDataPlane = (app: Hono) => {
  mountLlmRoutes(app);

  app.get('/v1/models', models);
  app.get('/models', models);
  app.get('/v1beta/models', serveGeminiModels);
  app.get('/v1beta/models/:modelId{.+}', serveGeminiModelInfo);
  app.post('/v1/embeddings', embeddings);
  app.post('/embeddings', embeddings);
};
