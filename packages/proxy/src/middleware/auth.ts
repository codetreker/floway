import type { Context, Next } from 'hono';

import { getRepo } from '../repo/index.ts';
import { getEnv } from '@floway-dev/platform';

// `/` and `/dashboard` are served by Workers Static Assets (apps/web/dist)
// before reaching the Worker. `/favicon.ico` is reserved for a future static
// favicon at apps/web/src/favicon.ico; until that file lands and is copied into
// dist/, the Worker handles it as a public 204 (see control-plane/routes.ts).
const PUBLIC_PATHS = new Set(['/api/health', '/favicon.ico']);
const AUTH_VALIDATE_PATHS = new Set(['/auth/login']);

// ADMIN_KEY is only allowed on dashboard/management paths
const DASHBOARD_PREFIXES = ['/api/', '/auth/'];

// Paths the dashboard Models playground may call with ADMIN_KEY + X-Models-Playground header.
const PLAYGROUND_PATHS = new Set(['/v1/chat/completions', '/v1/messages', '/v1/responses', '/v1/models', '/v1/embeddings']);

const isPlaygroundPath = (path: string): boolean => PLAYGROUND_PATHS.has(path) || isGeminiModelsPath(path);

// Gemini model, generateContent, streamGenerateContent, and countTokens routes are
// all scoped under /v1beta/models; keep the ADMIN_KEY playground escape hatch there.
const isGeminiModelsPath = (path: string): boolean => path === '/v1beta/models' || path.startsWith('/v1beta/models/');

export const authMiddleware = async (c: Context, next: Next) => {
  const path = c.req.path;

  if (PUBLIC_PATHS.has(path) && c.req.method === 'GET') return await next();
  if (AUTH_VALIDATE_PATHS.has(path) && c.req.method === 'POST') return await next();

  const key = extractKey(c);
  if (!key) return c.json({ error: 'Unauthorized' }, 401);

  // ADMIN_KEY — dashboard/management only
  const adminKey = getEnv('ADMIN_KEY');
  if (adminKey && key === adminKey) {
    c.set('authKey', key);
    c.set('isAdmin', true);
    if (DASHBOARD_PREFIXES.some(p => path.startsWith(p))) return await next();
    // Dashboard Models playground escape hatch
    if (c.req.header('x-models-playground') === '1' && isPlaygroundPath(path)) {
      return await next();
    }
    return c.json(
      {
        error: 'This key is for dashboard only. Create an API key for API access.',
      },
      403,
    );
  }

  // API key — full access
  const apiKey = await getRepo().apiKeys.findByRawKey(key);
  if (apiKey) {
    c.set('authKey', key);
    c.set('isAdmin', false);
    c.set('apiKeyId', apiKey.id);
    c.set('apiKeyUpstreamIds', apiKey.upstreamIds);
    return await next();
  }

  return c.json({ error: 'Unauthorized' }, 401);
};

function extractKey(c: Context): string | null {
  const url = new URL(c.req.url);
  return url.searchParams.get('key') ?? c.req.header('x-api-key') ?? c.req.header('x-goog-api-key') ?? c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
}

export const apiKeyUpstreamIdsFromContext = (c: Context): readonly string[] | null =>
  (c.get('apiKeyUpstreamIds') as readonly string[] | null | undefined) ?? null;
