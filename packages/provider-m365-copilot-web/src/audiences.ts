import { M365_CHAT_SCOPES } from './enrollment.ts';

export const M365_OAUTH_AUDIENCES = {
  chat: M365_CHAT_SCOPES,
} as const;

export type M365OAuthAudience = keyof typeof M365_OAUTH_AUDIENCES;

export const ALL_M365_OAUTH_AUDIENCES = Object.keys(M365_OAUTH_AUDIENCES) as M365OAuthAudience[];
