import { type AuthedContext, sessionIdFromContext, userFromContext } from '../../middleware/auth.ts';
import { type CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { User } from '../../repo/types.ts';
import { dummyPasswordHash, timingSafeEqual, verifyPassword } from '../../shared/passwords.ts';
import type { authLoginBody } from '../schemas.ts';
import { userToEffectiveWire } from '../users/wire.ts';
import { getEnv } from '@floway-dev/platform';

const resolveLoginUser = async (username: string, password: string): Promise<User | null> => {
  const repo = getRepo();

  if (username === '') {
    const adminKey = getEnv('ADMIN_KEY');
    const utf8 = new TextEncoder();
    if (!adminKey || !timingSafeEqual(utf8.encode(password), utf8.encode(adminKey))) return null;
    const user = await repo.users.getById(1);
    if (!user) throw new Error('ADMIN_KEY login: seed admin (user 1) is missing');
    return user;
  }

  const user = await repo.users.findByUsername(username);
  // Burn equivalent PBKDF2 work on the no-user / no-hash branch so request
  // latency does not distinguish a real account from a missing one.
  if (!user?.passwordHash) {
    await verifyPassword(password, await dummyPasswordHash());
    return null;
  }
  if (!(await verifyPassword(password, user.passwordHash))) return null;
  return user;
};

export const authLogin = async (c: CtxWithJson<typeof authLoginBody>) => {
  const { username, password } = c.req.valid('json');
  const user = await resolveLoginUser(username, password);
  if (!user) return c.json({ error: 'Invalid username or password' }, 401);
  const session = await getRepo().sessions.create(user.id);
  return c.json({ token: session.id, user: userToEffectiveWire(user) });
};

export const authLogout = async (c: AuthedContext) => {
  const sessionId = sessionIdFromContext(c);
  if (sessionId) await getRepo().sessions.deleteById(sessionId);
  return c.json({ ok: true });
};

export const authMe = async (c: AuthedContext) => {
  const user = userFromContext(c);
  const sessionId = sessionIdFromContext(c);
  const apiKey = c.get('apiKey');
  return c.json({
    user: userToEffectiveWire(user),
    viaApiKey: !sessionId,
    apiKey: apiKey ? { id: apiKey.id, name: apiKey.name } : null,
  });
};
