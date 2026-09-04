import type { M365BusyError } from './errors.ts';
import { claimM365EnrollmentLeaseState, claimM365TurnState, commitM365ToneReceiptsState, commitM365TurnState, createM365SessionHandle, hashM365SessionHandle, isM365SessionHandle, markM365DispatchUncertainState, releaseM365EnrollmentLeaseState, releaseM365PreDispatchState, renewM365ClaimState, renewM365EnrollmentLeaseState } from './session-state.ts';
import { readM365CopilotWebUpstreamState, type M365SessionState, type M365ToneReceiptState } from './state.ts';
import { digestM365History, type M365CanonicalMessage } from './transcript.ts';
import { getProviderRepo } from '@floway-dev/provider';

export interface M365ClaimedTurn {
  handle: string;
  session: M365SessionState;
  claimToken: string;
  promptStart: number;
}

const readState = async (upstreamId: string) => {
  const record = await getProviderRepo().upstreams.getById(upstreamId);
  if (record === null) throw new Error(`M365 Copilot upstream ${upstreamId} disappeared`);
  return readM365CopilotWebUpstreamState(record.state);
};

export const claimM365Turn = async (input: {
  upstreamId: string;
  apiKeyId: string;
  expectedCredentialId: string;
  modelId: string;
  routeProfileDigest: string;
  history: readonly M365CanonicalMessage[];
  requestedHandle?: string;
  now?: number;
}): Promise<M365ClaimedTurn> => {
  const now = input.now ?? Date.now();
  const freshHandle = createM365SessionHandle();
  const freshHandleHash = await hashM365SessionHandle(freshHandle);
  const freshSessionId = crypto.randomUUID();
  const freshConversationId = crypto.randomUUID();
  const emptyHistoryDigest = await digestM365History([]);
  const claimToken = crypto.randomUUID();
  const requestedHandleHash = isM365SessionHandle(input.requestedHandle)
    ? await hashM365SessionHandle(input.requestedHandle)
    : undefined;
  const snapshot = await readState(input.upstreamId);
  const requestedSession = requestedHandleHash === undefined ? undefined : snapshot.sessions[requestedHandleHash];
  const requested = requestedSession === undefined
    ? undefined
    : {
        handleHash: requestedHandleHash!,
        expectedRevision: requestedSession.revision,
        expectedHistoryLength: requestedSession.historyLength,
        suppliedPrefixDigest: requestedSession.historyLength <= input.history.length
          ? await digestM365History(input.history.slice(0, requestedSession.historyLength))
          : '',
      };
  let claimed: ReturnType<typeof claimM365TurnState> | undefined;
  await getProviderRepo().upstreams.saveState(input.upstreamId, current => {
    claimed = claimM365TurnState(readM365CopilotWebUpstreamState(current), {
      now,
      apiKeyId: input.apiKeyId,
      expectedCredentialId: input.expectedCredentialId,
      modelId: input.modelId,
      routeProfileDigest: input.routeProfileDigest,
      ...(requested ? { requested } : {}),
      fresh: {
        handleHash: freshHandleHash,
        sessionId: freshSessionId,
        conversationId: freshConversationId,
        emptyHistoryDigest,
      },
      claimToken,
    });
    return claimed.state;
  });
  if (claimed === undefined) throw new Error('M365 session claim mutation did not run');
  return {
    handle: claimed.continued ? input.requestedHandle! : freshHandle,
    session: claimed.session,
    claimToken,
    promptStart: claimed.continued ? claimed.session.historyLength : 0,
  };
};

export const releaseM365PreDispatch = async (upstreamId: string, turn: M365ClaimedTurn): Promise<void> =>
  await getProviderRepo().upstreams.saveState(upstreamId, current => releaseM365PreDispatchState(readM365CopilotWebUpstreamState(current), turn.session.handleHash, turn.claimToken));

export const markM365DispatchUncertain = async (upstreamId: string, turn: M365ClaimedTurn): Promise<void> =>
  await getProviderRepo().upstreams.saveState(upstreamId, current => markM365DispatchUncertainState(readM365CopilotWebUpstreamState(current), turn.session.handleHash, turn.claimToken, Date.now()));

export const renewM365TurnClaim = async (upstreamId: string, turn: M365ClaimedTurn, now = Date.now()): Promise<void> =>
  await getProviderRepo().upstreams.saveState(upstreamId, current => renewM365ClaimState(readM365CopilotWebUpstreamState(current), turn.session.handleHash, turn.claimToken, now));

export const commitM365Turn = async (input: {
  upstreamId: string;
  turn: M365ClaimedTurn;
  history: readonly M365CanonicalMessage[];
  now?: number;
}): Promise<void> => {
  const now = input.now ?? Date.now();
  const historyDigest = await digestM365History(input.history);
  await getProviderRepo().upstreams.saveState(input.upstreamId, current => commitM365TurnState(readM365CopilotWebUpstreamState(current), {
    handleHash: input.turn.session.handleHash,
    claimToken: input.turn.claimToken,
    historyDigest,
    historyLength: input.history.length,
    now,
  }));
};

export const m365BusyResponse = (error: M365BusyError): Response => new Response(JSON.stringify({
  error: { type: error.code, message: error.message },
}), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '2' } });

export interface M365EnrollmentLease {
  claimToken: string;
}

export const claimM365EnrollmentLease = async (upstreamId: string, now = Date.now()): Promise<M365EnrollmentLease> => {
  const lease = { claimToken: crypto.randomUUID() };
  await getProviderRepo().upstreams.saveState(upstreamId, current => claimM365EnrollmentLeaseState(readM365CopilotWebUpstreamState(current), lease.claimToken, now));
  return lease;
};

export const releaseM365EnrollmentLease = async (upstreamId: string, lease: M365EnrollmentLease): Promise<void> =>
  await getProviderRepo().upstreams.saveState(upstreamId, current => releaseM365EnrollmentLeaseState(readM365CopilotWebUpstreamState(current), lease.claimToken));

export const renewM365EnrollmentLease = async (upstreamId: string, lease: M365EnrollmentLease, now = Date.now()): Promise<void> =>
  await getProviderRepo().upstreams.saveState(upstreamId, current => renewM365EnrollmentLeaseState(readM365CopilotWebUpstreamState(current), lease.claimToken, now));

export const commitM365ToneReceipts = async (input: {
  upstreamId: string;
  lease: M365EnrollmentLease;
  credentialId: string;
  toneReceipts: Record<string, M365ToneReceiptState>;
  now?: number;
}): Promise<void> => await getProviderRepo().upstreams.saveState(input.upstreamId, current => commitM365ToneReceiptsState(readM365CopilotWebUpstreamState(current), {
  claimToken: input.lease.claimToken,
  credentialId: input.credentialId,
  toneReceipts: input.toneReceipts,
  now: input.now ?? Date.now(),
}));
