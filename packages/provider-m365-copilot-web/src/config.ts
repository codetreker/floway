import { assertExactKeys, assertPlainObject, readFiniteNumber, readNonEmptyString } from './validate.ts';
import type { UpstreamRecord } from '@floway-dev/provider';

export interface M365CopilotWebAccountConfig {
  tenantId: string;
  objectId: string;
  username: string;
  chatHubHost: 'substrate.office.com' | 'substrate.svc.cloud.microsoft';
  chatHubPath: string;
}

export interface M365CopilotWebUpstreamConfig {
  account: M365CopilotWebAccountConfig;
  locale: string;
  timeZone: string;
  timeZoneOffsetMinutes: number;
}

export type M365CopilotWebUpstreamRecord = UpstreamRecord & {
  kind: 'm365-copilot-web';
  config: M365CopilotWebUpstreamConfig;
  state: unknown;
};

const CONFIG_KEYS = new Set(['account', 'locale', 'timeZone', 'timeZoneOffsetMinutes']);
const ACCOUNT_KEYS = new Set(['tenantId', 'objectId', 'username', 'chatHubHost', 'chatHubPath']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

export const normalizeM365ChatHubPath = (value: string): string => {
  const path = value.trim().replace(/^\/+|\/+$/g, '');
  if (path.length === 0 || path.includes('?') || path.includes('#') || path.includes('..')) {
    throw new TypeError('M365 chatHubPath must be a non-empty relative path segment');
  }
  if (!/^[A-Za-z0-9@._~-]+$/.test(path)) {
    throw new TypeError('M365 chatHubPath contains unsupported characters');
  }
  return path;
};

export function assertM365CopilotWebUpstreamConfig(value: unknown): asserts value is M365CopilotWebUpstreamConfig {
  assertPlainObject(value, 'M365CopilotWebUpstreamConfig');
  assertExactKeys(value, CONFIG_KEYS, 'M365CopilotWebUpstreamConfig');
  assertPlainObject(value.account, 'M365CopilotWebUpstreamConfig.account');
  assertExactKeys(value.account, ACCOUNT_KEYS, 'M365CopilotWebUpstreamConfig.account');

  const tenantId = readNonEmptyString(value.account.tenantId, 'M365CopilotWebUpstreamConfig.account.tenantId');
  const objectId = readNonEmptyString(value.account.objectId, 'M365CopilotWebUpstreamConfig.account.objectId');
  if (!UUID.test(tenantId)) throw new TypeError('M365CopilotWebUpstreamConfig.account.tenantId must be a canonical UUID');
  if (!UUID.test(objectId)) throw new TypeError('M365CopilotWebUpstreamConfig.account.objectId must be a canonical UUID');
  const username = readNonEmptyString(value.account.username, 'M365CopilotWebUpstreamConfig.account.username');
  if (username.length > 320) throw new TypeError('M365CopilotWebUpstreamConfig.account.username is too long');
  if (value.account.chatHubHost !== 'substrate.office.com' && value.account.chatHubHost !== 'substrate.svc.cloud.microsoft') {
    throw new TypeError('M365CopilotWebUpstreamConfig.account.chatHubHost is invalid');
  }
  const rawChatHubPath = readNonEmptyString(value.account.chatHubPath, 'M365CopilotWebUpstreamConfig.account.chatHubPath');
  const chatHubPath = normalizeM365ChatHubPath(rawChatHubPath);
  if (rawChatHubPath !== chatHubPath || chatHubPath !== `${objectId}@${tenantId}`) {
    throw new TypeError('M365CopilotWebUpstreamConfig.account.chatHubPath must exactly match objectId@tenantId');
  }

  const locale = readNonEmptyString(value.locale, 'M365CopilotWebUpstreamConfig.locale');
  if (locale.length > 64 || !LOCALE.test(locale)) throw new TypeError('M365CopilotWebUpstreamConfig.locale is invalid');
  const timeZone = readNonEmptyString(value.timeZone, 'M365CopilotWebUpstreamConfig.timeZone');
  if (timeZone.length > 128) throw new TypeError('M365CopilotWebUpstreamConfig.timeZone is too long');
  const offset = readFiniteNumber(value.timeZoneOffsetMinutes, 'M365CopilotWebUpstreamConfig.timeZoneOffsetMinutes');
  if (!Number.isInteger(offset) || offset < -14 * 60 || offset > 14 * 60) {
    throw new TypeError('M365CopilotWebUpstreamConfig.timeZoneOffsetMinutes must be an integer in [-840, 840]');
  }
}

export function assertM365CopilotWebUpstreamRecord(
  record: UpstreamRecord,
): asserts record is M365CopilotWebUpstreamRecord {
  if (record.kind !== 'm365-copilot-web') {
    throw new TypeError(`Expected provider 'm365-copilot-web', got '${record.kind}'`);
  }
  assertM365CopilotWebUpstreamConfig(record.config);
}
