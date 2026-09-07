import { M365_COPILOT_WEB_DEFAULT_FLAGS } from './defaults.ts';
import { createM365CopilotWebProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const m365CopilotWebProviderModule: ProviderModule = {
  create: createM365CopilotWebProvider,
  defaultFlags: M365_COPILOT_WEB_DEFAULT_FLAGS,
};

export * from './audiences.ts';
export * from './chat.ts';
export * from './config.ts';
export * from './errors.ts';
export * from './jwt.ts';
export * from './models.ts';
export * from './access-token.ts';
export * from './enrollment.ts';
export * from './oauth.ts';
export * from './oidc.ts';
export * from './session-state.ts';
export * from './sessions.ts';
export * from './heartbeat.ts';
export * from './signalr.ts';
export * from './state.ts';
export * from './transcript.ts';
