import { M365BusyError, M365StateConflictError } from './errors.ts';
import { M365_CLAIM_TTL_MS, M365_ENROLLMENT_LEASE_TTL_MS, M365_MAX_SESSIONS, M365_SESSION_TTL_MS, M365_UNCERTAIN_TTL_MS, assertM365CopilotWebUpstreamState, type M365CopilotWebUpstreamState, type M365SessionState, type M365ToneReceiptState } from './state.ts';

export const M365_HANDLE_PREFIX = 'm365h1_';

export const createM365SessionHandle = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${M365_HANDLE_PREFIX}${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
};

export const hashM365SessionHandle = async (handle: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(handle));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

export const isM365SessionHandle = (value: unknown): value is string =>
  typeof value === 'string' && new RegExp(`^${M365_HANDLE_PREFIX}[A-Za-z0-9_-]{43}$`).test(value);

const cleanup = (state: M365CopilotWebUpstreamState, now: number): M365CopilotWebUpstreamState => {
  const sessions: Record<string, M365SessionState> = {};
  for (const [hash, session] of Object.entries(state.sessions)) {
    if (session.expiresAt <= now) continue;
    if (session.status === 'claimed' && session.claimExpiresAt !== null && session.claimExpiresAt <= now) {
      sessions[hash] = { ...session, status: 'active', claimToken: null, claimExpiresAt: null };
    } else {
      sessions[hash] = session;
    }
  }
  return {
    ...state,
    sessions,
    accountLease: state.accountLease !== null && state.accountLease.claimExpiresAt <= now ? null : state.accountLease,
  };
};

const makeCapacity = (sessions: Record<string, M365SessionState>, now: number): Record<string, M365SessionState> => {
  if (Object.keys(sessions).length < M365_MAX_SESSIONS) return sessions;
  const evictable = Object.values(sessions)
    .filter(session => session.status === 'active' || (session.status === 'uncertain' && (session.claimExpiresAt ?? 0) <= now))
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
  if (evictable === undefined) throw new M365BusyError('M365 session capacity is occupied by in-flight or uncertain sessions');
  const next = { ...sessions };
  delete next[evictable.handleHash];
  return next;
};

export interface M365SessionClaimInput {
  now: number;
  apiKeyId: string;
  expectedCredentialId: string;
  modelId: string;
  routeProfileDigest: string;
  requested?: {
    handleHash: string;
    expectedRevision: number;
    expectedHistoryLength: number;
    suppliedPrefixDigest: string;
  };
  fresh: {
    handleHash: string;
    sessionId: string;
    conversationId: string;
    emptyHistoryDigest: string;
  };
  claimToken: string;
}

export interface M365SessionClaimResult {
  state: M365CopilotWebUpstreamState;
  session: M365SessionState;
  continued: boolean;
}

export const claimM365TurnState = (
  raw: M365CopilotWebUpstreamState,
  input: M365SessionClaimInput,
): M365SessionClaimResult => {
  const state = cleanup(raw, input.now);
  if (state.credential.credentialId !== input.expectedCredentialId) throw new M365StateConflictError('M365 credential changed before session claim');
  if (state.accountLease !== null) throw new M365BusyError('The M365 account already has an in-flight request');
  const requested = input.requested === undefined ? undefined : state.sessions[input.requested.handleHash];
  if (requested?.status === 'claimed') throw new M365BusyError('The requested M365 conversation is already in use');

  const continuationValid = requested?.status === 'active'
    && requested.apiKeyId === input.apiKeyId
    && requested.modelId === input.modelId
    && requested.routeProfileDigest === input.routeProfileDigest
    && requested.revision === input.requested?.expectedRevision
    && requested.historyLength === input.requested.expectedHistoryLength
    && requested.historyDigest === input.requested.suppliedPrefixDigest;

  let sessions = state.sessions;
  const base: M365SessionState = continuationValid
    ? requested
    : {
        handleHash: input.fresh.handleHash,
        apiKeyId: input.apiKeyId,
        modelId: input.modelId,
        routeProfileDigest: input.routeProfileDigest,
        historyDigest: input.fresh.emptyHistoryDigest,
        historyLength: 0,
        sessionId: input.fresh.sessionId,
        conversationId: input.fresh.conversationId,
        turnCount: 0,
        revision: 0,
        status: 'active',
        claimToken: null,
        claimExpiresAt: null,
        expiresAt: input.now + M365_SESSION_TTL_MS,
        lastUsedAt: input.now,
      };
  if (!continuationValid) sessions = makeCapacity(sessions, input.now);
  if (!continuationValid && sessions[input.fresh.handleHash] !== undefined) throw new M365StateConflictError('Fresh M365 session handle collided with existing state');
  const session: M365SessionState = {
    ...base,
    status: 'claimed',
    claimToken: input.claimToken,
    claimExpiresAt: input.now + M365_CLAIM_TTL_MS,
    lastUsedAt: input.now,
  };
  const next: M365CopilotWebUpstreamState = {
    ...state,
    sessions: { ...sessions, [session.handleHash]: session },
    accountLease: { claimToken: input.claimToken, claimExpiresAt: input.now + M365_CLAIM_TTL_MS },
  };
  assertM365CopilotWebUpstreamState(next);
  return { state: next, session, continued: continuationValid };
};

const claimedSession = (
  raw: M365CopilotWebUpstreamState,
  handleHash: string,
  claimToken: string,
  expectedStatus: 'claimed' | 'uncertain',
  now?: number,
): M365SessionState => {
  const session = raw.sessions[handleHash];
  if (session?.status !== expectedStatus || session.claimToken !== claimToken) {
    throw new M365StateConflictError(`M365 session is not ${expectedStatus} under this claim`);
  }
  if (raw.accountLease?.claimToken !== claimToken) throw new M365StateConflictError('M365 account lease is not held by this claim');
  if (now !== undefined && ((session.claimExpiresAt ?? 0) <= now || raw.accountLease.claimExpiresAt <= now)) {
    throw new M365StateConflictError('M365 claim expired before the state transition');
  }
  return session;
};

export const releaseM365PreDispatchState = (
  raw: M365CopilotWebUpstreamState,
  handleHash: string,
  claimToken: string,
): M365CopilotWebUpstreamState => {
  const session = claimedSession(raw, handleHash, claimToken, 'claimed');
  return {
    ...raw,
    sessions: { ...raw.sessions, [handleHash]: { ...session, status: 'active', claimToken: null, claimExpiresAt: null } },
    accountLease: null,
  };
};

export const markM365DispatchUncertainState = (
  raw: M365CopilotWebUpstreamState,
  handleHash: string,
  claimToken: string,
  now: number,
): M365CopilotWebUpstreamState => {
  const session = claimedSession(raw, handleHash, claimToken, 'claimed', now);
  return {
    ...raw,
    sessions: {
      ...raw.sessions,
      [handleHash]: { ...session, status: 'uncertain', expiresAt: Math.min(session.expiresAt, now + M365_UNCERTAIN_TTL_MS) },
    },
  };
};

export const renewM365ClaimState = (
  raw: M365CopilotWebUpstreamState,
  handleHash: string,
  claimToken: string,
  now: number,
): M365CopilotWebUpstreamState => {
  const session = raw.sessions[handleHash];
  if (session === undefined || (session.status !== 'claimed' && session.status !== 'uncertain') || session.claimToken !== claimToken) {
    throw new M365StateConflictError('M365 session claim was lost');
  }
  if (raw.accountLease?.claimToken !== claimToken) throw new M365StateConflictError('M365 account lease was lost');
  if ((session.claimExpiresAt ?? 0) <= now || raw.accountLease.claimExpiresAt <= now) throw new M365StateConflictError('M365 claim expired before renewal');
  const claimExpiresAt = now + M365_CLAIM_TTL_MS;
  return {
    ...raw,
    sessions: { ...raw.sessions, [handleHash]: { ...session, claimExpiresAt: Math.max(session.claimExpiresAt ?? 0, claimExpiresAt) } },
    accountLease: { claimToken, claimExpiresAt: Math.max(raw.accountLease.claimExpiresAt, claimExpiresAt) },
  };
};

export const commitM365TurnState = (
  raw: M365CopilotWebUpstreamState,
  input: {
    handleHash: string;
    claimToken: string;
    historyDigest: string;
    historyLength: number;
    now: number;
  },
): M365CopilotWebUpstreamState => {
  const session = claimedSession(raw, input.handleHash, input.claimToken, 'uncertain', input.now);
  const committed: M365SessionState = {
    ...session,
    historyDigest: input.historyDigest,
    historyLength: input.historyLength,
    turnCount: session.turnCount + 1,
    revision: session.revision + 1,
    status: 'active',
    claimToken: null,
    claimExpiresAt: null,
    expiresAt: input.now + M365_SESSION_TTL_MS,
    lastUsedAt: input.now,
  };
  const next = { ...raw, sessions: { ...raw.sessions, [input.handleHash]: committed }, accountLease: null };
  assertM365CopilotWebUpstreamState(next);
  return next;
};

export const cleanupM365State = cleanup;

export const claimM365EnrollmentLeaseState = (
  raw: M365CopilotWebUpstreamState,
  claimToken: string,
  now: number,
): M365CopilotWebUpstreamState => {
  const state = cleanup(raw, now);
  if (state.accountLease !== null) throw new M365BusyError('The M365 account already has an in-flight operation');
  return { ...state, accountLease: { claimToken, claimExpiresAt: now + M365_ENROLLMENT_LEASE_TTL_MS } };
};

export const releaseM365EnrollmentLeaseState = (
  raw: M365CopilotWebUpstreamState,
  claimToken: string,
): M365CopilotWebUpstreamState => raw.accountLease?.claimToken === claimToken ? { ...raw, accountLease: null } : raw;

export const renewM365EnrollmentLeaseState = (
  raw: M365CopilotWebUpstreamState,
  claimToken: string,
  now: number,
): M365CopilotWebUpstreamState => {
  if (raw.accountLease?.claimToken !== claimToken || raw.accountLease.claimExpiresAt <= now) throw new M365StateConflictError('M365 enrollment lease expired or was lost');
  return { ...raw, accountLease: { claimToken, claimExpiresAt: now + M365_ENROLLMENT_LEASE_TTL_MS } };
};

export const commitM365ToneReceiptsState = (
  raw: M365CopilotWebUpstreamState,
  input: {
    claimToken: string;
    credentialId: string;
    toneReceipts: Record<string, M365ToneReceiptState>;
    now: number;
  },
): M365CopilotWebUpstreamState => {
  if (raw.credential.credentialId !== input.credentialId) throw new M365StateConflictError('M365 credential changed during tone probe');
  if (raw.accountLease?.claimToken !== input.claimToken || raw.accountLease.claimExpiresAt <= input.now) throw new M365StateConflictError('M365 tone-probe lease expired or was lost');
  const next = { ...raw, toneReceipts: input.toneReceipts, accountLease: null };
  assertM365CopilotWebUpstreamState(next);
  return next;
};
