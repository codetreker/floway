-- PKCE state was previously cached server-side so the import callback could
-- reunite the verifier with the round-tripped state. The dashboard now mints
-- verifier + state in the browser via Web Crypto, stashes them in
-- sessionStorage, validates the returned state itself, and posts
-- {code, verifier} on import. The pending table has no readers left.

DROP TABLE IF EXISTS codex_pkce_pending;
