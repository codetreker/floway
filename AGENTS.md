# AGENTS.md

## Hard Rules

- Do not open a Pull Request without explicit human approval. The human must
  understand the goal and risk, read the AI-generated code and PR text, and
  believe code, docs, and tests are internally consistent.
- Do not create commits unless the human explicitly asks for a commit.
- Before claiming work is complete, run the relevant verification command and
  read the result.
- This file describes only the current system. Removed concepts must not
  appear anywhere in the repo — code, comments, tests, docs, this file
  included. Migrations are the only place an old name is allowed to survive.
  Do not write "do not reintroduce X" notes that name dead concepts; their
  absence from the working tree is the statement.
- Keep this file aligned with real architecture. When something changes,
  rewrite the relevant section; do not accrete contradictory notes.

## Project

`floway` is a Cloudflare Workers API proxy. It exposes Anthropic Messages,
OpenAI Responses, OpenAI Chat Completions, Embeddings, OpenAI Images, and
Google Gemini-compatible APIs over a unified upstream model. Provider kinds
are `copilot`, `custom`, and `azure`.

As a proxy, preserve upstream status, headers, and body as directly as
possible; surface internal failures with stack traces rather than masking
them. Code-level rules about error handling, comments, and style live in the
global agent instructions and in ESLint config — read those, not a copy
here.

Stack: Hono on Workers Web APIs, D1 for persistence (in-memory repos in
tests), TypeScript, pnpm, Vitest. The dashboard is a Vue + Vite SPA served
from the same Worker via Static Assets.

The production runtime contract is Workers-compatible (fetch entrypoint,
Workers bindings, D1). The narrow `apps/api/src/runtime/` layer exists to
keep future runtime targets possible if they can satisfy the same Web-API +
D1 semantics.

## Workspace Layout

```text
floway/
├── packages/
│   ├── protocols/   # @floway-dev/protocols — protocol type defs
│   ├── translate/   # @floway-dev/translate — cross-protocol translation pairs
│   └── ui/          # @floway-dev/ui — internal Vue component library
└── apps/
    ├── api/         # @floway-dev/api — Worker entry + control/data planes
    └── web/         # @floway-dev/web — Vue + Vite SPA dashboard
```

Dependency direction is strict: `protocols` depends on nothing; `translate`
depends only on `protocols`; `api` depends on `protocols` + `translate`;
`ui` depends only on `vue` + `reka-ui`; `web` depends on `ui` and
type-imports `@floway-dev/api/app-type` for Hono RPC client typing.

Each package's public surface is its `exports` map. Deep imports
(`@floway-dev/<pkg>/src/...`) are banned by ESLint; cross-package code must
use declared subpath exports. Tests are co-located as `*_test.ts`; each
package has its own `vitest.config.ts`, and the root config aggregates them
through `test.projects`.

Everything else — provider interfaces, request execution flow, interceptor
shapes, translation pair layout, control-plane route surface, flag
resolution, pricing — lives in the code and its comments. Read the relevant
directory.

## Verification

Run from the repo root:

```bash
pnpm run test                # vitest across all packages
pnpm run lint                # eslint across the workspace
pnpm run typecheck           # tsc --noEmit per package
pnpm run dev                 # parallel wrangler dev (8788) + Vite dev (5174)
pnpm run deploy              # builds apps/web, then wrangler deploy on apps/api
pnpm run db:migrate          # local D1
pnpm run db:migrate:remote   # production D1
```

`dev` runs the Worker on `http://127.0.0.1:8788` and the SPA on
`http://localhost:5174`. For frontend development open the Vite SPA (5174):
Vite proxies `/api`, `/auth`, `/v1`, `/v1beta`, `/embeddings`, and
`/models` to the Worker, so relative-URL fetches in `apps/web` work
identically in dev and prod. The Worker port serves the last built
`apps/web/dist` via Workers Static Assets; direct SPA routes (e.g.
`/login`, `/dashboard/...`) require
`assets.not_found_handling: "single-page-application"` plus the
backend-only `assets.run_worker_first` route list in the gitignored
`wrangler.jsonc` (see `wrangler.example.jsonc`). To work on a single
package, use pnpm filters (e.g.
`pnpm --filter @floway-dev/translate run typecheck`).

Wrangler commands go through the local dependency with `pnpm wrangler` or
package scripts. When deploying, do not pass `--dry-run`.

For manual data-plane validation, use `ADMIN_KEY` with the
`x-models-playground: 1` header on approved playground routes. Do not
reuse or create normal API keys for manual testing.

When investigating Copilot upstream quirks, compare at least one other
Copilot gateway implementation before inventing a policy. For generic
adapter behavior, compare at least one Copilot gateway and one general LLM
gateway. Do not cargo-cult from a single project.

## Deployment

A production deploy can disconnect the agent that triggers it, especially
when the deploy includes a D1 migration and the live schema briefly does
not match the code that the same agent is still running against. That
window is hard to avoid, so every production deploy must be a deliberate,
announced step.

Always tell the user before you deploy. If the user already asked for the
deploy up front, you do not have to re-ask for confirmation, but you still
explicitly announce that the deploy is starting. Beyond that single
announcement, the flow proceeds autonomously — no further confirmation
between steps.

Substitute `<WORKER_NAME>` (top-level `name`) and `<DB_NAME>` (the D1
binding's `database_name`) from `wrangler.jsonc` wherever those
placeholders appear below.

**Step 1 — gather current state.** Read `wrangler.jsonc` for `<WORKER_NAME>`
and `<DB_NAME>`, then chain:

```bash
pnpm wrangler deployments list \
  && pnpm wrangler d1 migrations list <DB_NAME> --remote
```

`deployments list` shows recent deployments with their version ids and
marks the currently active one — that gives both the active deployment
timestamp and the version id you would later roll back to.
`d1 migrations list --remote` prints applied migrations and the pending
diff this deploy would apply.

**Step 2 — report findings and stage the rollback.** Tell the user the
active version id, the active deployment timestamp, the latest applied
migration, and the migrations this deploy will apply (or that there are
none).

If migrations are pending, take an explicit D1 backup to a temp file
outside the repo so the working tree stays clean:

```bash
pnpm wrangler d1 export <DB_NAME> --remote \
  --output "${TMPDIR:-/tmp}/<DB_NAME>-$(date -u +%Y%m%dT%H%M%SZ).sql"
```

Report the resolved backup path, then give the user two rollback commands,
in this order:

- Restore the database from that dump, e.g. `pnpm wrangler d1 execute
  <DB_NAME> --remote --file <backup-path>` (drop the migrated tables first
  if the dump's `CREATE`s would collide), or `pnpm wrangler d1 time-travel
  restore <DB_NAME> --bookmark <bookmark>` if a pre-deploy bookmark was
  captured.
- Roll back the Worker code: `pnpm wrangler rollback <PREVIOUS_VERSION_ID>`.

If no migrations are pending, skip the backup and the database-rollback
command; give only the code-rollback command and proceed straight to
Step 3.

**Step 3 — deploy with one chained command.** Migrate (when needed) and
publish in the same command so the system spends as little time as
possible in an inconsistent state:

```bash
pnpm run db:migrate:remote && pnpm run deploy
```

Print this exact command before running it, and tell the user that if the
deploy stops halfway they can rerun the same command to recover —
`wrangler d1 migrations apply --remote` is idempotent on already-applied
migrations and `wrangler deploy` always publishes the current code. When
there are no pending migrations, the command reduces to `pnpm run deploy`.

Worker rollback by version id (`pnpm wrangler rollback <VERSION_ID>`)
works across the 100 most recent versions, but Cloudflare blocks rollback
when intervening deployments changed Durable Object migrations or removed
referenced KV/R2/Queue bindings. This Worker only binds D1, so plain code
rollback is currently safe; D1 state is rolled back separately as above.

A complete deploy fits in a strict turn budget: **three agent turns when
migrations are pending** (Step 1 = gather, Step 2 = backup + report + two
rollback commands, Step 3 = deploy) and **two agent turns when no
migrations are pending** (Step 2 collapses into Turn 1: gather + report +
single code-rollback command; Turn 2 = deploy). Do not insert extra turns
to ask for confirmation along the way.
