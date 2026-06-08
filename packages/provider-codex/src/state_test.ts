import { describe, expect, test } from 'vitest';

import { assertCodexUpstreamState, type CodexUpstreamState } from './state.ts';

const goodAccount = { chatgptAccountId: 'acc_x', refresh_token: 'rt_x', state: 'active' as const, state_updated_at: '2026-01-01T00:00:00Z' };
const good: CodexUpstreamState = { accounts: [goodAccount] };

describe('assertCodexUpstreamState', () => {
  test('accepts active state', () => {
    expect(() => assertCodexUpstreamState(good)).not.toThrow();
  });
  test('accepts terminal states with state_message', () => {
    expect(() => assertCodexUpstreamState({
      accounts: [{
        chatgptAccountId: 'acc_x',
        refresh_token: 'rt_x',
        state: 'session_terminated',
        state_message: 'Token revoked',
        state_updated_at: '2026-06-05T00:00:00.000Z',
      }],
    })).not.toThrow();
    expect(() => assertCodexUpstreamState({
      accounts: [{ chatgptAccountId: 'acc_x', refresh_token: 'rt_x', state: 'refresh_failed', state_updated_at: '2026-06-05T00:00:00.000Z' }],
    })).not.toThrow();
  });
  test('rejects missing state_updated_at', () => {
    const { state_updated_at: _drop, ...withoutTimestamp } = goodAccount;
    expect(() => assertCodexUpstreamState({ accounts: [withoutTimestamp] })).toThrow(/state_updated_at/);
  });
  test('rejects empty refresh_token', () => {
    expect(() => assertCodexUpstreamState({ accounts: [{ ...goodAccount, refresh_token: '' }] })).toThrow(/refresh_token/);
  });
  test('rejects empty chatgptAccountId', () => {
    expect(() => assertCodexUpstreamState({ accounts: [{ ...goodAccount, chatgptAccountId: '' }] })).toThrow(/chatgptAccountId/);
  });
  test('rejects unknown state value', () => {
    expect(() => assertCodexUpstreamState({ accounts: [{ ...goodAccount, state: 'broken' }] })).toThrow(/state/);
  });
  test('rejects null / undefined / non-objects', () => {
    expect(() => assertCodexUpstreamState(null)).toThrow();
    expect(() => assertCodexUpstreamState(undefined)).toThrow();
    expect(() => assertCodexUpstreamState('s')).toThrow();
  });
  test('rejects unexpected keys at the top level', () => {
    expect(() => assertCodexUpstreamState({ ...good, extra_field: 'x' })).toThrow(/extra_field/);
  });
  test('rejects unexpected keys inside an account', () => {
    expect(() => assertCodexUpstreamState({ accounts: [{ ...goodAccount, smuggled: 'x' }] })).toThrow(/smuggled/);
  });
  test('rejects an empty accounts array (v1 invariant: exactly one)', () => {
    expect(() => assertCodexUpstreamState({ accounts: [] })).toThrow(/exactly one/);
  });
  test('rejects multiple accounts (v1 invariant: exactly one)', () => {
    expect(() => assertCodexUpstreamState({ accounts: [goodAccount, { ...goodAccount, chatgptAccountId: 'acc_y' }] })).toThrow(/exactly one/);
  });
});
