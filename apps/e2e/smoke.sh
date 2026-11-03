#!/bin/sh
# `pnpm smoke`: the Playwright smoke test against a fresh Compose stack (compose.yaml and .env at
# the repo root). Its own project name keeps it apart from the stack `docker compose up` runs, so
# wiping it never touches that stack's data. It needs port 3000 free.
export COMPOSE_PROJECT_NAME=watchdog-smoke

docker compose down --volumes || exit
rm -f compose.log
if docker compose up --detach --build --wait && playwright test; then
  docker compose down --volumes
else
  status=$?
  # CI keeps this file with the trace. The stack stays up to look at.
  docker compose logs > compose.log
  echo "Smoke test failed. The $COMPOSE_PROJECT_NAME stack is still up, and its logs are in apps/e2e/compose.log." >&2
  exit "$status"
fi
