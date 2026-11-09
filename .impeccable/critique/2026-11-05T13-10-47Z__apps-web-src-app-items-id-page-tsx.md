---
target: Item detail page, manual Extractor Rule run
total_score: 21
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/Users/hrustalq/Projects/watchdog/apps/web/src/app/items/[id]/page.tsx"
target_fingerprint: "sha256:7ac7f698f50edf5bb1373f7e3f33b870e82cf30337e2eb66a954a3eed7ee7c24"
target_path: /Users/hrustalq/Projects/watchdog/apps/web/src/app/items/[id]/page.tsx
timestamp: 2026-11-05T13-10-47Z
slug: apps-web-src-app-items-id-page-tsx
---
Method: dual-agent (design review and detector/browser evidence, isolated).

Item detail page, "Extracted fields" and "Run an Extractor Rule" sections (issue #91). Scores are from before the fixes.

## Design Health Score: 21/40 (Acceptable)

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of status | 2 | Pending is one word in a small button |
| 2 | Match with real world | 2 | The notice is a raw Log line |
| 3 | User control | 2 | No cancel during a metered call |
| 4 | Consistency | 3 | Dropped the /rules name link and the /model stale-result guard |
| 5 | Error prevention | 2 | Metered and free Run looked identical |
| 6 | Recognition over recall | 2 | No field-to-rule mapping |
| 7 | Flexibility | 1 | Focus lands above the list on a re-run |
| 8 | Minimalist design | 3 | Calm and clean |
| 9 | Error recovery | 2 | Clear reason, no word on the kept values |
| 10 | Help | 2 | The inline paragraph is good |

## Priority issues and what happened

- [P1] Nothing linked a field to the rule that filled it. Fixed: "from <rule>" beside each field, rule names link to the rule.
- [P1] The pending state was silent to screen readers. Fixed with a status line. A shared pending flag across rows was rejected: a second click is deliberate.
- [P1] The failure notice didn't say the old values stayed. Fixed. The rest of this finding, that the notice reuses the raw Log sentence, is a follow-up: the wording is shared with the pipeline.
- [P2] Long field name overflowed at 360px (detector scan didn't see it, measured in the browser). Fixed: stacks on a phone.
- [P2] A stale success could sit above a newer failure. Fixed: only the newest manual run shows.
- [P2] Cost wasn't visible at the point of commitment. Fixed: "One model call" on the row.
- [P3] "Disabled" had two meanings; helper line ran about 105 characters (the one browser detector finding). Fixed.

Rejected for now, no acceptance criterion needs them: previous values in the Log, cancel, dismiss, a disclosure around the section, per-rule readings.

## Deterministic scan

CLI: 0 findings. Browser overlay: 1 finding, line-length, real and fixed.

## Audit: 16/20 (Good)

Accessibility 3, Performance 4, Responsive 2, Theming 4, Implementation Integrity 3.
