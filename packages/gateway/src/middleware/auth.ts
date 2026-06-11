import type { Context, Next } from 'hono';

import { getRepo } from '../repo/index.ts';
import type { User } from '../repo/types.ts';
import { timingSafeEqual } from '../shared/passwords.ts';
import { getEnv } from '@floway-dev/platform';

const PUBLIC_PATHS = new Set(['/api/health', '/favicon.ico']);
const AUTH_VALIDATE_PATHS = new Set(['/auth/login']);

export const authMiddleware = async (c: Context, next: Next) => {
  const path = c.req.path;
  if (PUBLIC_PATHS.has(path) && c.req.method === 'GET') return await next();
  if (AUTH_VALIDATE_PATHS.has(path) && c.req.method === 'POST') return await next();

  const sessionToken = c.req.header('x-floway-session');
  if (sessionToken) {
    if (!(path.startsWith('/api/') || path.startsWith('/auth/'))) {
      return c.json({ error: 'Session tokens are only valid on dashboard routes; data-plane requests must use an API key.' }, 401);
    }
    const session = await getRepo().sessions.getByIdAndTouch(sessionToken);
    if (!session) return c.json({ error: 'Invalid session' }, 401);
    const user = await getRepo().users.getById(session.userId);
    if (!user) {
      await getRepo().sessions.deleteById(sessionToken);
      return c.json({ error: 'Invalid session' }, 401);
    }
    setUserContext(c, user);
    c.set('sessionId', sessionToken);
    return await next();
  }

  const rawKey = extractApiKey(c);
  if (!rawKey) return c.json({ error: 'Unauthorized' }, 401);

  const adminKey = getEnv('ADMIN_KEY');
  if (adminKey) {
    const utf8 = new TextEncoder();
    if (timingSafeEqual(utf8.encode(rawKey), utf8.encode(adminKey))) {
      return c.json({ error: 'ADMIN_KEY is only valid via POST /auth/login (leave username blank).' }, 401);
    }
  }

  const apiKey = await getRepo().apiKeys.findByRawKey(rawKey);
  if (!apiKey) return c.json({ error: 'Unauthorized' }, 401);
  const user = await getRepo().users.getById(apiKey.userId);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  setUserContext(c, user);
  c.set('apiKeyId', apiKey.id);
  c.set('apiKeyUpstreamIds', apiKey.upstreamIds);
  await next();
};

const setUserContext = (c: Context, user: User) => {
  c.set('userId', user.id);
  c.set('isAdmin', user.isAdmin);
  c.set('userUpstreamIds', user.upstreamIds);
  // Baseline the key-level whitelist to "no key restriction". Session requests
  // (dashboard) carry no API key and never reach the override below, so without
  // this `effectiveUpstreamIdsFromContext` would read an unset `undefined` and
  // slip past its `=== null` guards. The API-key path overwrites this with the
  // key's actual whitelist.
  c.set('apiKeyUpstreamIds', null);
  c.set('canViewGlobalTelemetry', user.isAdmin || user.canViewGlobalTelemetry);
};

const extractApiKey = (c: Context): string | null => {
  const url = new URL(c.req.url);
  return url.searchParams.get('key')
    ?? c.req.header('x-api-key')
    ?? c.req.header('x-goog-api-key')
    ?? c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
    ?? null;
};

export const userUpstreamIdsFromContext = (c: Context): readonly string[] | null =>
  c.get('userUpstreamIds') as readonly string[] | null;

export const effectiveUpstreamIdsFromContext = (c: Context): readonly string[] | null => {
  const userIds = userUpstreamIdsFromContext(c);
  const keyIds = c.get('apiKeyUpstreamIds') as readonly string[] | null;
  if (userIds === null && keyIds === null) return null;
  if (userIds === null) return keyIds;
  if (keyIds === null) return userIds;
  const userSet = new Set(userIds);
  return keyIds.filter(id => userSet.has(id));
};
