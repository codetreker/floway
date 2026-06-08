import {
  type CodexAccessTokenCache,
  getCodexAccessToken,
  invalidateCodexAccessToken,
  putCodexAccessToken,
} from './access-token-cache.ts';
import { CodexOAuthSessionTerminatedError, refreshCodexAccessToken } from './auth/oauth.ts';
import {
  CODEX_BACKEND_BASE,
  CODEX_ORIGINATOR,
  CODEX_RESPONSES_PATH,
  CODEX_USER_AGENT,
} from './constants.ts';
import {
  computeCodexQuotaTtlMs,
  getCodexQuota,
  isCodexRateLimited,
  parseCodexQuotaHeaders,
  putCodexQuota,
} from './quota.ts';
import type { CodexAccountCredential } from './state.ts';
import type { ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { parseResponsesStream } from '@floway-dev/protocols/responses';
import { streamingProviderCall, type CacheRepo, type ProviderStreamResult, type UpstreamModel } from '@floway-dev/provider';

// Hooks for D1 state transitions, applied with optimistic concurrency. Only
// refresh-token rotations and terminal-state transitions go through D1;
// quota and access-token cache writes happen inline below against the
// CacheRepo.
export interface CodexCallEffects {
  persistRefreshTokenRotation(newRefreshToken: string): Promise<void>;
  persistTerminalState(state: 'session_terminated' | 'refresh_failed', message: string): Promise<void>;
}

// The transport sees one account at a time. Provider-level code picks the
// active account out of the pool (currently always accounts[0]) and passes
// only the credential here, so the transport stays pool-agnostic — a future
// fan-out adds per-call account selection without touching this module.
export interface CallCodexResponsesOptions {
  upstreamId: string;
  account: CodexAccountCredential;
  model: UpstreamModel;
  body: Omit<ResponsesPayload, 'model'>;
  headers: Record<string, string>;
  signal?: AbortSignal;
  cache: CacheRepo;
  effects: CodexCallEffects;
}

// Refresh window: refresh proactively if the cached access_token expires within
// the next 5 minutes, so the upstream call rides a fresh token rather than
// risking a wasted 401-retry.
const REFRESH_LEAD_SECONDS = 5 * 60;

export const callCodexResponses = async (opts: CallCodexResponsesOptions): Promise<ProviderStreamResult<ResponsesStreamEvent>> => {
  if (opts.account.state !== 'active') {
    return { ok: false, modelKey: opts.model.id, response: synthetic503(`Codex upstream is ${opts.account.state}`) };
  }

  const now = new Date();
  const quotaSnapshot = await getCodexQuota(opts.cache, opts.upstreamId);
  if (isCodexRateLimited(quotaSnapshot, now)) {
    return {
      ok: false,
      modelKey: opts.model.id,
      response: synthetic429(`Codex upstream rate-limited until ${quotaSnapshot!.ratelimited_until!}`, quotaSnapshot!.ratelimited_until!, now),
    };
  }

  let accessToken: string;
  try {
    accessToken = await ensureAccessToken(opts, now);
  } catch (err) {
    if (err instanceof CodexOAuthSessionTerminatedError) {
      await opts.effects.persistTerminalState('refresh_failed', err.upstreamMessage);
      return { ok: false, modelKey: opts.model.id, response: synthetic503(`Codex refresh failed: ${err.upstreamMessage}`) };
    }
    throw err;
  }

  return await performUpstreamCall(opts, accessToken, false);
};

const ensureAccessToken = async (opts: CallCodexResponsesOptions, now: Date): Promise<string> => {
  const cached = await getCodexAccessToken(opts.cache, opts.upstreamId);
  const nowSec = Math.floor(now.getTime() / 1000);
  if (cached && cached.expires_at > nowSec + REFRESH_LEAD_SECONDS) {
    return cached.access_token;
  }
  return await refreshAndCache(opts);
};

const refreshAndCache = async (opts: CallCodexResponsesOptions): Promise<string> => {
  const tokens = await refreshCodexAccessToken(opts.account.refresh_token);
  const newCache: CodexAccessTokenCache = {
    access_token: tokens.access_token,
    expires_at: Math.floor(Date.now() / 1000) + tokens.expires_in,
    refreshed_at: new Date().toISOString(),
  };
  await putCodexAccessToken(opts.cache, opts.upstreamId, newCache, tokens.expires_in * 1000);
  // Persist the refresh-token rotation through the caller's CAS hook. We
  // await rather than fire-and-forget on purpose: under concurrent rotations
  // (two parallel data-plane requests both refreshing), each call's rotated
  // token must reach D1 deterministically; otherwise an unhandled rejection
  // can swallow the new refresh_token and the upstream eventually returns
  // app_session_terminated hours later. Cost is one row UPDATE on the request
  // path (~5ms on D1). A losing CAS is fine — that path's `expectedState`
  // mismatched a concurrent operator re-import or sibling rotation, and the
  // already-persisted newer state supersedes ours.
  await opts.effects.persistRefreshTokenRotation(tokens.refresh_token);
  return tokens.access_token;
};

const performUpstreamCall = async (
  opts: CallCodexResponsesOptions,
  accessToken: string,
  alreadyRetried: boolean,
): Promise<ProviderStreamResult<ResponsesStreamEvent>> => {
  const headers: Record<string, string> = {
    ...opts.headers,
    'authorization': `Bearer ${accessToken}`,
    'chatgpt-account-id': opts.account.chatgptAccountId,
    'originator': CODEX_ORIGINATOR,
    'user-agent': CODEX_USER_AGENT,
    'accept': 'text/event-stream',
    'content-type': 'application/json',
  };

  const upstreamFetch = fetch(`${CODEX_BACKEND_BASE}${CODEX_RESPONSES_PATH}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...opts.body, model: opts.model.id, store: false, stream: true }),
    signal: opts.signal,
  }).then(async response => {
    if (response.ok) {
      const responseNow = new Date();
      const snapshot = parseCodexQuotaHeaders(response.headers, { now: responseNow, isRateLimited: false });
      void putCodexQuota(opts.cache, opts.upstreamId, snapshot, computeCodexQuotaTtlMs(snapshot, responseNow));
      return ensureSseContentType(response);
    }

    if (response.status === 429) {
      const responseNow = new Date();
      const snapshot = parseCodexQuotaHeaders(response.headers, { now: responseNow, isRateLimited: true });
      void putCodexQuota(opts.cache, opts.upstreamId, snapshot, computeCodexQuotaTtlMs(snapshot, responseNow));
      return response;
    }

    if (response.status === 401) {
      const bodyText = await response.text();
      const { code, message } = parseUpstreamError(bodyText);
      if (code === 'token_invalidated') {
        await opts.effects.persistTerminalState('session_terminated', message);
        return synthetic503(`Codex session terminated: ${message}`);
      }
      return new Response(bodyText, { status: 401, headers: response.headers });
    }

    return response;
  });

  const result = await streamingProviderCall(upstreamFetch, parseResponsesStream, opts.model.id, opts.signal);

  if (!result.ok && result.response.status === 401 && !alreadyRetried) {
    await invalidateCodexAccessToken(opts.cache, opts.upstreamId);
    let newAccessToken: string;
    try {
      newAccessToken = await refreshAndCache(opts);
    } catch (err) {
      if (err instanceof CodexOAuthSessionTerminatedError) {
        await opts.effects.persistTerminalState('refresh_failed', err.upstreamMessage);
        return { ok: false, modelKey: opts.model.id, response: synthetic503(`Codex refresh failed: ${err.upstreamMessage}`) };
      }
      throw err;
    }
    return await performUpstreamCall(opts, newAccessToken, true);
  }

  return result;
};

const parseUpstreamError = (rawText: string): { code: string | null; message: string } => {
  try {
    const obj = JSON.parse(rawText) as { error?: { code?: unknown; message?: unknown }; detail?: unknown };
    const code = obj.error && typeof obj.error === 'object' && typeof obj.error.code === 'string' ? obj.error.code : null;
    const message = obj.error && typeof obj.error === 'object' && typeof obj.error.message === 'string'
      ? obj.error.message
      : typeof obj.detail === 'string' ? obj.detail : rawText.slice(0, 256);
    return { code, message };
  } catch {
    return { code: null, message: rawText.slice(0, 256) };
  }
};

const synthetic503 = (message: string): Response => new Response(JSON.stringify({ error: { type: 'codex_upstream_unavailable', message } }), {
  status: 503,
  headers: { 'content-type': 'application/json' },
});

const synthetic429 = (message: string, retryAtIso: string, now: Date): Response => {
  const retryAfterSeconds = Math.max(0, Math.ceil((new Date(retryAtIso).getTime() - now.getTime()) / 1000));
  return new Response(JSON.stringify({ error: { type: 'codex_rate_limited', message, retry_at: retryAtIso } }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': String(retryAfterSeconds) },
  });
};

// Codex backend serves SSE without setting `content-type: text/event-stream`
// (observed in production: only x-codex-* + standard CDN headers come back).
// The shared `streamingProviderCall` rejects 2xx responses lacking the SSE
// content-type as a contract violation, so we synthesize the header on the
// way through. Body stream is preserved verbatim.
const ensureSseContentType = (response: Response): Response => {
  if (response.headers.get('content-type')?.includes('text/event-stream')) return response;
  const headers = new Headers(response.headers);
  headers.set('content-type', 'text/event-stream');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};
