---
target: Usage screen
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/Users/hrustalq/Projects/watchdog/apps/web/src/app/usage/page.tsx"
target_fingerprint: "sha256:afe3d6f867e322f3ad53b0ec223790774f6b9bda74828e000f97c4f066b4c0e2"
target_path: /Users/hrustalq/Projects/watchdog/apps/web/src/app/usage/page.tsx
timestamp: 2026-11-05T19-05-22Z
slug: apps-web-src-app-usage-page-tsx
---
Method: dual-agent (A: design review agent, B: detector and browser agent)

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 2 | Viewed month was the quietest month on the page |
| 2 | Match with the real world | 3 | "No estimate" unexplained |
| 3 | User control | 3 | No jump to the current month |
| 4 | Consistency | 3 | Outline month links lost their border |
| 5 | Error prevention | 2 | Understated totals printed as exact |
| 6 | Recognition over recall | 2 | Phone scroll lost the row names |
| 7 | Flexibility | 1 | One-month steps only |
| 8 | Minimalist design | 3 | Clean |
| 9 | Error recovery | 2 | "No prices" and "No estimate" dead-ended |
| 10 | Help | 3 | Good inline notes, placed late |
| Total | | 24/40 | Acceptable |

## Design Specificity Verdict

Authored in voice, generic in structure. Mono readings, hairlines and candid copy are the Signal Room; two stacked tables could be any usage page. CLI detector: 0 findings. Browser overlay: 8 findings, 5 false positives (cramped-padding, the inset is on the cells), 3 real line-length.

## Priority Issues

- [P1] One unpriced model erased the cost in the total and the two largest purposes. Fixed: aggregates show the priced part as "≥ x" and a note counts what it leaves out.
- [P1] "Set prices" to /model#input-price never landed, because the field is inside the Model page's Suspense. Fixed: plain /model.
- [P1] Phone hid the cost off-screen, then lost whose it was. Fixed: cost is the second column, first column sticky.
- [P2] Month links outshone the month shown, and nothing marked it partial. Fixed: the month in Title type, "so far".
- [P2] Understatement note was detached below the tables. Fixed: moved under the month.
- [P2] Outline links had no border (raw buttonVariants). Fixed: cn(). Feed's "Show older" has the same pattern, left as a follow-up.
- [P2] Region named twice; scroller focus ring 1.74:1; "Set prices" 17px tall; URLs split mid-token; ~105-character notes. Fixed.

## Persona Red Flags

- Alex: a year back is 12 page loads. Rejected for now, one-month steps are enough for the MVP.
- Sam: scroller is a tab stop on desktop with nothing to scroll. Kept, Safari needs it to scroll from the keyboard.
- Casey: month links are 32px, the system's compact control size.

## Rejected

Column alignment between tables (P3), dimming Failed zeros (P3), a headline reading line (more than the issue asks).
