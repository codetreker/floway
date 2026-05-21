// GET /api/copilot-quota — fetch Copilot usage/quota info from GitHub API

import type { Context } from 'hono';

import { getRepo } from '../../repo/index.ts';
import { githubHeaders } from '../../shared/copilot.ts';

interface QuotaDetail {
  entitlement: number;
  overage_count: number;
  overage_permitted: boolean;
  percent_remaining: number;
  quota_id: string;
  quota_remaining: number;
  remaining: number;
  unlimited: boolean;
}

interface CopilotUsageResponse {
  access_type_sku: string;
  analytics_tracking_id: string;
  assigned_date: string;
  can_signup_for_limited: boolean;
  chat_enabled: boolean;
  copilot_plan: string;
  organization_login_list: unknown[];
  organization_list: unknown[];
  quota_reset_date: string;
  quota_snapshots: {
    chat: QuotaDetail;
    completions: QuotaDetail;
    premium_interactions: QuotaDetail;
  };
}

export const copilotQuota = async (c: Context) => {
  try {
    const userIdParam = c.req.query('user_id');
    const userId = userIdParam === undefined ? undefined : Number(userIdParam);
    if (userIdParam !== undefined && !Number.isSafeInteger(userId)) {
      return c.json({ error: 'Invalid GitHub account ID' }, 400);
    }

    const githubRepo = getRepo().github;
    const account = userId === undefined ? (await githubRepo.listAccounts())[0] ?? null : await githubRepo.getAccount(userId);
    if (!account) {
      throw new Error(userId === undefined ? 'No GitHub account connected — add one via the dashboard' : 'GitHub account not found');
    }

    const resp = await fetch('https://api.github.com/copilot_internal/user', { headers: await githubHeaders(account.token) });

    if (!resp.ok) {
      const text = await resp.text();
      return c.json({ error: `GitHub API error: ${resp.status} ${text}` }, resp.status as 400 | 401 | 403 | 404 | 500);
    }

    const data = (await resp.json()) as CopilotUsageResponse;
    return c.json(data);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 502);
  }
};
