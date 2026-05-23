# Copilot Gateway

Copilot Gateway is a Cloudflare Workers API proxy that exposes unified upstreams
through standard LLM APIs: Anthropic Messages, OpenAI Responses, OpenAI Chat
Completions, Embeddings, and Google Gemini-compatible model routes.

An upstream can be a GitHub Copilot account, a custom OpenAI-compatible bearer
provider, or an Azure deployment group. Azure deployments may use Azure OpenAI /
Foundry OpenAI v1 endpoints and, when configured, Azure Foundry Anthropic
Messages endpoints. The gateway merges model catalogs from enabled upstreams and
routes each request through the first provider binding that can serve the
requested public model and source API.

It is built for coding agents such as
[Claude Code](https://docs.anthropic.com/en/docs/claude-code),
[Codex CLI](https://github.com/openai/codex), and any client that can speak one
of the supported public API shapes.

## How It Works

Copilot Gateway translates between client-facing API formats and the upstream
endpoint selected for the resolved model:

- **Claude Code** can use the Anthropic Messages API.
- **Codex CLI** can use the OpenAI Responses API.
- **OpenAI-compatible clients** can use Chat Completions, Responses, Models, and
  Embeddings routes.
- **Gemini-compatible clients** can use `generateContent`,
  `streamGenerateContent`, `countTokens`, and `models` routes under
  `/v1beta/models`.

The gateway reads each provider's model metadata, resolves a public model id to
ordered provider bindings, plans the target protocol for that provider, applies
registered protocol interceptors, and streams protocol events back in the
source API's shape.

## Quick Start

> **Tip**: This repository ships with `AGENTS.md`, which records the main
> architecture and workflow rules for coding agents. Claude Code and Codex CLI
> read it automatically.

### Prerequisites

- At least one upstream credential:
  - a GitHub account with an active [Copilot](https://github.com/features/copilot)
    subscription,
  - a bearer token for an OpenAI-compatible custom provider, or
  - one Azure endpoint URL, API key, and deployment list for Azure OpenAI /
    Foundry OpenAI v1 or Azure Foundry Anthropic deployments. The endpoint must
    be an HTTPS Azure URL on `*.openai.azure.com` or
    `*.services.ai.azure.com`, and can be a resource root, a Foundry project
    endpoint, an OpenAI v1 URL, an Anthropic base URL, or an Anthropic messages
    target URI.
- Node.js 20.3 or newer.
- pnpm 10.x.

### Deploy to Cloudflare Workers

```bash
# Clone and enter the project
git clone https://github.com/user/copilot-gateway.git
cd copilot-gateway

# Install dependencies
pnpm install

# Create the D1 database (pick a name; record it as database_name in wrangler.jsonc)
pnpm wrangler d1 create <DB_NAME>

# Update wrangler.jsonc with your account_id, database_id, and database_name,
# then apply migrations
pnpm run db:migrate

# Set the admin key as a secret
pnpm wrangler secret put ADMIN_KEY

# Local development
pnpm run dev

# Deploy to production
pnpm run deploy
```

### Self-Managed Workers-Compatible Runtime

For local or self-managed deployments, keep the same Workers binding contract and
run the Worker through a Workers-compatible runtime such as Wrangler, Miniflare,
or workerd. The production persistence binding is D1-compatible SQL; the project
does not ship a separate Node.js server or Node+SQLite production binding.

This keeps one runtime contract for production behavior while leaving the small
`apps/api/src/runtime/` compatibility layer in place for future runtimes that
can provide the same environment, background scheduling, and repository binding
semantics.

### Initial Setup

1. Open the deployed URL in a browser and log in with your `ADMIN_KEY`.
2. Open **Settings -> Upstreams** and use **Add Upstream** to add at least one
   provider. The add flow covers Custom, Azure, and Copilot. The Settings list
   is the routing order: use the row arrow buttons to reorder providers, the
   switch to enable or disable one provider, and the edit panel for provider
   configuration, saved-upstream connection tests, and Copilot quota.
   - **Custom** configures an OpenAI-compatible provider with a base URL,
     bearer token, supported endpoints, and optional path overrides.
   - **Azure** configures one Azure endpoint URL, one API key, and deployments.
     The endpoint must be an HTTPS Azure URL on `*.openai.azure.com` or
     `*.services.ai.azure.com`; it may be a resource root, a Foundry project
     endpoint, an OpenAI v1 URL ending in `/openai/v1`, an Anthropic URL ending
     in `/anthropic` or `/anthropic/v1`, or the Foundry Claude target URI ending
     in `/anthropic/v1/messages`. Each deployment uses the
     deployment name for upstream calls; a blank public model id defaults to
     that deployment name. OpenAI v1 can serve Azure-hosted OpenAI and other
     Foundry models such as DeepSeek, Grok, and Kimi when those deployments
     expose Responses, Chat Completions, or Embeddings. Native Messages uses the
     Anthropic protocol base derived from the same endpoint; Messages source
     requests can also translate through Responses or Chat Completions. In the
     dashboard each deployment row chooses a compact API type preset such as
     Responses, Responses+Chat, Chat, Messages, or Embeddings; the saved config
     stores the corresponding `supportedEndpoints` capability set. Claude
     deployments should normally be configured as Messages; Chat Completions
     clients can still route to them through gateway translation. Optional
     display/catalog metadata such as `display_name`, limits, and
     `model_picker_enabled` can be supplied through the API or import payloads;
     the main dashboard form keeps only the routing-critical fields visible.
   - **Copilot** starts GitHub device OAuth and creates or refreshes a Copilot
     upstream for that account.
3. Create a client API key under **API Keys**.
4. Copy the generated Claude Code or Codex CLI configuration snippets.

Copilot quota is shown inside the Copilot upstream edit panel. Import/export is
available from Settings and uses the latest `version: 2` payload with unified
`upstreams` data.

## Optional Native Messages Web Search

Anthropic-native-looking web search is accepted on `/v1/messages` and
`/messages`. Native Messages upstreams receive native web-search tools directly
unless the selected provider opts into gateway execution. When the selected
target cannot execute Anthropic server tools, the post-plan Messages protocol
interceptor runs the gateway shim, which requires an enabled search provider.

Configure it in the dashboard under **Settings -> Web Search**.

Provider choices:

- `disabled`
- `tavily`
- `microsoft-grounding`

The gateway stores this search config in control-plane data and includes it in
export/import.

## Development

```bash
pnpm install
pnpm run lint        # eslint --cache across the workspace
pnpm run test        # vitest run over root test.projects (all packages)
pnpm run typecheck   # pnpm -r run typecheck (one tsc --noEmit per package)
pnpm run dev         # builds apps/web, then wrangler dev on apps/api
```

The root scripts orchestrate across the workspace. `pnpm run dev` and
`pnpm run deploy` chain `pnpm --filter @copilot-gateway/web run build` before
wrangler runs, because the Worker's Static Assets binding serves
`apps/web/dist`. To work on a single package in isolation, use pnpm filters
such as `pnpm --filter @copilot-gateway/translate run typecheck`.

Wrangler commands should be run through the local dependency with
`pnpm wrangler` or through package scripts. ESLint owns code style and import
ordering; use `pnpm run lint:fix` for mechanical cleanup. Test coverage uses
Vitest.

## Architecture

```text
Claude Code / Codex CLI / any client
        |
        v
  Copilot Gateway (Hono on Workers)
  |-- POST /v1/messages
  |-- POST /v1/responses
  |-- POST /v1/chat/completions
  |-- POST /v1/embeddings
  |-- GET  /v1/models
  `-- GET/POST /v1beta/models/...
        |
        v
  Unified upstream providers
  |-- GitHub Copilot accounts
  |-- Custom providers
  `-- Azure OpenAI / Foundry OpenAI v1 and Foundry Anthropic deployments
```

Most request handling is platform-neutral Hono and Web APIs. Runtime-specific
wiring lives at the entrypoint and repository binding boundary: Cloudflare
Workers provide the fetch entrypoint and D1 binding, in-memory repositories are
used by tests, and `apps/api/src/runtime/` holds narrow environment/background
helpers for future compatible runtimes.

### Workspace Layout

The repo is a pnpm workspace with two libraries and two deployables:

```text
copilot-gateway/
├── wrangler.jsonc           # root; main -> apps/api/entry-cloudflare.ts,
│                            # assets -> apps/web/dist
├── packages/
│   ├── protocols/           # @copilot-gateway/protocols — pure protocol types
│   └── translate/           # @copilot-gateway/translate — cross-protocol
│                            # request/event translation pairs
└── apps/
    ├── api/                 # @copilot-gateway/api — Worker entry, control
    │                        # plane, data plane, repos, runtime helpers
    └── web/                 # @copilot-gateway/web — prerendered dashboard
                             # served by Workers Static Assets
```

Dependency direction is strict (`protocols` -> `translate` -> `api`;
`web` is a build-time-only producer of static HTML). Each package's
`package.json` `exports` map is the only public surface, enforced by an ESLint
`no-restricted-imports` ban on deep `@copilot-gateway/<pkg>/src/...` paths.
`apps/web/build.ts` is a throwaway prerender that will be replaced by a Vue +
Vite SPA bundler.

## License

MIT
