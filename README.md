# Copilot Gateway

Copilot Gateway is a Cloudflare Workers API proxy that exposes GitHub Copilot
accounts and optional OpenAI-compatible upstreams through standard LLM APIs:
Anthropic Messages, OpenAI Responses, OpenAI Chat Completions, Embeddings, and
Google Gemini-compatible model routes.

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

- A GitHub account with an active [Copilot](https://github.com/features/copilot)
  subscription
- Node.js 20.3 or newer
- pnpm 10.x

### Deploy to Cloudflare Workers

```bash
# Clone and enter the project
git clone https://github.com/user/copilot-gateway.git
cd copilot-gateway

# Install dependencies
pnpm install

# Create the D1 database
pnpm wrangler d1 create copilot-db

# Update wrangler.jsonc with your account_id and database_id, then apply migrations
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
`src/runtime/` compatibility layer in place for future runtimes that can provide
the same environment, background scheduling, and repository binding semantics.

### Initial Setup

1. Open the deployed URL in a browser and log in with your `ADMIN_KEY`.
2. Go to the **Upstream** tab and connect the GitHub account with the Copilot
   subscription through the device OAuth flow.
3. Go to the **API Keys** tab and create an API key for clients.
4. Copy the generated Claude Code or Codex CLI configuration snippets.

## Optional Native Messages Web Search

Anthropic-native-looking web search is accepted on `/v1/messages` and
`/messages`. Native Messages upstreams receive native web-search tools directly
unless the selected provider opts into gateway execution. When the selected
target cannot execute Anthropic server tools, the post-plan Messages protocol
interceptor runs the gateway shim, which requires an enabled search provider.

Configure it in the dashboard under **Upstream -> Search**.

Provider choices:

- `disabled`
- `tavily`
- `microsoft-grounding`

The gateway stores this search config in control-plane data and includes it in
export/import.

## Development

```bash
pnpm install
pnpm run test
pnpm run typecheck
pnpm run dev
```

Wrangler commands should be run through the local dependency with `pnpm wrangler`
or through package scripts. Test coverage uses Vitest.

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
  GitHub Copilot API or configured OpenAI-compatible upstreams
```

Most request handling is platform-neutral Hono and Web APIs. Runtime-specific
wiring lives at the entrypoint and repository binding boundary: Cloudflare
Workers provide the fetch entrypoint and D1 binding, in-memory repositories are
used by tests, and `src/runtime/` holds narrow environment/background helpers for
future compatible runtimes.

## License

MIT
