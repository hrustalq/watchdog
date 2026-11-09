# Handoff: make the `ship-feature` skill safe for concurrent sessions

Written 2026-11-02. The skill is at `.claude/skills/ship-feature/SKILL.md`. It isn't committed yet, and its `evals/evals.json` is untracked too. Goal: let 2–3 Claude sessions each ship a different issue at the same time, without breaking each other and without losing speed.

## What the skill does now (settled with the user)

- **Scope:** one issue, one branch, one PR, one squash commit on `main`. The skill **merges by itself**, so it is user-invoked only (`disable-model-invocation: true`, run as `/ship-feature <N|next>`).
- **Gates, in order:**
  1. ponytail-review
  2. impeccable `critique` and `audit`, only when the change touches UI
  3. code-review
  4. local checks: `pnpm lint/typecheck/test`
  5. running the app

  Tests come first: the work follows `mattpocock-skills:tdd`, and acceptance criteria that can't be unit-tested become an acceptance script kept outside the repo, which must fail before the change and pass after.

- **Before CI exists** (until #2 ships), the full local check suite stands in for CI, and the PR has to say so. After that, green CI is required (the user's decision).
- **Merging:** `gh pr merge --squash --delete-branch --subject … --body …`. The explicit body stops GitHub pasting every branch commit into `main`'s message. Commits have no trailers.
- **After the merge:** confirm the issue closed and watch the run on `main`.
- **Docs:** changes go in a Knowledge MR from `docs/`. The code PR never points the submodule at an unmerged docs branch.

## Eval round 1 (dry run, no pushes)

| Case              | With skill                   | Without skill               |
| ----------------- | ---------------------------- | --------------------------- |
| Ship #1 (full)    | 12/12, ~25 min, ~200k tokens | 6/12, ~14 min               |
| #5 blocked        | 4/4                          | 4/4 (doesn't separate them) |
| `next`, plan only | 7/7                          | 6/7                         |

The skill's value is the workflow, not the code: code-review caught a real Turborepo cache bug the baseline would have shipped. The user never gave feedback in the review page. The workspace was in the old session's scratchpad and is probably gone. The cases in `evals/evals.json` go stale as M0 issues merge (#5 stops being blocked, and `next` stops picking #1), so rewrite them without fixed issue numbers before round 2.

## The concurrency gaps to fix (all found in round 1)

| Gap                                                                                                                                                                               | Fix to write into SKILL.md                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Step 0 runs `git switch main` and needs a clean tree. Two sessions in one checkout clobber each other, and in a worktree the switch fails because `main` is checked out elsewhere | Always work in a worktree (`EnterWorktree` / `claude --worktree`): `git fetch origin && git switch -c feat/<N>-<slug> origin/main`. Never switch to `main`                                                                        |
| Claiming means assigning to `@me`, but every session is the same account, so two `next` runs both take the same issue                                                             | Lock the issue by pushing `feat/<N>-*` (or opening a draft PR) right after picking it. `next` skips issues that have a remote `feat/<N>-*` branch or an open PR. Check right before pushing, since that is where the race happens |
| `docs/` isn't checked out in new worktrees                                                                                                                                        | When the worktree is set up, initialise the submodule with the credential helper from `AGENTS.md` (`git submodule update --init docs`)                                                                                            |
| Running the app uses port 3000, and Compose publishes 3000                                                                                                                        | Each session gets its own `PORT`, plus `COMPOSE_PROJECT_NAME=wd-<N>` and a different published web port                                                                                                                           |
| Shared files conflict across branches: `pnpm-lock.yaml`, `turbo.json`, `.env.example`, and worst of all Drizzle's `packages/db/migrations/meta/_journal.json`                     | On a conflict, regenerate instead of merging text: re-run `pnpm install` for the lockfile, and for migrations delete the branch's own migration, take `main`'s and run `db:generate` again. Run the checks again afterwards       |
| The rtk git hook made the worktree guard reject `git` (agents fell back to `/usr/bin/git`)                                                                                        | Fix the hook or the guard, or make the skill call `/usr/bin/git` in worktrees. Check which one is to blame first                                                                                                                  |
| Turborepo 2.x shares its cache across worktrees into the main checkout's `.turbo/`                                                                                                | That's good for speed. Make sure `.turbo` is gitignored, which #1 does                                                                                                                                                            |

## How much parallelism is possible

The M0 dependency chain is `#1 → {#2, #3} → #4 → {#5, #8} → {#6, #7, #9}`, so at most 2–3 issues run at once and the chain has 5 steps instead of 9. Docs MRs wait on human review, and #6 needs a real OAuth sign-in checked by hand. On a Mac, 2–3 sessions is the practical limit, since each one runs pnpm, `next build` and Docker.

## Also pending

- Issue #1 is missing three findings that both eval runs hit. Add them to the issue with `gh issue edit`, merging into the body, not overwriting it:
  - `next-env.d.ts` isn't tracked by git, so the issue's `git mv` line fails on it.
  - The web `typecheck` must be `next typegen && tsc --noEmit`.
  - `next dev` writes a second `AGENTS.md` into `apps/web`. The with-skill run fixed it with `agentRules: false`.
- Decide whether to commit `.claude/skills/ship-feature/` (with or without `evals/`) and `.claude/handoffs/`.

## How to do it

Run `/skill-creator:skill-creator`. Snapshot the current skill as the baseline, apply the fixes above, then run a round-2 dry run in worktrees with two sessions at once on independent issues (for example #2 and #3, once #1 has merged), and check that they don't collide.
