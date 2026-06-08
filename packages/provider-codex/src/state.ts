// Gateway-managed Codex credential state, persisted in upstreams.state_json.
// Writes happen via UpstreamRepo.saveState with optimistic concurrency keyed
// on the prior state JSON.

export type CodexCredentialHealth = 'active' | 'session_terminated' | 'refresh_failed';

// One account's autonomous credential state, joined back to its identity in
// CodexUpstreamConfig.accounts via `chatgptAccountId`.
export interface CodexAccountCredential {
  chatgptAccountId: string;
  // OpenAI rotates refresh_token on every /oauth/token call. Stored in D1
  // (not KV) so KV eviction never forces operator re-import.
  refresh_token: string;
  state: CodexCredentialHealth;
  state_message?: string;
  // ISO 8601, written on every state transition (initial import, rotation,
  // terminal-state flip). The mutation paths in routes.ts and provider.ts
  // always set it together with `state`, so it's required on the wire.
  state_updated_at: string;
}

// Account-pool state. v1 always carries exactly one entry; the asserter
// enforces that, mirroring the same invariant on CodexUpstreamConfig.
export interface CodexUpstreamState {
  accounts: CodexAccountCredential[];
}

const ALLOWED_CREDENTIAL_KEYS_MAP: Record<keyof CodexAccountCredential, true> = {
  chatgptAccountId: true,
  refresh_token: true,
  state: true,
  state_message: true,
  state_updated_at: true,
};

const ALLOWED_STATE_KEYS_MAP: Record<keyof CodexUpstreamState, true> = {
  accounts: true,
};

const assertCodexAccountCredential = (value: unknown, where: string): void => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`);
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(key in ALLOWED_CREDENTIAL_KEYS_MAP)) {
      throw new TypeError(`${where} has unexpected key '${key}'`);
    }
  }
  if (typeof obj.chatgptAccountId !== 'string' || obj.chatgptAccountId === '') {
    throw new TypeError(`${where}.chatgptAccountId must be a non-empty string`);
  }
  if (typeof obj.refresh_token !== 'string' || obj.refresh_token === '') {
    throw new TypeError(`${where}.refresh_token must be a non-empty string`);
  }
  if (obj.state !== 'active' && obj.state !== 'session_terminated' && obj.state !== 'refresh_failed') {
    throw new TypeError(`${where}.state must be one of 'active' | 'session_terminated' | 'refresh_failed', got ${String(obj.state)}`);
  }
  if (obj.state_message !== undefined && typeof obj.state_message !== 'string') {
    throw new TypeError(`${where}.state_message must be a string when present`);
  }
  if (typeof obj.state_updated_at !== 'string' || obj.state_updated_at === '') {
    throw new TypeError(`${where}.state_updated_at must be a non-empty ISO string`);
  }
};

export function assertCodexUpstreamState(value: unknown): asserts value is CodexUpstreamState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('CodexUpstreamState must be a plain object');
  }
  const obj = value as Record<string, unknown>;
  // state_json round-trips through canonical serialization, so any surviving
  // key is persisted. Reject unknown keys to keep the on-disk shape closed.
  for (const key of Object.keys(obj)) {
    if (!(key in ALLOWED_STATE_KEYS_MAP)) {
      throw new TypeError(`CodexUpstreamState has unexpected key '${key}'`);
    }
  }
  if (!Array.isArray(obj.accounts)) {
    throw new TypeError('CodexUpstreamState.accounts must be an array');
  }
  if (obj.accounts.length !== 1) {
    throw new TypeError(`CodexUpstreamState.accounts must hold exactly one account (got ${obj.accounts.length})`);
  }
  for (let i = 0; i < obj.accounts.length; i++) {
    assertCodexAccountCredential(obj.accounts[i], `CodexUpstreamState.accounts[${i}]`);
  }
}
