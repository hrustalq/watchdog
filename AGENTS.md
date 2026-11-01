<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

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
