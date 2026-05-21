// Auth routes — ADMIN_KEY validation + GitHub Device Flow OAuth (multi-account)
// Supports login with ADMIN_KEY (full dashboard access) or API key (restricted)
// No sessions, no cookies. All auth via key in every request.

import type { Context } from 'hono';

import { detectAccountType, fetchGitHubUser, pollGitHubDeviceFlow, startGitHubDeviceFlow } from './github-device-flow.ts';
import { clearModelsCache } from '../../data-plane/providers/upstream-model-cache.ts';
import { getRepo } from '../../repo/index.ts';
import type { GitHubAccount } from '../../repo/types.ts';
import { getEnv } from '../../runtime/env.ts';
import { clearCopilotTokenCache } from '../../shared/copilot.ts';

type GitHubUser = GitHubAccount['user'];

/** POST /auth/login — validate ADMIN_KEY or API key */
export const authLogin = async (c: Context) => {
  try {
    const body = await c.req.json<{ key: string }>();
    const adminKey = getEnv('ADMIN_KEY');

    // ADMIN_KEY login
    if (adminKey && body.key === adminKey) {
      return c.json({ ok: true, isAdmin: true });
    }

    // API key login
    const key = await getRepo().apiKeys.findByRawKey(body.key);
    if (key) {
      return c.json({
        ok: true,
        isAdmin: false,
        keyId: key.id,
        keyName: key.name,
        keyHint: body.key.slice(-4),
      });
    }

    return c.json({ error: 'Invalid key' }, 401);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 500);
  }
};

/** POST /auth/logout — no-op (client clears localStorage) */
export const authLogout = (_c: Context) => {
  // Nothing to clean up server-side; client clears its own localStorage
  return _c.json({ ok: true });
};

/** GET /auth/github — start GitHub Device Flow */
export const authGithub = async (c: Context) => {
  try {
    const result = await startGitHubDeviceFlow();
    if (!result.ok) return c.json({ error: result.error }, 502);
    return c.json(result.data);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 502);
  }
};

/** POST /auth/github/poll — poll for device flow completion */
export const authGithubPoll = async (c: Context) => {
  try {
    const body = await c.req.json<{ device_code: string }>();

    const data = await pollGitHubDeviceFlow(body.device_code);

    if (data.error === 'authorization_pending') {
      return c.json({ status: 'pending' });
    }

    if (data.error === 'slow_down') {
      return c.json({ status: 'slow_down', interval: data.interval });
    }

    if (data.error) {
      return c.json({ status: 'error', error: data.error_description ?? data.error }, 400);
    }

    if (data.access_token) {
      const user = await fetchGitHubUser(data.access_token);

      // Store account; request priority is controlled only by account order.
      const accountType = await detectAccountType(data.access_token);
      await getRepo().github.saveAccount(user.id, {
        token: data.access_token,
        accountType,
        user,
      });
      await clearCopilotTokenCache();
      clearModelsCache();
      return c.json({ status: 'complete', user });
    }

    return c.json({ status: 'error', error: 'Unknown response' }, 500);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 502);
  }
};

/** GET /auth/me — get all GitHub accounts in priority order */
export const authMe = async (c: Context) => {
  const accounts = await getRepo().github.listAccounts();

  const refreshedAccounts = await Promise.all(
    accounts.map(async account => {
      if (account.user.login) return account;
      try {
        const userResp = await fetch('https://api.github.com/user', {
          headers: {
            authorization: `token ${account.token}`,
            accept: 'application/json',
            'user-agent': 'copilot-gateway',
          },
        });
        if (!userResp.ok) return account;
        const user = (await userResp.json()) as GitHubUser;
        await getRepo().github.saveAccount(user.id, {
          token: account.token,
          accountType: account.accountType,
          user,
        });
        return { ...account, user };
      } catch {
        // Ignore — user just stays as-is.
        return account;
      }
    }),
  );

  return c.json({
    authenticated: true,
    github_connected: refreshedAccounts.length > 0,
    accounts: refreshedAccounts.map(a => ({
      id: a.user.id,
      login: a.user.login,
      name: a.user.name,
      avatar_url: a.user.avatar_url,
      account_type: a.accountType,
      // TODO: Return provider backoff state after the new provider-level
      // backoff design lands. The old account/model backoff storage was
      // intentionally removed during the provider refactor.
      temporarily_unavailable_models: [],
    })),
  });
};

/** DELETE /auth/github/:id — disconnect a specific GitHub account */
export const authGithubDisconnect = async (c: Context) => {
  const userId = Number(c.req.param('id'));
  if (!userId || isNaN(userId)) {
    return c.json({ error: 'Invalid user ID' }, 400);
  }
  await getRepo().github.deleteAccount(userId);
  await clearCopilotTokenCache();
  clearModelsCache();
  return c.json({ ok: true });
};

/** POST /auth/github/order — set GitHub account priority order */
export const authGithubOrder = async (c: Context) => {
  const body = await c.req.json<{ user_ids: number[] }>();
  if (!Array.isArray(body.user_ids)) {
    return c.json({ error: 'user_ids is required' }, 400);
  }

  const repo = getRepo().github;
  const accounts = await repo.listAccounts();
  const accountIds = new Set(accounts.map(account => account.user.id));
  const requestedIds = new Set(body.user_ids);
  if (body.user_ids.length !== accounts.length || requestedIds.size !== body.user_ids.length || body.user_ids.some(id => !accountIds.has(id))) {
    return c.json({ error: 'Invalid GitHub account order' }, 400);
  }

  await repo.setOrder(body.user_ids);
  clearModelsCache();
  return c.json({ ok: true });
};
