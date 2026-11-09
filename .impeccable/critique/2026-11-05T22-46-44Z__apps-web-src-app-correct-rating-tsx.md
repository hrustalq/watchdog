---
target: Item detail Rating controls
total_score: 23
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 1
target_identity: "file:/Users/hrustalq/Projects/watchdog/apps/web/src/app/correct-rating.tsx"
target_fingerprint: "sha256:46df8a1ce0307b7986bcec130e06f155fec9aaa88564cbb904b8100625661f57"
target_path: /Users/hrustalq/Projects/watchdog/apps/web/src/app/correct-rating.tsx
timestamp: 2026-11-05T22-46-44Z
slug: apps-web-src-app-correct-rating-tsx
---
Method: dual-agent (design review; detector and browser evidence), run during ship-feature for #160.

| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | No visible "saved"; the status is for screen readers and omits the meaning |
| 2 | Match System / Real World | 2 | "directly about the user's product" is shown to that user |
| 3 | User Control and Freedom | 2 | One click commits, and the Agent's original level isn't marked |
| 4 | Consistency and Standards | 3 | Meanings were lowercase in sentence-case Label type |
| 5 | Error Prevention | 2 | A sighted user learned a level's meaning only after committing it |
| 6 | Recognition Rather Than Recall | 2 | Other levels' meanings were invisible on a rated Item |
| 7 | Flexibility and Efficiency | 2 | 10 tab stops, no arrow-key movement |
| 8 | Aesthetic and Minimalist Design | 3 | One reading shown three ways; 570px select on desktop |
| 9 | Error Recovery | 2 | Browser validation names no field |
| 10 | Help and Documentation | 2 | Help covered only the current level |
| **Total** | | **23/40** | **Acceptable** |

Scores are from before the fixes below. Detector: 0 CLI findings; 6 overlay `text-occlusion` flags in the Feed, all false positives from the closed header menu. Audit: 17/20.

## Priority issues
- [P1, fixed] Sighted users could read only the current level's meaning, and seeing another took a Correction. Added the "What the levels mean" disclosure.
- [P2, fixed] Unrated selects clipped on a phone and collapsed when zoomed. They now stack under their labels on a phone.
- [P2, follow-up] Anchors' third-person wording shows on the user's screen. The wording is out of scope for #160.
- [P2, follow-up, pre-existing] The Agent's original level isn't marked, so a revert relies on memory.
- [P2, follow-up, pre-existing] The rated scale row overflows with large text at phone width.
- [P2, follow-up, pre-existing] Forced-colours focus is faint (`outline-none`), system-wide.
