// Shared types for the Codex import UI. CodexConfigPanel orchestrates the
// authorize-url + auth.json paste flow and CodexImportTabs renders the two-tab
// paste area; both consume the same authorize-url response shape and the same
// tab discriminator, hoisted here so the parent and child cannot drift.

export interface CodexAuthorizeUrlResult {
  authorize_url: string;
}

export type CodexImportTab = 'auth_json' | 'callback';
