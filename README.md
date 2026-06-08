# Floway

Floway is an LLM API gateway that fronts multiple model upstreams behind one
set of standard APIs. Point a coding agent at Floway and it can use a
GitHub Copilot account, a ChatGPT subscription via Codex CLI, a custom
OpenAI- or Anthropic-compatible provider, or an Azure deployment through
whichever API shape the agent already speaks.
Cloudflare Workers is the production deployment target; a Node.js deployment
target ships in the same repo for self-hosting on a long-lived process.

## Client APIs

| Source API                              | Path                          |
| --------------------------------------- | ----------------------------- |
| Anthropic Messages                      | `POST /v1/messages`, `POST /v1/messages/count_tokens` |
| OpenAI Responses                        | `POST /v1/responses`, `POST /v1/responses/compact`, `GET /v1/responses` WebSocket |
| OpenAI Chat Completions                 | `POST /v1/chat/completions`   |
| OpenAI Embeddings                       | `POST /v1/embeddings`         |
| OpenAI Images                           | `POST /v1/images/generations` |
| OpenAI Image Edits                      | `POST /v1/images/edits`       |
| OpenAI Models                           | `GET  /v1/models`             |
| Google Gemini (generate / count tokens) | `POST /v1beta/models/...`     |

For each public model, Floway picks the first provider binding that can serve
the request, translating between source and target protocols when the upstream
speaks a different shape.

## Quick Start

Prereqs: Node.js 22.5+ (for `node:sqlite` if you want the Node target),
pnpm 10.x, and at least one upstream credential — Copilot subscription,
ChatGPT Plus / Pro / Team subscription (via Codex CLI auth), an
OpenAI-compatible bearer token, or Azure endpoint plus API key.

### Cloudflare Workers (production)

A Cloudflare account is required.

```bash
pnpm install

# Local Worker config (gitignored). Fill in account_id, database_id, name.
cp wrangler.example.jsonc wrangler.jsonc
pnpm wrangler login
pnpm wrangler d1 create <DB_NAME>

# Apply schema and set the admin secret.
pnpm run db:migrate
pnpm wrangler secret put ADMIN_KEY

# Run locally or deploy. In dev, open the Vite SPA at http://localhost:5174.
pnpm run dev
pnpm run deploy
```

### Node.js (self-hosted)

```bash
pnpm install

# All config is environment variables; sqlite + filesystem dirs are created
# on first boot, migrations apply automatically.
ADMIN_KEY=<admin-secret> \
FLOWAY_DB_PATH=./data/floway.db \
FLOWAY_FILES_DIR=./data/files \
PORT=8788 \
pnpm run dev:node
```

The Node target serves no SPA — point the dashboard at the same admin host
through your own static-file server, or use the Cloudflare deploy for the
dashboard while running data-plane traffic on Node.

### After the first boot

Open the deployed URL (or `http://localhost:8788` for Node), log in with
`ADMIN_KEY`, and:

1. **Settings -> Upstreams -> Add Upstream**. Upstreams are *Custom*
   (OpenAI/Anthropic-shaped, static credential), *Azure* (one endpoint, API key,
   deployment list), *Copilot* (GitHub device OAuth), or *Codex* (ChatGPT
   subscription via the Codex CLI's OAuth client; paste `~/.codex/auth.json`
   or run the OAuth flow from the dashboard). List order is routing order;
   earlier providers win for a shared public model id.
2. **API Keys -> New Key**. Give the generated key to your client.
3. Copy the Claude Code or Codex CLI snippet from the API Keys panel into the
   agent config.

Import/export of upstreams, keys, and search config is in Settings; it uses the
latest `version: 3` payload shape.

## Server Tools

`/v1/messages` accepts Anthropic-style web search. When the resolved upstream
can run the native server tool, Floway passes it through; otherwise it shims the
search via **Settings -> Web Search** (`tavily` or `microsoft-grounding`,
default `disabled`).

`/v1/responses` has a shared server-tool shim layer for hosted Responses
tools. `web_search` is rewritten into a model-visible function call,
executed through the same web-search provider (**Settings -> Web
Search**), and emitted back as Responses `web_search_call` items, with
the shim driving the internal multi-turn loop and replaying prior
`web_search_call` items across turns.

## Stateful Responses

`/v1/responses` stores replayable Responses input and output items for API-key
scoped HTTP requests. Clients can send `previous_response_id` to continue from
a stored snapshot, or resend full input history; repeated full-history input is
deduplicated by content hash instead of stored again. HTTP `store: false` does
not create durable snapshots or input payload rows, but it keeps output item
metadata for routing; if a later `store: true` request echoes that item with a
full payload, the metadata row is filled in place.

The same endpoint accepts `GET` WebSocket upgrades for streaming Responses
events. WebSocket `store: false` keeps replay state only inside the open
session, so same-socket `previous_response_id` works without writing those
items or snapshots to durable storage.

## Development

```bash
pnpm run lint          # eslint --cache across the workspace
pnpm run test          # vitest run over the root test.projects
pnpm run typecheck     # pnpm -r run typecheck
pnpm run dev           # parallel wrangler dev (8788) + Vite SPA dev server (5174)
pnpm run dev:node      # Node.js entry (tsx apps/platform-node/entry.ts)
```

The repo is a pnpm workspace.

- `packages/protocols` and `packages/translate` are pure libraries for
  protocol type defs and cross-protocol translation.
- `packages/interceptor` is the generic interceptor framework.
- `packages/provider` plus per-vendor `packages/provider-{azure,codex,copilot,custom}`
  hold the upstream-side adapters.
- `packages/platform` exposes the runtime contracts (`FileProvider`,
  `ImageProcessor`, `SqlDatabase`, etc.) and a few portable helpers.
- `packages/gateway` is the runtime-agnostic gateway core: Hono app, all
  control- and data-plane routes, the Repo interface and impls, middleware,
  and the migrations SQL.
- `apps/platform-cloudflare` ships the Cloudflare implementations
  (R2, Images + KV, D1) and the Worker entry; `apps/platform-node` ships
  the Node implementations (sharp, node:sqlite, fs) and the
  `@hono/node-server` entry. Each platform-target app is the only place
  its runtime's symbols appear; ESLint forbids importing them from
  anywhere else in the workspace.
- `apps/web` is the Vue/Vite SPA dashboard, served by Vite in dev and by
  Workers Static Assets from `apps/web/dist` after build (Cloudflare
  deployment only).

`wrangler.example.jsonc` keeps API/data-plane routes Worker-first and lets
other direct browser routes fall through to the SPA's `index.html`. It also
includes an hourly cron trigger used by the Worker to age out retained Responses
snapshots, payloads, and metadata. The Node entry runs the same maintenance
sweep on a wall-clock interval. Cross-package imports go through each package's
`exports` map; deep imports are blocked by ESLint.

See [AGENTS.md](./AGENTS.md) for architecture, provider routing, deployment,
and development conventions.

## License

MIT
