---
target: Profile screen
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 1
target_identity: "file:/Users/hrustalq/Projects/watchdog/apps/web/src/app/profile/page.tsx"
target_fingerprint: "sha256:e4fa9922a3c5e9ba376836ee90af5c8df659643068bf1dcf504e8157eee9e510"
target_path: /Users/hrustalq/Projects/watchdog/apps/web/src/app/profile/page.tsx
timestamp: 2026-11-05T09-39-47Z
slug: apps-web-src-app-profile-page-tsx
---
Method: dual-agent (A: design review agent, B: detector and browser agent). Scores are from before the fixes in the same PR.

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | "Profile saved." stayed beside unsaved edits |
| 2 | Match with the real world | 3 | "Agent call", "Item" and "rating reasoning" are unexplained |
| 3 | User control | 2 | No revert; a link drops edits silently |
| 4 | Consistency | 3 | Prompt is text-sm, sibling hints are text-xs |
| 5 | Error prevention | 3 | Saving a blank box erases the Profile unconfirmed |
| 6 | Recognition over recall | 3 | Prompt persists, but there was no example |
| 7 | Flexibility | 2 | Box stays 12 lines unless dragged |
| 8 | Minimalist design | 3 | When over, the limit appeared three times |
| 9 | Error recovery | 3 | The lost-draft case offered no next step |
| 10 | Help | 2 | Mechanics covered; what makes a good Profile isn't |
| Total | | 27/40 | Acceptable |

## Design Specificity Verdict

The copy is authored, the composition is generic. The Agent and Item language, the provider disclosure and "Past Items aren't rated again" could only be Watchdog; the layout is a stock single-column form, which suits Operate mode. CLI detector: 0 findings. Browser overlay: 3 line-length findings, 1 a false positive (footer).

## Priority Issues

- [P1] The blank start gave no example or consequence. Fixed: example placeholder, and a line while no Profile is saved.
- [P2] Status was false after an edit. Fixed: the notice hides while edited, and "Unsaved changes" shows by Save.
- [P2] The provider and cost disclosure sat in the weakest type tier. Fixed: moved into the prompt.
- [P2] The alert's live count would likely re-announce on every keystroke. Fixed: static alert text, number only in the counter.
- [P2] The native validity bubble covered the alert. Fixed: onSubmit stops the save and focuses the box.
- [P3] The lost-draft message was a dead end. Fixed: names the Back button, which restored the draft in Chromium.
- [P3] 99-118 characters per line, and RTL text stayed left-aligned. Fixed: max-w-[70ch] and dir="auto".

## Persona Red Flags

- Jordan: "Agent" and "Item" are undefined, and the screen is reachable before any Source exists.
- Sam: the alert issue above. Breadcrumb focus ring measures 1.73:1, shared across screens.
- Casey: following a link discards the draft, with no autosave. Save is full-width but 32px tall, a system-wide density choice.

## Minor Observations

- Language names are English-only; endonyms would help in this one picker.
- Cyrillic falls back to a system font, and latin-ext may be missing from layout.tsx: follow-up.
- `dark` is hard-coded in layout.tsx, so the light theme is unreachable: follow-up.
- Field-sizing could let a long Profile be reviewed whole.

## Questions to Consider

- If the Profile tunes ranking, why does nothing show its effect? This screen could quote the latest Item's Rating and reasoning.
- The real constraint is cost per call. Should the counter estimate it from the Model's saved input price?
