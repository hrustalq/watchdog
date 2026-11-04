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

`compose.yaml` runs the five containers of a standard install: Caddy, web, worker, Postgres and Obscura. You need Docker with Compose v2.

```bash
cp .env.example .env       # then set a real BETTER_AUTH_SECRET and OBSCURA_CDP_TOKEN
docker compose up -d --build --wait
docker compose logs web    # the setup link on first run, and magic links when SMTP isn't set
```

Then open http://localhost:3000. The containers start in this order:

1. **Postgres** keeps its data in the `postgres` volume, so `docker compose down` and `up` keep every user and Workspace. `docker compose down -v` deletes the volume.
2. **Worker** applies the pending migrations, starts pg-boss and only then reports healthy. A restart applies nothing twice. On SIGTERM it stops pg-boss and logs `pg-boss stopped cleanly`.
3. **Web** starts once the worker is healthy, so it never serves requests against an unmigrated database.
4. **Caddy** starts once web is healthy and is the only container that publishes a port (3000). It passes every request to web and sets `X-Forwarded-For` to the connection's address, whatever the client sent, because Better Auth's sign-in rate limit is keyed on that header (ADR 0020).

**Obscura** starts beside them. Web, Postgres and Obscura's CDP port are reachable only on the Compose network. Compose sets `DATABASE_URL` and `OBSCURA_CDP_URL` to its own containers, and the rest of `.env` is passed to web and worker as is.

The packages share `tsconfig.base.json`. `apps/worker`, `packages/core` and `packages/db` are ES modules that Node runs as TypeScript directly, without a build step. Mark type-only imports with `import type`, and give relative imports their `.ts` extension.

## Changing the database schema

Edit the Drizzle schema in `packages/db/src/schema/`, then run `pnpm --filter @watchdog/db db:generate` to write a migration into `packages/db/migrations/` and commit both. The worker applies pending migrations at boot, and `pnpm --filter @watchdog/db db:migrate` applies them by hand.

Never use `drizzle-kit push`. drizzle-kit 0.31 misreads the column order of a multi-column unique key, so push drops and re-creates `source_workspace_id_id_key` and `item_source_id_external_id_key` even when nothing changed. Postgres refuses one of the drops, drizzle-kit still exits 0, and the statements before it stay applied, which can leave Items without their dedup key. See the Knowledge gotcha [drizzle-kit push mangles composite unique keys, so the public schema changes through migrations only](https://knowledge.hrustalq.dev/documents/3fd6c345-3360-493e-815f-2dd44bc0ecf9).

## Running checks locally

```bash
pnpm lint                # ESLint, warnings fail too
pnpm typecheck
pnpm test                # unit and integration tests; integration tests need Docker
pnpm turbo run test:unit # unit tests only, no Docker
```

Tests are Vitest. A file named `*.int.test.ts` is an integration test: it may start Postgres with `startPostgres()` from `@watchdog/db/testing` (testcontainers). Every other `*.test.ts` is a unit test and must run without Docker or network access.

`pnpm smoke` runs the Playwright smoke test: on a fresh Compose stack it claims the install with the setup link, signs in with the magic link and checks the empty Workspace, reading both links from the web container's log. It adds an RSS Source and waits, up to two minutes, for the worker to poll it and the Feed to show the recent entries as the Backfill, then opens an Item and checks its Log. The feed is a recorded fixture in `apps/e2e/fixtures/`, served by a `fixtures` container that `apps/e2e/compose.smoke.yaml` adds, and that file also makes the stack's network internal, so no request in the run leaves it. Then it checks that six sign-in requests, each with a different `X-Forwarded-For`, still hit the rate limit, so signing in by hand on that stack waits a minute afterwards. It needs Docker, port 3000 free, a `.env` with the SMTP variables empty, and Chromium, installed once with `pnpm --filter @watchdog/e2e exec playwright install chromium`. The stack runs as the Compose project `watchdog-smoke`, apart from the one `docker compose up` starts, so its volume is wiped without touching yours. A passing run removes the stack. A failing one leaves it up and keeps the trace in `apps/e2e/test-results/` and the container logs in `apps/e2e/compose.log`. CI runs it on every push to `main`, not on pull requests.

`pnpm install` installs two git hooks (husky):

- **pre-push** first checks the message of every commit the push sends that no remote has yet, and names the commit and the rule that failed. Then it runs `lint`, `typecheck` and `test:unit` through Turborepo. It rejects the push if any of them fails, before anything is sent. Unchanged packages hit the cache. It doesn't need Docker, because integration tests run in CI.
- **commit-msg** checks the message with commitlint.

A new git worktree gets the hooks after its own `pnpm install`. `HUSKY=0` skips installing them, as CI does.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope)!: subject`, e.g. `fix(db): close the pool on shutdown`. Scopes are `web`, `worker`, `core`, `db`, `docs`, `deps`, `ci` and `release`, and the scope is optional. PRs are squash-merged as `<PR title> (#N)`, and the `ship-feature` skill checks that squash message with commitlint before it merges. CI doesn't check commit messages, so a PR merged any other way goes unchecked.

## Releases

Watchdog has one product version, following [SemVer](https://semver.org/). It lives in the root `package.json` and `.release-please-manifest.json`. The packages under `apps/` and `packages/` are private and have no version of their own.

[release-please](https://github.com/googleapis/release-please) cuts releases from the commit history (`.github/workflows/release.yml`, configured in `release-please-config.json`). On every push to `main` it updates one open release PR, `chore(release): release X.Y.Z`, which bumps the version and adds the next section to [`CHANGELOG.md`](CHANGELOG.md). The subjects of the commits on `main`, one per squash-merged PR, decide the bump:

- `fix`, `perf` and `revert` are patch releases, listed under "Bug Fixes", "Performance" and "Reverts". `feat` is a minor release, under "Features".
- A breaking change (`feat!:` or a `BREAKING CHANGE:` footer) is listed under "⚠ BREAKING CHANGES". While the version is `0.x` it bumps the minor version, so **any `0.x` minor release may break your install**: read its breaking changes before upgrading. From `1.0.0` on, a breaking change is a major release.
- Every other type (`docs`, `test`, `ci`, `chore`, `style`, `refactor`, `build`) stays out of the changelog, and a push with only those opens no release.

A person merges the release PR. That run tags the commit `vX.Y.Z` and publishes a [GitHub Release](https://github.com/hrustalq/watchdog/releases) with the same notes as its `CHANGELOG.md` section.

The workflow acts with the `RELEASE_PLEASE_TOKEN` repo secret: a fine-grained personal access token (or GitHub App token) for this repo with Contents, Issues and Pull requests read and write. release-please labels its PR through the Issues API. The default `GITHUB_TOKEN` won't do, because a PR it opens triggers no workflows, so CI wouldn't run on the release PR. Without the secret the Release workflow fails.
