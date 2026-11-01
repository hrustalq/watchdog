---
name: knowledge-capture
description: Use when finishing a piece of work, or when the knowledge-capture hook asks, to record the decisions, gotchas, conventions and hard-won answers from this session in the Knowledge platform at knowledge.hrustalq.dev — proposed as merge requests a person reviews, never written straight to a page.
---

# Knowledge capture

The capture tools are `knowledge_*` tools of the `knowledge` MCP server (`https://knowledge.hrustalq.dev/api/v1/mcp`). If they are not
available, the server is not connected: say so once, and do not improvise with web requests. The
`knowledge-platform` skill covers reading and searching the knowledge base.

## Where to capture

Pick the project the work belongs to. `knowledge_whoami` is the live answer if this list looks stale.

- Watchdog — `workspaceId: 2bb01967-86b3-4f09-9348-d67bd8b0304a`
  - Platform documentation — `projectId: ab95b26a-3490-4149-81a8-541f6ec403fa`

Captured merge requests are reviewed at `https://knowledge.hrustalq.dev/merge-requests`; every capture is listed at
`https://knowledge.hrustalq.dev/captures`.

## Capture memory

What this session learned disappears when it ends unless it is written down. The capture tools propose it back into
the knowledge base: each capture is staged, checked against what the knowledge base already says, and opened as a merge
request a person reviews. Nothing you capture changes a page until someone merges it.

### What is worth capturing

Capture at the end of a piece of work, or when a hook reminds you — not after every edit — and only what the next
person or agent would otherwise have to rediscover:

| Learned | Tool |
| --- | --- |
| A decision, with its reasons and the options ruled out | `knowledge_capture_decision` |
| A gotcha: a non-obvious failure and its cause | `knowledge_capture_note`, `kind: "gotcha"` |
| A convention the team holds | `knowledge_capture_note`, `kind: "convention"` |
| A how-to that took real digging | `knowledge_capture_note`, `kind: "howto"` |
| A term the codebase uses in its own sense | `knowledge_propose_glossary_term` |
| A dependency a page should record | `knowledge_propose_relation` |
| An answer that took many tool calls, citing its pages | `knowledge_propose_answer` |

### What is not

- Secrets, credentials, tokens or personal data. A capture carrying one is refused; never rephrase around the check.
- Transient debugging, the steps of this session, or what the diff already shows.
- Anything the knowledge base already says. Call `knowledge_find_similar` first with the `title`, `kind` and
  `projectId` you will capture with, so it scores what the capture will, and skip it when `decision` is `duplicate`.
- Text copied from a page. Point at the page (`relatedDocumentIds`) instead.

### How

1. One capture per fact: two decisions are two calls.
2. Write for a reader who was not here. The title is the claim; the body says why.
3. Always pass `session`: `client` (`claude-code`, `cursor`, `codex`, `gemini` or `other`), the `sessionId` a hook
   gave you, `repo` (`git remote get-url origin`), `branch` (`git rev-parse --abbrev-ref HEAD`), `commit`
   (`git rev-parse HEAD`) and `files` — the repository paths involved, paths only, never their contents.
4. Read the reply. `state: "duplicate"` means the knowledge base already says it: stop there. Otherwise give the user
   `webUrl`, the merge request a person will review.
5. A `429` means the capture budget is spent for now. Say so and move on; do not retry in a loop.
