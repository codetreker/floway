import { describe, expect, it } from 'vitest';

import { stateFixture } from './fixtures.ts';
import { M365BusyError } from '../src/errors.ts';
import { claimM365EnrollmentLeaseState, claimM365TurnState, commitM365ToneReceiptsState, commitM365TurnState, createM365SessionHandle, hashM365SessionHandle, isM365SessionHandle, markM365DispatchUncertainState, releaseM365PreDispatchState, renewM365ClaimState } from '../src/session-state.ts';

const HASH = 'a'.repeat(64);
const DIGEST = 'b'.repeat(64);
const claimInput = (now = 1_000) => ({
  now, apiKeyId: 'key', expectedCredentialId: 'credential-1', modelId: 'model', routeProfileDigest: DIGEST,
  fresh: { handleHash: HASH, sessionId: 'session', conversationId: 'conversation', emptyHistoryDigest: DIGEST },
  claimToken: 'claim',
});

describe('M365 state CAS mutators', () => {
  it('claims, marks uncertain, renews, and commits atomically', () => {
    const claimed = claimM365TurnState(stateFixture(), claimInput());
    expect(claimed.session.status).toBe('claimed');
    expect(claimed.state.accountLease?.claimToken).toBe('claim');
    const uncertain = markM365DispatchUncertainState(claimed.state, HASH, 'claim', 1_500);
    const renewed = renewM365ClaimState(uncertain, HASH, 'claim', 2_000);
    const committed = commitM365TurnState(renewed, { handleHash: HASH, claimToken: 'claim', historyDigest: 'c'.repeat(64), historyLength: 2, now: 3_000 });
    expect(committed.sessions[HASH]).toMatchObject({ status: 'active', turnCount: 1, revision: 1, historyLength: 2 });
    expect(committed.accountLease).toBeNull();
  });

  it('releases pre-dispatch claims and rejects account concurrency', () => {
    const claimed = claimM365TurnState(stateFixture(), claimInput());
    expect(releaseM365PreDispatchState(claimed.state, HASH, 'claim').sessions[HASH]?.status).toBe('active');
    expect(() => claimM365TurnState(claimed.state, { ...claimInput(), fresh: { ...claimInput().fresh, handleHash: 'd'.repeat(64) } })).toThrow(M365BusyError);
  });

  it('falls back to a fresh session for stale or mismatched continuation state', () => {
    const first = claimM365TurnState(stateFixture(), claimInput());
    const active = releaseM365PreDispatchState(first.state, HASH, 'claim');
    const freshHash = 'e'.repeat(64);
    const next = claimM365TurnState(active, {
      ...claimInput(2_000),
      requested: { handleHash: HASH, expectedRevision: 0, expectedHistoryLength: 0, suppliedPrefixDigest: 'wrong' },
      fresh: { ...claimInput().fresh, handleHash: freshHash },
    });
    expect(next.continued).toBe(false);
    expect(next.session.handleHash).toBe(freshHash);
  });

  it('does not resurrect expired authority', () => {
    const claimed = claimM365TurnState(stateFixture(), claimInput());
    const expiredAt = claimed.session.claimExpiresAt!;
    expect(() => renewM365ClaimState(claimed.state, HASH, 'claim', expiredAt)).toThrow('expired');
    expect(() => markM365DispatchUncertainState(claimed.state, HASH, 'claim', expiredAt)).toThrow('expired');
    const uncertain = markM365DispatchUncertainState(claimed.state, HASH, 'claim', expiredAt - 1);
    expect(() => commitM365TurnState(uncertain, { handleHash: HASH, claimToken: 'claim', historyDigest: DIGEST, historyLength: 1, now: expiredAt })).toThrow('expired');
  });

  it('uses 256-bit opaque handles and refuses hash collisions', async () => {
    const handle = createM365SessionHandle();
    expect(isM365SessionHandle(handle)).toBe(true);
    expect(handle).toHaveLength('m365h1_'.length + 43);
    const hash = await hashM365SessionHandle(handle);
    const first = claimM365TurnState(stateFixture(), { ...claimInput(), fresh: { ...claimInput().fresh, handleHash: hash } });
    const active = releaseM365PreDispatchState(first.state, hash, 'claim');
    expect(() => claimM365TurnState(active, { ...claimInput(2_000), fresh: { ...claimInput().fresh, handleHash: hash } })).toThrow('collided');
  });

  it('fences data-plane claims during enrollment and expires after five minutes', () => {
    const enrolling = claimM365EnrollmentLeaseState(stateFixture(), 'enroll', 1_000);
    expect(() => claimM365TurnState(enrolling, claimInput(2_000))).toThrow(M365BusyError);
    expect(() => claimM365TurnState(enrolling, claimInput(301_001))).not.toThrow();
  });

  it('commits tone receipts only under the matching credential and live management lease', () => {
    const enrolling = claimM365EnrollmentLeaseState(stateFixture(), 'enroll', 1_000);
    const receipt = { tone: 'magic', available: true, probedAt: new Date(1_000).toISOString(), expiresAt: 60_000 };
    const committed = commitM365ToneReceiptsState(enrolling, {
      claimToken: 'enroll', credentialId: 'credential-1', toneReceipts: { model: receipt }, now: 2_000,
    });
    expect(committed.toneReceipts.model).toEqual(receipt);
    expect(committed.accountLease).toBeNull();
    expect(() => commitM365ToneReceiptsState(enrolling, {
      claimToken: 'enroll', credentialId: 'other', toneReceipts: {}, now: 2_000,
    })).toThrow('credential changed');
  });
});
