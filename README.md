# Watchdog

A pnpm + Turborepo monorepo (ADR 0011).

| Path | What it is |
| --- | --- |
| `apps/web` | Next.js app: UI, settings, webhook inbox |
| `apps/worker` | Triggers and pipeline stages |
| `apps/e2e` | The Playwright smoke test (`pnpm smoke`) |
| `packages/core` | The pipeline, the rule model and the Agent interface (`@watchdog/core`) |
| `packages/db` | The database layer (`@watchdog/db`) |
| `packages/eslint-config` | The shared lint rules each package's `eslint.config.mjs` builds on |
| `docs/` | The Knowledge platform docs, as a git submodule (see `AGENTS.md`) |

## Getting started

You need the Node version in `.nvmrc` (`nvm use`) and pnpm, at the version pinned in `package.json` (`corepack enable` picks it up).

```bash
pnpm install
cp .env.example .env       # then set a real BETTER_AUTH_SECRET
pnpm --filter web dev      # http://localhost:3000
pnpm --filter worker start
```

Web and worker read their settings from the environment, and from the root `.env` when it exists. They refuse to start when a variable is invalid and name it. `.env.example` lists every variable, and the Configuration page in `docs/` explains them.

`pnpm dev|build|typecheck|lint|test` at the root runs that script in every package that has it, through Turborepo.

## Run locally with Docker Compose

`compose.yaml` runs the four containers of a standard install: web, worker, Postgres and Obscura. You need Docker with Compose v2.

```bash
cp .env.example .env       # then set a real BETTER_AUTH_SECRET and OBSCURA_CDP_TOKEN
docker compose up -d --build --wait
docker compose logs web    # the setup link on first run, and magic links when SMTP isn't set
```

Then open http://localhost:3000. The containers start in this order:

1. **Postgres** keeps its data in the `postgres` volume, so `docker compose down` and `up` keep every user and Workspace. `docker compose down -v` deletes the volume.
2. **Worker** applies the pending migrations, starts pg-boss and only then reports healthy. A restart applies nothing twice. On SIGTERM it stops pg-boss and logs `pg-boss stopped cleanly`.
3. **Web** starts once the worker is healthy, so it never serves requests against an unmigrated database.

**Obscura** starts beside them. Only web publishes a port (3000). Postgres and Obscura's CDP port are reachable only on the Compose network. Compose sets `DATABASE_URL` and `OBSCURA_CDP_URL` to its own containers, and the rest of `.env` is passed to web and worker as is.

The packages share `tsconfig.base.json`. `apps/worker`, `packages/core` and `packages/db` are ES modules that Node runs as TypeScript directly, without a build step. Mark type-only imports with `import type`, and give relative imports their `.ts` extension.

## Running checks locally

```bash
pnpm lint                # ESLint, warnings fail too
pnpm typecheck
pnpm test                # unit and integration tests; integration tests need Docker
pnpm turbo run test:unit # unit tests only, no Docker
```

Tests are Vitest. A file named `*.int.test.ts` is an integration test: it may start Postgres with `startPostgres()` from `@watchdog/db/testing` (testcontainers). Every other `*.test.ts` is a unit test and must run without Docker or network access.

`pnpm smoke` runs the Playwright smoke test: on a fresh Compose stack it claims the install with the setup link, signs in with the magic link and checks the empty Workspace, reading both links from the web container's log. It needs Docker, port 3000 free, a `.env` with the SMTP variables empty, and Chromium, installed once with `pnpm --filter @watchdog/e2e exec playwright install chromium`. The stack runs as the Compose project `watchdog-smoke`, apart from the one `docker compose up` starts, so its volume is wiped without touching yours. A passing run removes the stack. A failing one leaves it up and keeps the trace in `apps/e2e/test-results/` and the container logs in `apps/e2e/compose.log`. CI runs it on every push to `main`, not on pull requests.

`pnpm install` installs two git hooks (husky):

- **pre-push** runs `lint`, `typecheck` and `test:unit` through Turborepo and rejects the push if any of them fails. Unchanged packages hit the cache. It doesn't need Docker, because integration tests run in CI.
- **commit-msg** checks the message with commitlint.

A new git worktree gets the hooks after its own `pnpm install`. `HUSKY=0` skips installing them, as CI does.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope)!: subject`, e.g. `fix(db): close the pool on shutdown`. Scopes are `web`, `worker`, `core`, `db`, `docs`, `deps`, `ci` and `release`, and the scope is optional. PRs are squash-merged, so CI checks the PR title the same way.
