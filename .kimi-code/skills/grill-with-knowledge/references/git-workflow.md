# Knowledge git workflow

The Knowledge platform serves each project as a git repository. In this repo it's the `docs/` submodule. A page is a `.md` file, and the `knowledge-id:` in its frontmatter *is* the page. Pushing a branch writes one revision per changed page, and the merge request is reviewed on the platform.

## Contents

1. Authentication
2. Bring docs up to date
3. Branch, commit, push
4. New pages and their IDs
5. Known gotchas

## 1. Authentication

The submodule uses a credential helper that sends `$WATCHDOG_KNOWLEDGE_API_KEY` (or the project's equivalent; see `AGENTS.md`) as the password. If a fetch fails with `Authentication failed` / `Sign in with an API key`, the variable isn't set in the shell running git. Tell the user to export it in their shell profile. Never ask them to paste the key into the chat, and never write it to a file.

## 2. Bring docs up to date

```bash
git -C docs fetch origin
git -C docs checkout main
git -C docs merge --ff-only origin/main     # a local main can lag origin/main
```

A submodule is often in "detached HEAD" state: git has it on a specific commit rather than on a branch. And a local `main` can be behind `origin/main`. Checking out `main` without fast-forwarding it leaves you on stale pages, so do all three steps.

## 3. Branch, commit, push

```bash
git -C docs checkout -b grill/<topic-slug>-<YYYY-MM-DD>

# after each round
git -C docs add -A
git -C docs commit -m "Grill <topic>: round N - <what settled>"

# first push opens the merge request; later pushes update it
git -C docs push -o merge_request.create -o merge_request.title="Grill: <topic> (<YYYY-MM-DD>)" origin HEAD:grill/<topic-slug>-<YYYY-MM-DD>
git -C docs push origin HEAD:grill/<topic-slug>-<YYYY-MM-DD>
```

The remote prints the merge request URL. If it doesn't, call `knowledge_list_branches` with the project ID: the session branch's `openMergeRequest.mergeRequestId` gives the link `https://<host>/merge-requests/<id>`. Pass the link on to the user. Don't add `Co-Authored-By` or any other attribution trailer to commit messages. The user doesn't want them.

The history is append-only, so a force push is refused. If a push fails with "fetch first", someone changed the branch. Run `git -C docs pull --no-rebase`, resolve any conflicts and push again. Refusals arrive as `remote:` lines that state the reason. Report them, don't work around them.

## 4. New pages and their IDs

- **Creating a page:** a new `.md` file without `knowledge-id:` becomes a new page when pushed. The title comes from the file's `# H1`. The file's location sets its parent: `section/page.md` becomes a child of `section.md`.
- **The ID isn't written back.** The server assigns the page's ID but doesn't add it to your file. Every new page therefore goes through the **new-page cycle**:
  1. Push the commit that creates the page.
  2. Call `knowledge_list_branches` with the project ID, and find the page's `documentId` by its title on your branch.
  3. Add `knowledge-id: <id>` to the top of its frontmatter, and add the links to it (`https://<host>/documents/<id>`) on the pages that should reach it.
  4. Commit (`Add knowledge-id to <page> and link it`) and push again.

  Batch the cycle when a round creates several pages: one push, one lookup, one follow-up commit.
- **Moving a page:** `git mv` moves it, and its ID and history follow.

## 5. Known gotchas

- **Renaming doesn't change titles.** Changing an existing page's `# H1`, or `git mv`-ing it to a new filename, doesn't change its title on the platform. Avoid renaming existing pages during a session. If a rename is really needed, list it in the final report for the user to do in the Knowledge UI.
- **A merged branch spawns a new draft.** If the user merges the session's merge request mid-session, the next push of a *new* file to the same branch opens a separate **draft** merge request. Its title comes from your commit message, and it still needs a reviewer. After a mid-session merge, prefer a fresh branch from the updated `main` (`grill/<topic>-<date>-2`), and tell the user which merge request is now current.
- **`knowledge_capture_decision` makes stray pages.** Its pages land at the project root, with headings in the server's locale. Write an ADR page on the branch instead.
- **Glossary terms live in two places.** There's the glossary *page* (in git) and the platform *glossary* (via `knowledge_propose_glossary_term`, approved in the captures inbox). Keep them in step: the same term, definition and _Avoid_ list.
- **The parent repo pins a commit.** After the user merges, the parent repo still points at the old docs commit. They need `git submodule update --remote docs` and a commit of the new pointer, which you can do if they ask.
