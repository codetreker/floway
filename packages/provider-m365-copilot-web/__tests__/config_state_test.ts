import { describe, expect, it } from 'vitest';

import { CONFIG, stateFixture } from './fixtures.ts';
import { assertM365CopilotWebUpstreamConfig } from '../src/config.ts';
import { M365_MAX_SESSIONS, assertM365CopilotWebUpstreamState, hasLiveM365Claim, m365StateForTransfer } from '../src/state.ts';

describe('M365 config and state', () => {
  it('accepts closed valid shapes and rejects unknown fields', () => {
    expect(() => assertM365CopilotWebUpstreamConfig(CONFIG)).not.toThrow();
    expect(() => assertM365CopilotWebUpstreamConfig({ ...CONFIG, extra: true })).toThrow("unexpected key 'extra'");
    expect(() => assertM365CopilotWebUpstreamConfig({ ...CONFIG, account: { ...CONFIG.account, chatHubPath: 'other@identity' } })).toThrow('exactly match objectId@tenantId');
    expect(() => assertM365CopilotWebUpstreamConfig({ ...CONFIG, account: { ...CONFIG.account, chatHubPath: `/${CONFIG.account.chatHubPath}/` } })).toThrow('exactly match');
    expect(() => assertM365CopilotWebUpstreamConfig({ ...CONFIG, account: { ...CONFIG.account, username: 'x'.repeat(321) } })).toThrow('username is too long');
    expect(() => assertM365CopilotWebUpstreamConfig({ ...CONFIG, timeZone: 'x'.repeat(129) })).toThrow('timeZone is too long');
    expect(() => assertM365CopilotWebUpstreamConfig({ ...CONFIG, locale: `en-${'x'.repeat(64)}` })).toThrow('locale is invalid');
    expect(() => assertM365CopilotWebUpstreamState(stateFixture())).not.toThrow();
    expect(() => assertM365CopilotWebUpstreamState({ ...stateFixture(), extra: true })).toThrow("unexpected key 'extra'");
  });

  it('clears every ephemeral slot for backup transfer', () => {
    expect(m365StateForTransfer(stateFixture())).toEqual({
      credential: stateFixture().credential,
      accessToken: null,
      toneReceipts: {},
      sessions: {},
      accountLease: null,
    });
  });

  it('enforces the session-count bound', () => {
    const state = stateFixture();
    state.sessions = Object.fromEntries(Array.from({ length: M365_MAX_SESSIONS + 1 }, (_, index) => [`${index}`.padStart(64, '0'), {}])) as typeof state.sessions;
    expect(() => assertM365CopilotWebUpstreamState(state)).toThrow(`exceed ${M365_MAX_SESSIONS}`);
  });

  it('reports live claims for re-enrollment fencing', () => {
    const state = stateFixture();
    expect(hasLiveM365Claim(state, 1_000)).toBe(false);
    state.accountLease = { claimToken: 'claim', claimExpiresAt: 2_000 };
    expect(hasLiveM365Claim(state, 1_000)).toBe(true);
    expect(hasLiveM365Claim(state, 2_000)).toBe(false);
  });
});
