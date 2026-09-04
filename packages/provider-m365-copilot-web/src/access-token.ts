import { assertM365CopilotWebUpstreamConfig } from './config.ts';
import { M365OAuthError } from './errors.ts';
import { refreshM365AccessToken, type M365OAuthTokens } from './oauth.ts';
import { readM365CopilotWebUpstreamState, type M365AccessTokenState } from './state.ts';
import { getProviderRepo, type Fetcher } from '@floway-dev/provider';

const REFRESH_SKEW_MS = 5 * 60 * 1000;
const inflightRefreshes = new Map<string, Promise<M365OAuthTokens>>();

const readContext = async (upstreamId: string) => {
  const record = await getProviderRepo().upstreams.getById(upstreamId);
  if (record === null) throw new Error(`M365 Copilot upstream ${upstreamId} disappeared`);
  assertM365CopilotWebUpstreamConfig(record.config);
  return { config: record.config, state: readM365CopilotWebUpstreamState(record.state) };
};

const refreshSingleflight = (input: Parameters<typeof refreshM365AccessToken>[0] & { objectId: string }): Promise<M365OAuthTokens> => {
  const key = `${input.tenantId}\u0000${input.objectId}\u0000${input.refreshToken}`;
  const running = inflightRefreshes.get(key);
  if (running !== undefined) return running;
  const created = refreshM365AccessToken(input).finally(() => {
    if (inflightRefreshes.get(key) === created) inflightRefreshes.delete(key);
  });
  inflightRefreshes.set(key, created);
  return created;
};

const getM365AccessToken = async (upstreamId: string, fetcher: Fetcher, force: boolean, signal?: AbortSignal): Promise<M365AccessTokenState> => {
  const before = await readContext(upstreamId);
  const cached = before.state.accessToken;
  if (!force && cached !== null && cached.credentialGeneration === before.state.credential.generation && cached.expiresAt > Date.now() + REFRESH_SKEW_MS) return cached;
  let tokens: M365OAuthTokens;
  try {
    tokens = await refreshSingleflight({
      refreshToken: before.state.credential.refreshToken,
      tenantId: before.config.account.tenantId,
      objectId: before.config.account.objectId,
      fetcher,
      signal,
    });
  } catch (error) {
    if (!(error instanceof M365OAuthError) || error.oauthCode !== 'invalid_grant') throw error;
    const after = await readContext(upstreamId);
    if (after.state.credential.credentialId !== before.state.credential.credentialId
      || after.state.credential.generation !== before.state.credential.generation
      || after.state.credential.refreshToken !== before.state.credential.refreshToken
      || after.state.credential.stateUpdatedAt !== before.state.credential.stateUpdatedAt) return await getM365AccessToken(upstreamId, fetcher, false, signal);
    const stateUpdatedAt = new Date().toISOString();
    let lostRace = false;
    await getProviderRepo().upstreams.saveState(upstreamId, current => {
      const state = readM365CopilotWebUpstreamState(current);
      if (state.credential.credentialId !== before.state.credential.credentialId
        || state.credential.generation !== before.state.credential.generation
        || state.credential.refreshToken !== before.state.credential.refreshToken
        || state.credential.stateUpdatedAt !== before.state.credential.stateUpdatedAt) {
        lostRace = true;
        return current;
      }
      const stateMessage = [error.oauthCode, error.suberror].filter((value): value is string => value !== undefined).join(':').slice(0, 128);
      return { ...state, accessToken: null, credential: { ...state.credential, health: 'reauth_required', stateUpdatedAt, stateMessage } };
    });
    if (lostRace) return await getM365AccessToken(upstreamId, fetcher, false, signal);
    throw error;
  }
  const rotated = tokens.refreshToken !== undefined && tokens.refreshToken !== before.state.credential.refreshToken;
  const generation = before.state.credential.generation + (rotated ? 1 : 0);
  const refreshedAt = new Date().toISOString();
  const entry: M365AccessTokenState = {
    token: tokens.accessToken,
    expiresAt: Date.now() + tokens.expiresIn * 1000,
    refreshedAt,
    credentialGeneration: generation,
  };
  let lostRace = false;
  await getProviderRepo().upstreams.saveState(upstreamId, current => {
    const state = readM365CopilotWebUpstreamState(current);
    if (state.credential.credentialId !== before.state.credential.credentialId || state.credential.generation !== before.state.credential.generation || state.credential.refreshToken !== before.state.credential.refreshToken) {
      lostRace = true;
      return current;
    }
    const next = {
      ...state,
      credential: {
        ...state.credential,
        refreshToken: rotated ? tokens.refreshToken! : state.credential.refreshToken,
        generation,
        health: 'active' as const,
        stateUpdatedAt: refreshedAt,
        stateMessage: undefined,
      },
      accessToken: entry,
    };
    readM365CopilotWebUpstreamState(next);
    return next;
  });
  return lostRace ? await getM365AccessToken(upstreamId, fetcher, false, signal) : entry;
};

export const ensureM365AccessToken = (upstreamId: string, fetcher: Fetcher, signal?: AbortSignal): Promise<M365AccessTokenState> =>
  getM365AccessToken(upstreamId, fetcher, false, signal);

export const refreshM365Credential = (upstreamId: string, fetcher: Fetcher, signal?: AbortSignal): Promise<M365AccessTokenState> =>
  getM365AccessToken(upstreamId, fetcher, true, signal);
