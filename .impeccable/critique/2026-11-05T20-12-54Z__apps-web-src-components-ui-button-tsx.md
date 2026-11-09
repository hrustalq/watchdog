---
target: "link-styled buttons for #116"
total_score: 23
max_score: 32
na_heuristics: 5,10
p0_count: 0
p1_count: 0
target_identity: "file:/Users/hrustalq/Projects/watchdog/apps/web/src/components/ui/button.tsx"
target_fingerprint: "sha256:79885c93fb9a5e5d770fb8251c730fa36f35bf2f63f1c23e093c113b9433321d"
target_path: /Users/hrustalq/Projects/watchdog/apps/web/src/components/ui/button.tsx
timestamp: 2026-11-05T20-12-54Z
slug: apps-web-src-components-ui-button-tsx
---
Method: dual-agent (A: design review, B: detector and browser evidence)

Scope: link-styled buttons on Feed, not-found, Rules and Usage, for issue #116 (branch feat/116-outline-button-border).

No material findings, and nothing caused by this diff. Every issue below was already there and rates P3.

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | System status | 3 | Pending state on navigation not tested |
| 2 | Real-world match | 3 | "Deterministic" leans on the sentence above it |
| 3 | User control | 3 | No step back one page except browser back |
| 4 | Consistency | 3 | Not-found action is outline; comparable empty states use primary |
| 5 | Error prevention | n/a | Reversible links |
| 6 | Recognition | 3 | Ghost links have little resting affordance |
| 7 | Flexibility | 2 | No shortcuts; paging and months go one step at a time |
| 8 | Minimalism | 3 | "Sign out" is the heaviest thing in the header |
| 9 | Error recovery | 3 | Not-found copy is wrong for non-Item URLs |
| 10 | Help | n/a | Links carry no help |
| Total | | 23/32 (72%) | Good |

## Design specificity

The controls are stock shadcn, as DESIGN.md intends. The character comes from how they're used: one fill per region and labels from the glossary. Detector: 0 CLI findings on the five changed files; the browser overlay flagged 2 line-length findings at rules/page.tsx:23 and :33, both real, neither on a changed line.

## Priority issues (all P3, already there)

1. Month links can swap places, so a repeated click may go back and forth (usage/page.tsx:65-74). Inferred from code, not observed. Fix: give each direction a fixed slot.
2. "Back to the newest" doesn't read as a link on touch (page.tsx:123). Fix: outline, or the underlined text-link style.
3. Not-found copy mentions Items on any mistyped URL. Fix: an Item-specific not-found under items/[id].
4. "Back to the Feed" is outline but is the screen's only action, while DESIGN.md asks for Panel Ink. The issue asks for the outline border, so it stays in this PR.

## Persona red flags

- Alex: no shortcuts; months step one at a time.
- Sam: no focus problems; "Done" is ambiguous out of context; the 1.4:1 border leaves low-vision users relying on the text label.

## Minor observations

- DESIGN.md says outline hover uses Instrument Well; dark mode uses a fainter input/30.
- Some call sites still append classes with template strings, with no visual effect.
- "Sign out" is the heaviest thing in the header.
- 32px targets follow DESIGN.md but are below 44px.
