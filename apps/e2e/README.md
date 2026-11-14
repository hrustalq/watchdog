# Smoke test

One Playwright spec that signs in to a real Compose stack and walks the product end to end:
claiming the install, a Source's first poll, Rules, a Correction, an alert through the worker, and
the 404/200 answers. It runs on pushes to `main` (`.github/workflows/ci.yml`), not on pull requests.

```bash
cp .env.example .env    # at the repo root; no SMTP, so links go to the web container's log
pnpm smoke              # builds and starts the stack, then runs the spec
```

`smoke.sh` owns the `watchdog-smoke` Compose project and port 3000, so one run at a time: a second
`pnpm smoke` refuses while the lock in `${TMPDIR:-/tmp}/watchdog-smoke.lock` is held. A failed run
leaves the stack up, writes its logs to `compose.log`, and keeps the stack's data for the next look;
`docker compose -p watchdog-smoke down --volumes` wipes it.

## Traces

A trace is recorded for CI only. Every `playwright test` invocation starts by removing
`test-results/`, and that is where the browser writes its live trace
(`test-results/.playwright-artifacts-<n>/traces`), so a run started beside another — an iteration
run from the same project, or a second `pnpm smoke` before this lock existed — deletes the first
run's trace directory mid-test. The flush then throws `ENOENT` from `browserContext.close`, which
replaces the test's own assertion in the report and hides what actually failed.

So a local run records no trace and reports the assertion. To record one for a run that is alone:

```bash
SMOKE_TRACE=on pnpm --filter @watchdog/e2e exec playwright test --grep "the Sources screen"
```

CI keeps `retain-on-failure` (`apps/e2e/playwright.config.ts`) and uploads `test-results/` with the
run, along with `playwright-report/` and `compose.log`.
