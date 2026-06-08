// Shared types for the Codex import UI. CodexConfigPanel orchestrates the
// PKCE + auth.json paste flow and CodexImportTabs renders the two-tab paste
// area; both consume the same upstream PKCE response shape and the same
// tab discriminator, hoisted here so the parent and child cannot drift.

export interface CodexPkceStartResult {
  authorize_url: string;
  expires_in_seconds: number;
}

export type CodexImportTab = 'auth_json' | 'callback';
