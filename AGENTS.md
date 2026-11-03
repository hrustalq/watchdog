## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `apps/web/node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

`next dev` would write this block into a second `AGENTS.md` in `apps/web`, so `agentRules: false` in `apps/web/next.config.ts` turns that off and this file stays the only one.

## Project docs

- `docs/` is a git submodule of the Knowledge platform project "Watchdog → Platform documentation" (https://knowledge.hrustalq.dev). Read it locally. You don't need the MCP server to look something up: `docs/watchdog.md` is the index, and it has Product, Domain, Architecture, Decisions (ADRs) and Discovery sections.
- `GLOSSARY.md` is a symlink to `docs/watchdog/domain/domain-glossary.md`. Use its terms in code and UI.
- `PRODUCT.md` is a symlink to `docs/watchdog/product/product-brief.md`, the product brief the impeccable design tooling reads. Edit it in `docs/` like any other page.
- The submodule authenticates with `$WATCHDOG_KNOWLEDGE_API_KEY` through a credential helper in its local git config. A fresh clone needs:
  ```bash
  helper='!f() { echo username=knowledge; echo "password=$WATCHDOG_KNOWLEDGE_API_KEY"; }; f'
  git -c credential.helper= -c credential.helper="$helper" submodule update --init docs
  git -C docs config credential.helper '' && git -C docs config --add credential.helper "$helper"
  ```
- To change docs, work in `docs/` on a new branch, commit, and `git push -o merge_request.create -o merge_request.title="…" origin HEAD:<branch>`. Never push to `main` or force-push. A person reviews the merge request. Keep each page's `knowledge-id:` frontmatter. A new `.md` file is a new page, and `git mv` moves a page.
- After a docs merge request merges, run `git submodule update --remote docs` and commit the new pointer.

## Lint rules

Lint is strict on purpose, and a warning fails it just like an error. These are blocked:

- Type casts (`x as Foo`, `<Foo>x`), non-null assertions (`x!`) and `any`. Narrow unknown values with a type guard or a zod parse instead. `as const` is fine. `// @ts-expect-error -- reason` is the last resort, and `@ts-ignore` is never allowed.
- `eslint-disable` without rule names and a reason. Write `// eslint-disable-next-line <rule> -- <why>`, and only when the rule is wrong for that line.
- `TODO`/`FIXME` comments. File an issue for deferred work.
- Reading `process.env` outside the config loader (`packages/core/src/config.ts`, which arrives with #3), tests and tool configs.
- `.only`, `.skip` and tests without assertions.

A rule relaxed for some files goes in that package's `eslint.config.mjs`, scoped to a glob, with a comment saying why. Shared rules live in `packages/eslint-config`.

## Commits and pushes

- Commit messages and PR titles follow Conventional Commits (see README). Start the subject with a lowercase imperative verb (`feat(web): sign in by magic link`), because commitlint's `subject-case` rejects a subject that starts with a capital, even a proper noun. Later words keep their case (`fix(web): handle GitHub sign-in errors`). Keep body lines to 100 characters or fewer.
- Never push with `--no-verify`. When the pre-push hook fails, fix the cause.

## Releases

release-please owns `CHANGELOG.md`, the `version` in the root `package.json`, `.release-please-manifest.json` and the release PR (`chore(release): release X.Y.Z`). Agents never edit them by hand and never merge, edit or push to a release PR. A person cuts each release. See README.
