# Built from the repo root by compose.yaml (or: docker build -f apps/worker/Dockerfile .).
FROM node:26-alpine AS base
# Self-hosted Watchdog sends no telemetry (ADR 0013), and neither do its builds.
ENV TURBO_TELEMETRY_DISABLED=1
WORKDIR /repo
# Node 26 ships without corepack, so install the pnpm that package.json pins.
COPY package.json ./
RUN npm install --global "pnpm@$(node -p 'require("./package.json").packageManager.split("@")[1]')"

# Only the worker and the workspace packages it uses, with package.json files apart so that
# installing is cached until a dependency changes.
FROM base AS prune
COPY . .
# The turbo version pnpm-lock.yaml resolves for the root, so builds don't drift.
RUN pnpm dlx turbo@2.11.10 prune @watchdog/worker --docker

FROM base AS install
COPY --from=prune /repo/out/json/ ./
# --ignore-scripts skips the root prepare script, which installs git hooks (husky) and would print
# its output even with HUSKY=0. pnpm runs no dependency build scripts unless the workspace allows
# them, and this one allows none, so nothing else is skipped.
# prune keeps eslint-config, a dev-only workspace package, and --prod would still install its own
# dependencies (ESLint, TypeScript), so the filter leaves it out.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts \
      --filter "@watchdog/worker..." --filter "!@watchdog/eslint-config"
COPY --from=prune /repo/out/full/ ./

# The worker and the packages run as TypeScript, with no build step (ADR 0017).
FROM node:26-alpine
ENV NODE_ENV=production
COPY --from=install /repo /app
WORKDIR /app/apps/worker
USER node
CMD ["node", "src/index.ts"]
