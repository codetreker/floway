import { type AuthedContext, userFromContext } from '../../middleware/auth.ts';
import { getRepo } from '../../repo/index.ts';
import type { ApiKey } from '../../repo/types.ts';

// Resolve an API key path-param and confirm the authenticated user owns it.
// Returns the key record on success, or a 404 Response on miss / foreign
// ownership. Routing 403 to 404 avoids leaking the existence of another
// user's key id to the actor.
export const ownedKeyOr404 = async (c: AuthedContext, id: string): Promise<ApiKey | Response> => {
  const userId = userFromContext(c).id;
  const key = await getRepo().apiKeys.getById(id);
  if (key?.userId !== userId) return c.json({ error: 'Key not found' }, 404);
  return key;
};
