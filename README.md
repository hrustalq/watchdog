# Watchdog

A pnpm + Turborepo monorepo (ADR 0011).

| Path | What it is |
| --- | --- |
| `apps/web` | Next.js app: UI, settings, webhook inbox |
| `apps/worker` | Triggers and pipeline stages |
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

The packages share `tsconfig.base.json`. `apps/worker`, `packages/core` and `packages/db` are ES modules that Node runs as TypeScript directly, without a build step. Mark type-only imports with `import type`, and give relative imports their `.ts` extension.

## Running checks locally

```bash
pnpm lint                # ESLint, warnings fail too
pnpm typecheck
pnpm test                # unit and integration tests; integration tests need Docker
pnpm turbo run test:unit # unit tests only, no Docker
```

Tests are Vitest. A file named `*.int.test.ts` is an integration test: it may start Postgres with `startPostgres()` from `@watchdog/db/testing` (testcontainers). Every other `*.test.ts` is a unit test and must run without Docker or network access.

`pnpm install` installs two git hooks (husky):

- **pre-push** runs `lint`, `typecheck` and `test:unit` through Turborepo and rejects the push if any of them fails. Unchanged packages hit the cache. It doesn't need Docker, because integration tests run in CI.
- **commit-msg** checks the message with commitlint.

A new git worktree gets the hooks after its own `pnpm install`. `HUSKY=0` skips installing them, as CI does.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope)!: subject`, e.g. `fix(db): close the pool on shutdown`. Scopes are `web`, `worker`, `core`, `db`, `docs`, `deps`, `ci` and `release`, and the scope is optional. PRs are squash-merged, so CI checks the PR title the same way.
