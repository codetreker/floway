// PKCE S256 per RFC 7636. 64-byte verifier matches openai/codex's choice.

export interface CodexPkce {
  verifier: string;
  challenge: string;
}

export const generateCodexPkce = async (): Promise<CodexPkce> => {
  const rawVerifier = new Uint8Array(64);
  crypto.getRandomValues(rawVerifier);
  const verifier = base64UrlEncode(rawVerifier);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(new Uint8Array(digest));
  return { verifier, challenge };
};

const base64UrlEncode = (bytes: Uint8Array): string => {
  const raw = btoa(String.fromCharCode(...bytes));
  return raw.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
