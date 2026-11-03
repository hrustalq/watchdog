# Built from the repo root by compose.yaml (or: docker build -f apps/web/Dockerfile .).
FROM node:26-alpine AS base
# Self-hosted Watchdog sends no telemetry (ADR 0013), and neither do its builds.
ENV NEXT_TELEMETRY_DISABLED=1 TURBO_TELEMETRY_DISABLED=1
WORKDIR /repo
# Node 26 ships without corepack, so install the pnpm that package.json pins.
COPY package.json ./
RUN npm install --global "pnpm@$(node -p 'require("./package.json").packageManager.split("@")[1]')"

# Only web and the workspace packages it uses, with package.json files apart so that installing
# is cached until a dependency changes.
FROM base AS prune
COPY . .
RUN pnpm dlx turbo@^2.11.10 prune @watchdog/web --docker

FROM base AS build
COPY --from=prune /repo/out/json/ ./
# --ignore-scripts skips the root prepare script, which installs git hooks (husky) and would print
# its output even with HUSKY=0. pnpm runs no dependency build scripts unless the workspace allows
# them, and this one allows none, so nothing else is skipped. The filter installs only what web
# and its packages need, without the root's git-hook and commit tooling or the lint config.
RUN pnpm install --frozen-lockfile --ignore-scripts \
      --filter "@watchdog/web..." --filter "!@watchdog/eslint-config"
COPY --from=prune /repo/out/full/ ./
# prune copies workspace packages only, and every tsconfig.json extends this one.
COPY tsconfig.base.json ./
RUN pnpm --filter @watchdog/web build

FROM node:26-alpine
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
