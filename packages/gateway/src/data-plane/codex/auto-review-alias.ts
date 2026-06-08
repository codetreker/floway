// codex's `codex-auto-review` is a model-id alias the CLI sends on auto-review
// turns; it has no upstream of its own and gets rewritten request-side to
// `gpt-5.4`. The constants live here so the responses HTTP entry (which
// performs the rewrite) and the codex 1p catalog handler (which decides
// whether to keep the alias slug in the catalog) can agree on the target
// without one reaching into the other's module.
//
// Codex defines the alias as `DEFAULT_APPROVAL_REVIEW_PREFERRED_MODEL`:
// https://github.com/openai/codex/blob/e7bffc5a20e92cbc64d6c16a1b257d0b2e4cd5df/codex-rs/model-provider/src/provider.rs#L73-L96

export const CODEX_AUTO_REVIEW_ALIAS = 'codex-auto-review';
export const CODEX_AUTO_REVIEW_TARGET = 'gpt-5.4';
