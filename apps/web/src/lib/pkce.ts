// Client-side PKCE helpers for the codex and claude-code OAuth flows.
//
// The dashboard mints the verifier, challenge and state in the browser via
// Web Crypto, stashes `{verifier, state}` in sessionStorage while the
// operator is away on the provider's consent screen, then validates the
// state echoed back in the callback URL before posting `{code, verifier}`
// to the gateway's import endpoint. The verifier never leaves the browser
// until the matching state comes back, which is the whole point of PKCE.

const base64UrlEncode = (bytes: Uint8Array): string => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

// PKCE challenge is the base64url of SHA-256(verifier). Exported separately
// so the in-flight resume path can rebuild the authorize URL from a stashed
// verifier without re-minting, keeping the operator's already-opened
// consent screen valid.
export const deriveChallenge = async (verifier: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
};

export const generatePkce = async (): Promise<{ verifier: string; challenge: string; state: string }> => {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64UrlEncode(verifierBytes);
  const challenge = await deriveChallenge(verifier);
  const state = crypto.randomUUID().replaceAll('-', '');
  return { verifier, challenge, state };
};

// Matches the Claude Code CLI's own error string for the `<code>#<state>`
// format so an operator hitting the same failure sees the same wording in
// both places.
const CLAUDE_CODE_INVALID_PASTE = 'Invalid code. Please make sure the full code was copied';

export const parseCallbackPaste = (input: string): { code: string; state: string } => {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Paste the callback URL or code returned by the provider');

  // Claude Code CLI displays the callback as `<code>#<state>` (a literal '#'
  // separator, no query string). Detected by the absence of any URL-query
  // syntax and the presence of exactly one '#'. Both halves must be
  // non-empty — match the CLI's error wording verbatim.
  if (!trimmed.includes('?') && !trimmed.includes('=') && !trimmed.includes('&')) {
    const hashCount = (trimmed.match(/#/g) ?? []).length;
    if (hashCount === 1) {
      const [code, state] = trimmed.split('#');
      if (!code || !state) throw new Error(CLAUDE_CODE_INVALID_PASTE);
      return { code, state };
    }
    if (hashCount > 1) throw new Error(CLAUDE_CODE_INVALID_PASTE);
  }

  // Anything else is treated as a URL or URL fragment. Strip the leading '?'
  // from a bare query string, and prepend a scheme + host to a path-only
  // input so `URL` can parse it. We deliberately let URL parse errors bubble
  // via cause-chain rather than swallowing them — a malformed paste should
  // surface its real reason to the operator.
  const queryString = (() => {
    if (trimmed.startsWith('?')) return trimmed.slice(1);
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      try { return new URL(trimmed).search.replace(/^\?/, ''); } catch (e) { throw new Error(`Could not parse callback URL: ${e instanceof Error ? e.message : String(e)}`, { cause: e }); }
    }
    const questionMarkIndex = trimmed.indexOf('?');
    if (questionMarkIndex !== -1) return trimmed.slice(questionMarkIndex + 1);
    // No '?' but the input contains URL-encoded key=value pairs: treat the
    // whole thing as a bare query string.
    if (trimmed.includes('=')) return trimmed;
    // Neither a URL, a query, nor a Claude Code paste.
    throw new Error('Paste must be the redirected URL, its query string, or the code#state shown by the CLI');
  })();

  const params = new URLSearchParams(queryString);
  const code = params.get('code');
  const state = params.get('state');
  if (!code) throw new Error('Callback is missing the `code` parameter');
  if (!state) throw new Error('Callback is missing the `state` parameter');
  return { code, state };
};

// Each flow that the operator can run in parallel owns its own slot, so
// preparing one does not overwrite another in-flight one. codex has a
// single flow; claude-code has two (`oauth`, `setup-token`) — pass the
// kind there.
export const pkceStorageKey = (provider: 'codex' | 'claude-code', kind?: string): string =>
  kind ? `floway:pkce:${provider}:${kind}` : `floway:pkce:${provider}`;

interface StashedPkce {
  verifier: string;
  state: string;
}

export const stashPkce = (key: string, payload: StashedPkce): void => {
  sessionStorage.setItem(key, JSON.stringify(payload));
};

// Read the stashed payload without consuming it. The mount-time resume
// path uses this to recover an in-flight flow across component remounts
// (Vite HMR, router navigation back to the same page) — it derives the
// challenge from the stashed verifier and rebuilds the authorize URL
// with the SAME state, instead of minting fresh and orphaning whatever
// consent screen the operator may have already opened.
export const peekStashedPkce = (key: string): StashedPkce | null => {
  const raw = sessionStorage.getItem(key);
  if (!raw) return null;
  return JSON.parse(raw) as StashedPkce;
};

// Recall the stash and verify the round-tripped state matches. Non-
// destructive: the stash survives so the operator can retry the same
// paste if the import fails (a network error, Anthropic returning a
// transient 5xx, a wire-shape regression on our end). Callers MUST
// `clearPkce(key)` after a successful exchange — the OAuth code is
// single-use upstream, so a successful exchange burns it and the
// stash has no further use.
export const recallPkce = (key: string, returnedState: string): { verifier: string } | null => {
  const stash = peekStashedPkce(key);
  if (stash?.state !== returnedState) return null;
  return { verifier: stash.verifier };
};

export const clearPkce = (key: string): void => {
  sessionStorage.removeItem(key);
};
