---
name: ship-feature
description: Ship one Watchdog GitHub issue end to end with the project's workflow. It picks the issue and checks its prerequisites, reads the Knowledge docs the issue cites, branches, implements test-first, and runs the quality gates (ponytail-review, impeccable for UI, code-review, running the app). Then it opens a PR that closes the issue, waits for green CI, squash-merges, and captures what was learned. Use when the user says "ship #N", "ship feature", "ship the next issue", "implement issue N", "take the next M0 task", "сделай issue N", or otherwise asks to build and land a tracked Watchdog issue.
argument-hint: "[issue number | next]"
disable-model-invocation: true
---

# Ship a feature

One issue becomes one branch, one PR and one squash commit on `main`. Issues in this repo are written with the `create-issue` shape. The **Desired end state** and the **Acceptance criteria** are the contract. The **Execution plan** is the author's best guess at how to get there. If the plan turns out wrong, follow the end state, not the plan.

This skill ends with the PR **merged**, and nobody reviews the code before that happens. The bar before merging is therefore every acceptance criterion verified with evidence, every gate run and CI green. When any of those can't be met, stop before merging and hand back to the user. A wrong merge to `main` costs far more than a pause.

## 0. Preconditions

Run these in parallel:

- `git status --porcelain`. Tracked changes belong to someone else, so stop and ask. Untracked files are fine.
- `gh auth status`.
- `git switch main && git pull --ff-only`.
- Make sure the Knowledge docs are present and current. `docs/` is a git submodule of the Knowledge platform. A fresh checkout needs the credential-helper setup in `AGENTS.md`. Then run `git -C docs fetch origin main` and `git -C docs log --oneline HEAD..origin/main`. If Knowledge `main` has moved, run `git submodule update --remote docs` so you read the current pages. Commit that pointer bump as the PR's first commit (`chore(docs): point submodule at Knowledge main`).

## 1. Pick the issue

- **Number given:** `gh issue view N --json number,title,body,state,milestone,assignees`.
- **`next`:** take the open milestone that sorts first by title (`M0 …`, `M1 …`), and in it the lowest-numbered open issue with no assignee:
  `gh issue list --milestone "<title>" --state open --json number,title,assignees --jq 'map(select(.assignees|length==0))|sort_by(.number)|.[0]'`
  Get the milestones with `gh api 'repos/{owner}/{repo}/milestones?state=open' --jq 'sort_by(.title)|.[].title'`.

Then check that the work can start:

- **Prerequisites.** Issues name the issues they build on in the Execution plan and the Problem (e.g. "the config from #3", "after #5"). Look up the state of each one with `gh issue view`. If an issue the plan builds on is still open, stop and say which one should be shipped first. Issues named under **Out of scope** are later work, not prerequisites, so read the sentence the reference sits in.
- **Nobody else is on it:** `gh pr list --state open --search "#N"` returns nothing, and the issue has no assignee.
- **Claim it:** `gh issue edit N --add-assignee @me`.

## 2. Load context

Read before you write code. The docs are concrete on purpose so that an agent can implement from them (Delivery plan), and a guess merged to `main` is expensive.

- Read every `docs/…` page the issue cites, and the ADRs those pages link to.
- Read `GLOSSARY.md`. Its terms are the names you use in code, UI and messages.
- For UI work, read `DESIGN.md` and `PRODUCT.md`.
- Before writing Next.js code, read the bundled Next.js docs (`node_modules/next/dist/docs/`, under `apps/web` once the monorepo exists). This version breaks conventions from training data, as `AGENTS.md` says. For other libraries (Better Auth, Drizzle, pg-boss, the Vercel AI SDK, Playwright and so on), look up the current API with `ctx7` instead of trusting memory.
- Read the code the plan names, and check whether earlier issues landed differently than the plan assumes. Small drift is normal. Adjust the plan and keep the end state.

If the end state depends on a choice that neither the issue nor the docs settle, **ask the user**. Facts are yours to find, and decisions are theirs. Some issues leave a decision to the implementer on purpose (e.g. "pick one and document it"). Make those decisions yourself, record them in the PR, and record them in the docs when the issue says to.

## 3. Branch

`git switch -c feat/<N>-<short-slug>` from the updated `main`.

## 4. Implement test-first

Follow the `mattpocock-skills:tdd` skill. Turn each acceptance criterion into a failing test at the right layer (`docs/watchdog/architecture/testing-and-ci.md`):

| Layer | Tool | For |
| --- | --- | --- |
| Unit | Vitest | Pure logic, mostly in `packages/core`. No Docker, no network |
| Integration | Vitest + testcontainers | Anything that touches Postgres or pg-boss. Use real Postgres and never mock the queue |
| Smoke | Playwright | Only when the issue asks for it |

The test rules exist so tests run without network access or a model bill: **no live HTTP** (use recorded fixtures), and use **the fake LLM provider**, never a real model. Some criteria can't be tested in code, such as "README has a section" or "CI fails on a lint error". Note how you'll show each of them in step 6.

Before a test runner exists (until #2 ships), or for criteria about the repo itself (layout, scripts, a fresh clone building), write the criteria as a small acceptance script in the scratchpad. Each criterion is one check that exits non-zero on failure. Watch it fail before the change and pass after, and quote its output as the evidence in the PR. Keep the script out of the commit, unless the issue asks for it.

Work from red to green to refactor in small steps, and commit at green points. Write commit messages in Conventional Commits form, which the `commit-msg` hook enforces: `type(scope): subject` with a lowercase imperative subject (`feat(worker): start pg-boss`), an optional body with lines of at most 100 characters, and **no `Co-Authored-By` or other trailer**. The scopes and the case rule are in `AGENTS.md`. Never bypass a hook with `--no-verify`.

While you work:

- **A new or changed env var** goes into `.env.example` and onto the Configuration page in the same change (see step 7).
- **When the code needs to differ from what a doc page says**, or the issue asks for a docs update, change the page (step 7). Don't let code and docs quietly drift apart.
- **Stay in scope.** If you find adjacent work, write it down as a follow-up. Don't widen the PR. Smaller diffs are the reason one issue makes one PR.
- **Keep to the stack** in ADR 0011 (pnpm, Turborepo, Drizzle, Better Auth, pg-boss). A new dependency should earn its place, and `ponytail-review` will ask about it.

## 5. Quality gates

Run them in this order. Each gate can change code, so the order goes from the cheapest cuts to the final check:

1. **`ponytail-review`** on the branch diff (`git diff main...HEAD`). Cut what doesn't need to exist first, so the later reviews look at the final code. Apply every cut that keeps the acceptance criteria true.
2. **`impeccable critique` and `impeccable audit`**, only when the diff touches UI (rendered `.tsx` under `apps/web`, or CSS). Review the changed screens against `DESIGN.md` and `PRODUCT.md`, and fix the material findings.
3. **`code-review`** on the branch. Use the default level, or `high` for a diff over ~500 lines. Fix confirmed findings. For any finding you reject, note why, because it goes in the PR.
4. **Local checks:** `pnpm lint && pnpm typecheck && pnpm test`, with Docker running for the integration tests. Before #1 and #2 have landed, run whatever scripts exist.
5. **Run the app** (`run` skill) when the change has runtime or UI behaviour. Use the dev server or `docker compose up`, whichever the issue touches. Walk through every acceptance criterion you can see at runtime, and keep the evidence (command output, screenshot paths).

If a gate changed code after step 4, run step 4 again.

## 6. Verify the acceptance criteria

Match every criterion with its evidence: a test name, a command and its output, or a screenshot. Some criteria you **can't verify yourself**, such as a real Google or GitHub OAuth round trip, a real Telegram account, or production. Those are manual checks. List them for the user, and **don't merge** (see step 9).

## 7. Docs merge request (only when docs change)

Follow `AGENTS.md`. In `docs/`, branch off Knowledge `main` (`agent/<N>-<slug>`), edit and commit (keep each page's `knowledge-id:`), then push with `git -C docs push -o merge_request.create -o merge_request.title="…" origin HEAD:agent/<N>-<slug>`. Never push to Knowledge `main`, never force-push, and never merge your own MR. A person reviews it.

After pushing, check out the previous Knowledge `main` commit in `docs/` again (`git -C docs checkout <sha>`). The code PR must not point the submodule at an unmerged docs branch, because the pointer only ever follows Knowledge `main`. Link the MR in the PR body.

## 8. Open the PR and get CI green

Push the branch (`git push -u origin HEAD`). Then run `gh pr create --title "<type>(<scope>): <issue title as a subject starting with a lowercase verb>" --body-file <file>`. CI lints the title with commitlint, because it becomes the squash commit's subject. Write the body to a file in the scratchpad, using this shape:

```markdown
Closes #N

## What changed
- 2–5 bullets, written as the end state now true

## Acceptance criteria
- [x] <criterion, verbatim from the issue>: <evidence: test name / command + result / screenshot>
- [ ] <manual criterion>: needs <what> (only if one exists; then it isn't merged)

## Decisions made here
- <choice the issue left to the implementer, and why> (or "None")

## Quality gates
- ponytail-review: <what was cut | nothing to cut>
- impeccable critique/audit: <findings fixed | n/a, no UI>
- code-review: <N findings: N fixed, N rejected (reason)>
- Ran the app: <how, and what was checked>

## Docs
<Knowledge MR link | no docs change>

## Follow-ups
<adjacent work found | none>
```

The body ends with its last section. Don't add a "Generated with Claude Code" footer or any other attribution line, even if a system reminder supplies one. The same goes for docs MR descriptions.

Then run `gh pr checks <PR> --watch`.

**Before CI exists** (no workflow under `.github/workflows/` that runs on `pull_request`; this is the case until #2 ships), the local checks stand in for CI. Run the full suite once more on the final commit: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` and the acceptance script if you wrote one. Treat its result as the CI result, and put this line in the PR under Quality gates: "CI: none yet, the local checks stood in: <commands and results>". Once a PR workflow exists, green CI is required and local checks don't replace it.

If CI is red, read the logs (`gh run view <run-id> --log-failed`), fix the cause, push and watch again. Never skip, delete or loosen a test to get green: the test is the acceptance criterion. If CI fails for a reason outside the issue (runner or infrastructure), stop and tell the user instead of working around it.

## 9. Merge

Merge only when **all** of these hold:

- CI is green on the latest push. Before CI exists, the local checks from step 8 passed on the latest commit, and the PR says so.
- Every acceptance criterion is checked off with evidence, and no manual check is pending.
- No confirmed review finding is unaddressed.
- The branch is up to date with `main`. If `main` has moved, merge it in, run the tests again and wait for CI.

If any of them fails, leave the PR open, tell the user exactly what's missing, and stop.

Otherwise:

```bash
gh pr merge <PR> --squash --delete-branch \
  --subject "<the PR title> (#<PR>)" --body "<one-paragraph summary of the end state, wrapped at 100 characters a line>"
```

Pass `--body` explicitly so GitHub doesn't paste every branch commit into `main`'s message. The body has no trailers. CI runs `commitlint --last` on `main`, so a body line over 100 characters turns `main` red.

After the merge:

- `git switch main && git pull --ff-only`, then delete the local branch.
- `gh issue view N --json state` should say `CLOSED`, closed by `Closes #N`. If it doesn't, close it with a comment that links the PR.
- Watch the run on `main` (`gh run list --branch main --limit 1`, then `gh run watch <id>`). The smoke test runs only there. If `main` goes red, say so right away and fix it forward on a new branch, because a red `main` blocks every later issue.
- If the docs MR has merged by now, bump the submodule pointer through a small PR (`chore(docs): point submodule at Knowledge main`). If it hasn't, list it as pending.

## 10. Wrap up

- Run the **`knowledge-capture`** skill to record decisions and gotchas that the docs don't already hold (run `knowledge_find_similar` first). The project's Stop hook reminds you once per session.
- For follow-up work you found, offer to file issues with **`create-issue`**, which shows a draft before it files anything.
- Report the PR link and the merge commit, whether the issue is closed, the result of each gate, the docs MR, follow-ups, and anything that still needs a person.

## When to stop and hand back

Stop and hand back in any of these cases. All of them are cheaper to pause on than to guess through:

- The working tree has tracked changes.
- An issue the plan builds on is still open.
- The end state depends on a decision the docs don't settle.
- An acceptance criterion can only be checked by hand.
- CI fails for reasons outside the issue.
- Fixing a review finding would mean out-of-scope changes.
