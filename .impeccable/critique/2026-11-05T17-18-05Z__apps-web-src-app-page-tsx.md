---
target: Correction controls on the Feed and Item pages
total_score: 21
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 3
target_identity: "file:/Users/hrustalq/Projects/watchdog/apps/web/src/app/page.tsx"
target_fingerprint: "sha256:4b5de0def5bb32d21f626c8a8edd4b3d675daac8ecf7269936148514cea6c325"
target_path: /Users/hrustalq/Projects/watchdog/apps/web/src/app/page.tsx
timestamp: 2026-11-05T17-18-05Z
slug: apps-web-src-app-page-tsx
---
Method: dual-agent (design review; detector and browser). Target: the Correction controls on the Feed and Item pages.

Score 21/40: status 2, real world 2, control 1, consistency 3, prevention 1, recognition 2, efficiency 2, minimal 3, recovery 2, help 3.

Detector: 0 findings in 6 files; overlay reported no anti-patterns on the pages checked.

Priority issues:
- [P0] Feed and Item are blank without JavaScript (confirmed in Playwright). Read the data without Suspense, as profile/page.tsx does.
- [P0] On Top, a click moves the row under the pointer, so a repeat click can correct another Item.
- [P1] A reverted misclick stores a Correction with before equal to after, sent to the Agent.
- [P1] "Correction saved" is announced when nothing changed. Announce the resulting state.
- [P1] Levels show no meaning, though the Agent has anchors for each.
- [P2] Focus drops to body after removing a Category or saving a Rating; selects read as invalid on load; dimming also dims the focus ring; Rate link is 16px tall.

User request: hide the Feed row's controls behind an editing mode.

Questions: hold Top's order while editing? Show the level meanings now or later?
