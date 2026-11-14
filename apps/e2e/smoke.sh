#!/bin/sh
# `pnpm smoke`: the Playwright smoke test against a fresh Compose stack (compose.yaml and .env at
# the repo root). Its own project name keeps it apart from the stack `docker compose up` runs, so
# wiping it never touches that stack's data. It needs port 3000 free. compose.smoke.yaml goes on
# top of compose.yaml, or of the files in an absolute COMPOSE_FILE you set, e.g. to move the port.
#
# One run at a time. Two runs share the compose project, port 3000 and test-results, and the second
# one's `down --volumes` plus Playwright's "clear output" would break the first mid-test, so a run
# that finds the lock held refuses instead of joining it.
cd "$(dirname "$0")" || exit
lock="${TMPDIR:-/tmp}/watchdog-smoke.lock"
if ! mkdir "$lock" 2>/dev/null; then
  holder=$(cat "$lock/pid" 2>/dev/null)
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    echo "Another smoke run (pid $holder) is using the stack and test-results. Wait for it or stop it." >&2
    exit 1
  fi
  rm -rf "$lock"
  mkdir "$lock" || exit 1
fi
echo $$ > "$lock/pid"
trap 'rm -rf "$lock"' EXIT
trap 'exit 1' INT TERM

export COMPOSE_PROJECT_NAME=watchdog-smoke
# The Chromium fallback renderer is on a profile, which `up` skips by default, so the run turns it on:
# one website Source in the test reads its page with it.
export COMPOSE_PROFILES=chromium
export COMPOSE_FILE="${COMPOSE_FILE:-$(cd ../.. && pwd)/compose.yaml}:$PWD/compose.smoke.yaml"

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
