import { assertExactKeys, assertPlainObject, isSafeRecordKey, readFiniteNumber, readInteger, readIsoDate, readNonEmptyString } from './validate.ts';

export const M365_MAX_SESSIONS = 64;
export const M365_MAX_STATE_BYTES = 256 * 1024;
export const M365_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const M365_CLAIM_TTL_MS = 2 * 60 * 1000;
export const M365_UNCERTAIN_TTL_MS = 10 * 60 * 1000;
export const M365_ENROLLMENT_LEASE_TTL_MS = 5 * 60 * 1000;
export const M365_TONE_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

export type M365CredentialHealth = 'active' | 'reauth_required' | 'refresh_failed';
export type M365SessionStatus = 'active' | 'claimed' | 'uncertain';

export interface M365CredentialState {
  credentialId: string;
  refreshToken: string;
  generation: number;
  health: M365CredentialHealth;
  stateUpdatedAt: string;
  stateMessage?: string;
}

export interface M365AccessTokenState {
  token: string;
  expiresAt: number;
  refreshedAt: string;
  credentialGeneration: number;
}

export interface M365ToneReceiptState {
  tone: string;
  available: boolean;
  probedAt: string;
  expiresAt: number;
  diagnostic?: string;
}

export interface M365SessionState {
  handleHash: string;
  apiKeyId: string;
  modelId: string;
  routeProfileDigest: string;
  historyDigest: string;
  historyLength: number;
  sessionId: string;
  conversationId: string;
  turnCount: number;
  revision: number;
  status: M365SessionStatus;
  claimToken: string | null;
  claimExpiresAt: number | null;
  expiresAt: number;
  lastUsedAt: number;
}

export interface M365AccountLeaseState {
  claimToken: string;
  claimExpiresAt: number;
}

export interface M365CopilotWebUpstreamState {
  credential: M365CredentialState;
  accessToken: M365AccessTokenState | null;
  toneReceipts: Record<string, M365ToneReceiptState>;
  sessions: Record<string, M365SessionState>;
  accountLease: M365AccountLeaseState | null;
}

const STATE_KEYS = new Set(['credential', 'accessToken', 'toneReceipts', 'sessions', 'accountLease']);
const CREDENTIAL_KEYS = new Set(['credentialId', 'refreshToken', 'generation', 'health', 'stateUpdatedAt', 'stateMessage']);
const ACCESS_TOKEN_KEYS = new Set(['token', 'expiresAt', 'refreshedAt', 'credentialGeneration']);
const TONE_RECEIPT_KEYS = new Set(['tone', 'available', 'probedAt', 'expiresAt', 'diagnostic']);
const SESSION_KEYS = new Set([
  'handleHash', 'apiKeyId', 'modelId', 'routeProfileDigest', 'historyDigest', 'historyLength',
  'sessionId', 'conversationId', 'turnCount', 'revision', 'status', 'claimToken', 'claimExpiresAt',
  'expiresAt', 'lastUsedAt',
]);
const ACCOUNT_LEASE_KEYS = new Set(['claimToken', 'claimExpiresAt']);
const SHA256_HEX = /^[0-9a-f]{64}$/;

function assertCredential(value: unknown): asserts value is M365CredentialState {
  assertPlainObject(value, 'M365CopilotWebUpstreamState.credential');
  assertExactKeys(value, CREDENTIAL_KEYS, 'M365CopilotWebUpstreamState.credential');
  readNonEmptyString(value.credentialId, 'M365CopilotWebUpstreamState.credential.credentialId');
  readNonEmptyString(value.refreshToken, 'M365CopilotWebUpstreamState.credential.refreshToken');
  if (readInteger(value.generation, 'M365CopilotWebUpstreamState.credential.generation') < 1) throw new TypeError('M365 credential generation must be positive');
  if (value.health !== 'active' && value.health !== 'reauth_required' && value.health !== 'refresh_failed') throw new TypeError('M365 credential health is invalid');
  readIsoDate(value.stateUpdatedAt, 'M365CopilotWebUpstreamState.credential.stateUpdatedAt');
  if (value.stateMessage !== undefined && typeof value.stateMessage !== 'string') throw new TypeError('M365 credential stateMessage must be a string');
}

function assertAccessToken(value: unknown): asserts value is M365AccessTokenState {
  assertPlainObject(value, 'M365CopilotWebUpstreamState.accessToken');
  assertExactKeys(value, ACCESS_TOKEN_KEYS, 'M365CopilotWebUpstreamState.accessToken');
  readNonEmptyString(value.token, 'M365CopilotWebUpstreamState.accessToken.token');
  readFiniteNumber(value.expiresAt, 'M365CopilotWebUpstreamState.accessToken.expiresAt');
  readIsoDate(value.refreshedAt, 'M365CopilotWebUpstreamState.accessToken.refreshedAt');
  if (readInteger(value.credentialGeneration, 'M365CopilotWebUpstreamState.accessToken.credentialGeneration') < 1) throw new TypeError('M365 access token credentialGeneration must be positive');
}

function assertToneReceipt(value: unknown, modelId: string): asserts value is M365ToneReceiptState {
  const where = `M365CopilotWebUpstreamState.toneReceipts.${modelId}`;
  assertPlainObject(value, where);
  assertExactKeys(value, TONE_RECEIPT_KEYS, where);
  readNonEmptyString(value.tone, `${where}.tone`);
  if (typeof value.available !== 'boolean') throw new TypeError(`${where}.available must be a boolean`);
  readIsoDate(value.probedAt, `${where}.probedAt`);
  readFiniteNumber(value.expiresAt, `${where}.expiresAt`);
  if (value.diagnostic !== undefined && typeof value.diagnostic !== 'string') throw new TypeError(`${where}.diagnostic must be a string`);
}

function assertSession(value: unknown, handleHash: string): asserts value is M365SessionState {
  const where = `M365CopilotWebUpstreamState.sessions.${handleHash}`;
  assertPlainObject(value, where);
  assertExactKeys(value, SESSION_KEYS, where);
  if (value.handleHash !== handleHash || !SHA256_HEX.test(handleHash)) throw new TypeError(`${where}.handleHash is invalid`);
  readNonEmptyString(value.apiKeyId, `${where}.apiKeyId`);
  readNonEmptyString(value.modelId, `${where}.modelId`);
  for (const key of ['routeProfileDigest', 'historyDigest'] as const) {
    const digest = readNonEmptyString(value[key], `${where}.${key}`);
    if (!SHA256_HEX.test(digest)) throw new TypeError(`${where}.${key} must be SHA-256 hex`);
  }
  for (const key of ['historyLength', 'turnCount', 'revision'] as const) {
    if (readInteger(value[key], `${where}.${key}`) < 0) throw new TypeError(`${where}.${key} must be non-negative`);
  }
  readNonEmptyString(value.sessionId, `${where}.sessionId`);
  readNonEmptyString(value.conversationId, `${where}.conversationId`);
  if (value.status !== 'active' && value.status !== 'claimed' && value.status !== 'uncertain') throw new TypeError(`${where}.status is invalid`);
  const hasClaim = value.claimToken !== null || value.claimExpiresAt !== null;
  if (value.status === 'active' && hasClaim) throw new TypeError(`${where} active session cannot carry a claim`);
  if (value.status !== 'active') {
    readNonEmptyString(value.claimToken, `${where}.claimToken`);
    readFiniteNumber(value.claimExpiresAt, `${where}.claimExpiresAt`);
  }
  readFiniteNumber(value.expiresAt, `${where}.expiresAt`);
  readFiniteNumber(value.lastUsedAt, `${where}.lastUsedAt`);
}

function assertAccountLease(value: unknown): asserts value is M365AccountLeaseState {
  assertPlainObject(value, 'M365CopilotWebUpstreamState.accountLease');
  assertExactKeys(value, ACCOUNT_LEASE_KEYS, 'M365CopilotWebUpstreamState.accountLease');
  readNonEmptyString(value.claimToken, 'M365CopilotWebUpstreamState.accountLease.claimToken');
  readFiniteNumber(value.claimExpiresAt, 'M365CopilotWebUpstreamState.accountLease.claimExpiresAt');
}

export function assertM365CopilotWebUpstreamState(value: unknown): asserts value is M365CopilotWebUpstreamState {
  assertPlainObject(value, 'M365CopilotWebUpstreamState');
  assertExactKeys(value, STATE_KEYS, 'M365CopilotWebUpstreamState');
  assertCredential(value.credential);
  if (value.accessToken !== null) assertAccessToken(value.accessToken);
  assertPlainObject(value.toneReceipts, 'M365CopilotWebUpstreamState.toneReceipts');
  for (const [modelId, receipt] of Object.entries(value.toneReceipts)) {
    if (!isSafeRecordKey(modelId)) throw new TypeError(`Invalid M365 tone receipt model id '${modelId}'`);
    assertToneReceipt(receipt, modelId);
  }
  assertPlainObject(value.sessions, 'M365CopilotWebUpstreamState.sessions');
  if (Object.keys(value.sessions).length > M365_MAX_SESSIONS) throw new TypeError(`M365 sessions exceed ${M365_MAX_SESSIONS}`);
  for (const [handleHash, session] of Object.entries(value.sessions)) assertSession(session, handleHash);
  if (value.accountLease !== null) assertAccountLease(value.accountLease);
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > M365_MAX_STATE_BYTES) throw new TypeError(`M365 upstream state exceeds ${M365_MAX_STATE_BYTES} bytes`);
}

export const readM365CopilotWebUpstreamState = (value: unknown): M365CopilotWebUpstreamState => {
  assertM365CopilotWebUpstreamState(value);
  return value;
};

export const m365StateForTransfer = (value: unknown): M365CopilotWebUpstreamState => {
  const state = readM365CopilotWebUpstreamState(value);
  return {
    credential: state.credential,
    accessToken: null,
    toneReceipts: {},
    sessions: {},
    accountLease: null,
  };
};

export const hasLiveM365Claim = (value: unknown, now = Date.now()): boolean => {
  const state = readM365CopilotWebUpstreamState(value);
  return (state.accountLease?.claimExpiresAt ?? 0) > now
    || Object.values(state.sessions).some(session => session.status !== 'active' && (session.claimExpiresAt ?? 0) > now);
};
