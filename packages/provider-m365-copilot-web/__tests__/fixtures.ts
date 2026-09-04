import type { M365CopilotWebUpstreamConfig } from '../src/config.ts';
import type { M365CopilotWebUpstreamState } from '../src/state.ts';
import type { UpstreamRecord } from '@floway-dev/provider';

export const CONFIG: M365CopilotWebUpstreamConfig = {
  account: {
    tenantId: '11111111-1111-4111-8111-111111111111',
    objectId: '22222222-2222-4222-8222-222222222222',
    username: 'operator@example.com',
    chatHubHost: 'substrate.office.com',
    chatHubPath: '22222222-2222-4222-8222-222222222222@11111111-1111-4111-8111-111111111111',
  },
  locale: 'en-GB',
  timeZone: 'Europe/London',
  timeZoneOffsetMinutes: 60,
};

export const stateFixture = (): M365CopilotWebUpstreamState => ({
  credential: { credentialId: 'credential-1', refreshToken: 'refresh-token', generation: 1, health: 'active', stateUpdatedAt: '2026-09-04T00:00:00.000Z' },
  accessToken: null,
  toneReceipts: {},
  sessions: {},
  accountLease: null,
});

export const recordFixture = (state = stateFixture()): UpstreamRecord => ({
  id: 'm365', kind: 'm365-copilot-web', name: 'M365', enabled: true, sortOrder: 0,
  createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
  config: CONFIG, state, modelsCache: null, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], modelPrefix: null, hue: 1,
});
