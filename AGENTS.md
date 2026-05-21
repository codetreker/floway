# AGENTS.md

## Hard Rules

- Do not open a Pull Request without explicit human approval. The human must
  understand the goal and risk, read the AI-generated code and PR text, and
  believe code, docs, and tests are internally consistent.
- Do not create commits unless the human explicitly asks for a commit.
- Before claiming work is complete, run the relevant verification command and
  read the result.
- Keep this file aligned with real architecture. Rewrite it when needed; do not
  accrete contradictory notes.

## Project

`copilot-gateway` is a Cloudflare Workers API proxy. It exposes Anthropic
Messages, OpenAI Responses, OpenAI Chat Completions, Embeddings, and Google
Gemini-compatible APIs over GitHub Copilot accounts and optional custom
OpenAI-compatible upstreams.

Stack: Hono + Web APIs, repository-backed persistence, D1 on Cloudflare Workers,
in-memory repositories for tests, TypeScript, pnpm, and Vitest.

The production runtime contract is Workers-compatible: a fetch entrypoint,
Workers bindings, Web APIs, and a D1-compatible SQL binding. Keep the narrow
`src/runtime/` compatibility layer for future runtimes that can provide the same
semantics. Do not add a separate Node.js HTTP server or Node+SQLite production
binding unless that becomes an explicit product goal.

## Boundaries

- `entry-cloudflare.ts`: Workers entrypoint and environment wiring.
- `src/app.ts`: Hono app wiring, middleware, and plane mounting.
- `src/control-plane/`: dashboard, auth, admin APIs, import/export, usage and
  performance views.
- `src/data-plane/`: client-facing compatibility APIs, model/provider routing,
  protocol translation, embeddings, and data-plane tools.
- `src/data-plane/providers/`: provider interface, provider registry, model
  merge, provider-owned alias resolution, and concrete provider implementations.
- `src/data-plane/providers/copilot/`: Copilot provider projection, raw model
  variant selection, endpoint capability projection, and Copilot-specific
  provider registrations.
- `src/data-plane/providers/openai/`: custom OpenAI-compatible provider
  behavior.
- `src/repo/`: persistence interfaces and implementations.
- `src/runtime/`: runtime integration helpers for environment access and
  background scheduling.
- `src/shared/`: project-wide helpers that are not owned by one plane.
- `src/shared/upstream/`: low-level HTTP adapters. These know how to call an
  upstream, but they do not own LLM planning or provider selection.

Keep behavior in the subtree that owns the boundary where it is true. Avoid flat
shared utility modules unless the rule is genuinely cross-boundary.

## Providers

The data plane treats every Copilot account and every custom upstream config as
a `ModelProvider`. The LLM pipeline must not branch on provider kind. Provider
methods receive the exact `UpstreamModel` object previously returned by that
provider.

Provider API shape:

```text
getProvidedModels() -> UpstreamModel[]
callChatCompletions(upstreamModel, bodyWithoutModel, signal?)
callResponses(upstreamModel, bodyWithoutModel, signal?)
callMessages(upstreamModel, bodyWithoutModel, signal?, anthropicBeta?)
callMessagesCountTokens(upstreamModel, bodyWithoutModel, signal?, anthropicBeta?)
callEmbeddings(upstreamModel, bodyWithoutModel, signal?)
```

`UpstreamModel.supportedEndpoints` is the source of truth for routing. The
registry separates public catalog data from execution bindings:

- `CatalogModel` is the public model-listing DTO. It must not expose provider
  bindings, raw upstream variants, or UI-only provider metadata.
- `ResolvedModel` extends the catalog shape with ordered `ProviderModelRecord`
  bindings for execution.
- `ProviderModelRecord` keeps the provider instance, upstream id, exact
  `UpstreamModel`, enabled fixes, and provider-registered source/target
  interceptors.

Request execution tries provider bindings in order only until the first binding
that can serve the requested source shape. That provider's result is final for
the request. If no binding can produce a plan, return a source-shaped
unsupported-model error instead of inventing legacy model-name routing. Source
and capability handlers should loop over provider bindings directly; do not hide
provider eligibility behind callback-based wrappers or "try-next-provider"
pseudo-results.

Provider-specific behavior is registered by the provider and then executed at
the owning source or target boundary. Copilot behavior includes raw model
variant selection, Claude public-name normalization, request-alias resolution,
endpoint projection, `anthropic-beta` filtering, and Copilot upstream request
fixes. Generic source/target pipelines execute registered interceptor lists but
do not choose behavior based on provider kind.

Messages web-search behavior is decided by the post-plan Messages protocol
interceptor. Messages via Responses or Chat Completions always uses the gateway
shim when native web-search tools are present, because those targets cannot run
Anthropic server tools. Native Messages targets receive native web-search tools
directly by default; Copilot providers enable the shim directly, while custom
OpenAI-compatible providers enable it only through the `messages-web-search-shim`
upstream fix flag. Do not rewrite the shim as part of unrelated data-plane flow
work.

Backoff is intentionally disabled for now. Control-plane status returns empty
temporary-unavailability data until a provider-level backoff design lands.

## Data Plane

`src/data-plane/llm/` owns LLM source routing for Messages, Responses, Chat
Completions, Gemini generation, and source-owned token counting endpoints.
Models, embeddings, and data-plane tools live outside that LLM routing graph in
their capability directories.

Model listing belongs in `src/data-plane/models/`: `/v1/models` is
OpenAI-shaped, `/models` is Anthropic-shaped, and `/v1beta/models` is
Gemini-shaped. Public data-plane model APIs consume `CatalogModel`; execution
paths use `ResolvedModel` and `ProviderModelRecord`.

The LLM execution flow is:

```text
serve -> source request cleanup -> resolve model -> provider binding loop
  -> plan from that provider's UpstreamModel
  -> provider-registered source interceptors -> build target request
  -> target interceptors -> emit through provider method
  -> translate target events to source events -> source respond
```

Use those terms. Planning is the only layer that chooses a target. Successful
execution after `emit` is event-first and should flow through protocol events
whenever practical.

Interceptors are protocol-exchange scoped, not source/target-contract scoped.
`MessagesInterceptor`, `ResponsesInterceptor`, and `ChatCompletionsInterceptor`
have one concrete context/result contract per protocol whether that protocol
appears on the client/source side or the upstream/target side. Provider source
and target registrations are separate execution slots, but they use the same
protocol aliases for the same protocol. The shared post-plan `LlmExchangeMeta`
contains `sourceApi`, `targetApi`, model/provider metadata, `enabledFixes`,
`apiKeyId`, and the downstream abort signal. Do not put responder or telemetry
details such as `clientStream`, `runtimeLocation`, or `scheduleBackground` in
interceptor context. Raw upstream frames stay inside target emitters and
raw-to-protocol converters; protocol interceptors see protocol request payloads
and protocol result/events.

Source response flow is source-owned. Each concrete source responder owns its
own upstream/internal error shaping, non-stream collection, stream terminal
observation, downstream SSE serialization, usage extraction, usage recording,
and request performance recording in forward order. Shared source helpers in
`src/data-plane/llm/sources/respond.ts` may hold only low-level stream state,
final metadata, usage recording, and request performance helpers; they must not
accept source-specific callback tables or call back into source behavior.
Protocol `events/to-sse.ts` serializers must stay pure: they convert source
protocol frames to SSE frames and must not record usage, mutate external state,
or accept callback listeners for accounting.

Target emission is target-owned. Each concrete target emit file owns its forward
order: force target-required streaming, run target interceptors, call the
provider method, build model accounting, normalize the upstream response into
raw frames, translate raw frames into target protocol events, and preserve
target-shaped failures. Shared target helpers in
`src/data-plane/llm/targets/emit.ts` may hold only low-level provider body,
accounting, upstream response, telemetry, and internal-error helpers; they must
not accept target-specific callback tables or call back into target behavior.

Request translation is direct and pairwise. Do not introduce a canonical
internal request IR. Pair translators belong under
`src/data-plane/llm/translate/<source>-via-<target>/`.

Workarounds belong at the owning boundary:

- source request cleanup, provider-registered source interceptors, whole-flow
  retry, final response shaping, usage observation, and request performance
  recording stay under `src/data-plane/llm/sources/<source>/` or the shared
  source responder.
- target upstream request fixes, upstream retries, target event fixes, provider
  call normalization, and target telemetry stay under
  `src/data-plane/llm/targets/<target>/` or shared target helpers.
- provider-specific interceptor registrations live on provider records;
  concrete interceptor implementations live at the source or target boundary
  they patch.
- shared translation primitives belong in `src/data-plane/llm/translate/shared/`
  only when multiple pair directions need the same protocol rule.

## Routing

Target preferences:

- Messages: native Messages, then Responses, then Chat Completions.
- Responses: native Responses, then Messages, then Chat Completions.
- Chat Completions: native Chat Completions, then Messages, then Responses.
- Gemini generation has no native upstream target in the provider API; it uses
  Chat Completions, then Messages, then Responses.

Claude compatibility aliases and Copilot raw variant selection live in the
provider layer. Until there is a general model-alias feature, Responses rewrites
`codex-auto-review` to `gpt-5.4` with reasoning effort `low` at the Responses
source entry, before model resolution and usage/performance metadata.
Historical accounting rows are converted to the public model id only in
migrations.

## Contracts

Public data-plane compatibility APIs are stable external contracts.
Control-plane APIs and data-plane tool management APIs are UI-owned and must
stay consistent with frontend code, tests, and auth policy.

Authentication has two roles: `admin` via `ADMIN_KEY`, and API key user via a
stored API key. Mutating key APIs and GitHub account management are admin-only;
`GET /api/token-usage` is intentionally visible to any authenticated user.

## Errors and Style

- Preserve upstream status, headers, and body as directly as possible.
- Internal failures must expose useful debug information, including stack
  traces.
- Use explicit result unions for expected control flow.
- Keep fallback semantics strict; do not add synthetic defaults for convenience.
- Avoid `catch` for normal control flow. Use it at real boundaries: fetch,
  parsing, probing, top-level request guards, and explicit workaround retries.
- Prefer functional TypeScript, arrow functions, double quotes, and semicolons.
- Do not extract tiny one-off helpers unless they encode a real domain rule, are
  reused, materially simplify a flow, or need isolated tests.
- Comment only non-obvious decisions, upstream quirks, protocol mismatches, or
  references. Workaround comments should explain why the behavior exists and why
  it lives at that boundary. Use permalink URLs for external code.

## Verification

Primary commands:

```bash
pnpm run test
pnpm run typecheck
pnpm run dev
pnpm run deploy
pnpm run db:migrate
```

Wrangler commands should go through the local dependency with `pnpm wrangler` or
package scripts. When deploying, use `pnpm run deploy` or `pnpm wrangler deploy`
directly; do not pass `--dry-run`.

For manual data-plane validation, prefer `ADMIN_KEY` with the existing
`x-models-playground: 1` header on approved playground routes. Do not reuse or
create normal API keys for manual testing.

For Copilot-specific quirks, compare nearby Copilot gateway implementations
before inventing a new policy. For generic adapter behavior, compare at least
one Copilot gateway and one general LLM gateway. Do not cargo-cult behavior from
a single project.
