# Watchdog

A pnpm + Turborepo monorepo (ADR 0011).

| Path | What it is |
| --- | --- |
| `apps/web` | Next.js app: UI, settings, webhook inbox |
| `apps/worker` | Triggers and pipeline stages |
| `packages/core` | The pipeline, the rule model and the Agent interface (`@watchdog/core`) |
| `packages/db` | The database layer (`@watchdog/db`) |
| `docs/` | The Knowledge platform docs, as a git submodule (see `AGENTS.md`) |

## Getting started

You need the Node version in `.nvmrc` (`nvm use`) and pnpm, at the version pinned in `package.json` (`corepack enable` picks it up).

```bash
pnpm install
pnpm --filter web dev      # http://localhost:3000
pnpm --filter worker start
```

## Workspace scripts

Run from the root. Turborepo runs each one across every package that defines it.

| Script | Does |
| --- | --- |
| `pnpm dev` | Runs every `dev` script |
| `pnpm build` | Builds the workspace |
| `pnpm typecheck` | Typechecks the workspace |
| `pnpm lint` | Lints the workspace |
| `pnpm test` | Runs the tests |

The packages share `tsconfig.base.json`. `apps/worker`, `packages/core` and `packages/db` are ES modules that Node runs as TypeScript directly, without a build step. Mark type-only imports with `import type`, and give relative imports their `.ts` extension.
