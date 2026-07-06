// Hoisted out of ClaudeCodeConfigPanel/ClaudeCodeImportTabs so the parent
// and child cannot drift on the shared shape.

export interface ClaudeCodeAuthorizeUrlResult {
  authorize_url: string;
}

export type ClaudeCodeImportTab = 'credentials_json' | 'callback' | 'setup_token_callback';
