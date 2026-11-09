---
target: "Settings screen (#201)"
total_score: 29
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 1
target_identity: "file:/Users/hrustalq/Projects/watchdog/apps/web/src/app/settings/page.tsx"
target_fingerprint: "sha256:039f1d6d47955e7c85fa81ac3a65b7f9b15d529fabda2dcda2d82a1cc0b28451"
target_path: /Users/hrustalq/Projects/watchdog/apps/web/src/app/settings/page.tsx
timestamp: 2026-11-08T15-23-03Z
slug: apps-web-src-app-settings-page-tsx
---
Method: dual-agent (A: design review · B: detector + browser)

## Design Health Score: 29/40 (Good)
1 Visibility 3 · 2 Real world 3 · 3 Control 3 · 4 Consistency 3 · 5 Error prevention 3 · 6 Recognition 3 · 7 Efficiency 2 · 8 Minimalism 3 · 9 Recovery 3 · 10 Help 3

## Design Specificity
Copy is product-specific (glossary terms, "held, never dropped", what ignores quiet hours). Composition is a generic stacked settings card; follows DESIGN.md tokens. Detector: CLI 0 findings; browser overlay 3x line-length on section intros (~84-87 chars).

## Priority issues (and what was done in #201)
- [P1] Refused save never said "not saved"; status sentence asserted old settings. FIXED: "Nothing was saved" note, "Saved:" prefix.
- [P2] Quiet-hours off state looked on. FIXED: CSS :has dims the times and bypass, no JS needed.
- [P2] "24-hour clock" copy contradicted 12-hour native time controls; refused 25:00 renders blank. FIXED: copy no longer names a clock; error says "Choose when quiet hours start."
- [P2] "Use <zone>" target 16px, confirmation silent. FIXED: 24px target, persistent role=status.
- [P3] No unsaved-changes state like Profile. NOT DONE (follow-up).
- line-length on intros. FIXED: max-w-[70ch].

## Minor
"one message per Destination" now "one Grouped alert per Destination". Root html hard-codes class="dark" (app-wide, out of scope).
