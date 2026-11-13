---
target: Item detail page, the Extractor Rule list
total_score: 31
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 0
target_identity: "file:/Users/hrustalq/Projects/watchdog-148/apps/web/src/app/items/[id]/page.tsx"
target_fingerprint: "sha256:33534601ea58ab0dfd5bd319496c750089ba7bc3d8133df415177cfe80db0a18"
target_path: /Users/hrustalq/Projects/watchdog-148/apps/web/src/app/items/[id]/page.tsx
timestamp: 2026-11-13T19-14-06Z
slug: apps-web-src-app-items-id-page-tsx
---
Method: single agent (design review and browser/detector evidence from the same session; the earlier record on this page was dual-agent).

Item detail page, the "Run an Extractor Rule" section with 20 Extractor Rules (GitHub issue #148). Scores are for the section as this change leaves it.

## Design Health Score: 31/40 (Good)

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of status | 4 | The run's notice is focused and in view, list open or closed |
| 2 | Match with real world | 3 | "Show 20 Extractor Rules" says what's behind it, and how much |
| 3 | User control | 3 | Open and closed is the user's, and works without JavaScript |
| 4 | Consistency | 4 | Same native disclosure as Delete on the Rules screen, same 32px control |
| 5 | Error prevention | 3 | A failure still names the rule and says the old values stayed |
| 6 | Recognition over recall | 3 | The count, not a bare "Show more" |
| 7 | Flexibility | 3 | Keyboard, no JavaScript, and a few rules stay inline |
| 8 | Minimalist design | 4 | One 32px row where 20 rows used to be |
| 9 | Error recovery | 3 | Unchanged from #91 |
| 10 | Help | 2 | The paragraph above is still 5 lines at 360px, uncollapsed |

## Priority issues and what happened

- [P2] 20 rules (2,060px at 360px) pushed the Log off the screen. Fixed: a disclosure when a Workspace has more than three rules. Measured 321px from the end of Extracted fields to the Log heading with 20 rules at 360x640, against 640px for a screen; 2,380px with the list open.
- [P2] A threshold rather than always-collapsing. Three rules inline cost 597px at 360x640 and 437px at 1280x800, both inside a screen, so a Workspace with a few rules gets exactly the page it had. Four would exceed a screen at phone width (103px a row), which is where the cut sits.
- [P3] The open header is filled with Instrument Well, as Delete's is on the Rules screen. Kept for consistency: it reads as the row that owns the panel.
- Rejected: moving the section below the Log. It would hide the affordance from a Workspace with two rules, and the ticket's end state asks for the list to be out of the way until asked, not gone.

## Deterministic scan

CLI: 0 findings on the changed file (`impeccable detect`). The URL and CDP scans could not reach the dev server from the detector's browser (connection timed out on a local static page too), so the element rules were replaced by measurements taken in the same Playwright session as the screenshots: contrast, target sizes, overflow, focus.

Measured in the browser (Chromium 156, 360x640 unless noted):

- Contrast: the disclosure 18.07:1 closed and 13.75:1 on its open fill; a rule row's name 18.07:1, its kind line 7.57:1, its Run button 18.07:1. No new colour token.
- Targets: the disclosure 32px tall, a Run button 32px, a row 103px on a phone and 63px on a desktop.
- Focus: the summary takes the Focus Grey 3px halo at 30% from the keyboard, as the other disclosures do.
- Overflow: none at 320, 360 or 1280px.

## Audit: 18/20 (Good)

Accessibility 4 (native disclosure, accessible name "Show 20 Extractor Rules", collapsed state announced, every Run button reachable by Tab in rule order), Performance 4 (no JavaScript added: one native disclosure, and the rows cost no scroll until asked for), Responsive 4, Theming 3 (existing tokens only; the open header reuses `muted`), Implementation Integrity 3 (the three-rule threshold is a judgement the code states in one place).
