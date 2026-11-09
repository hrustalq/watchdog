---
target: Workspace header phone-width menu
total_score: 17
max_score: 32
na_heuristics: 9,10
p0_count: 0
p1_count: 2
target_identity: "file:/Users/hrustalq/Projects/watchdog/apps/web/src/app/header-menu.tsx"
target_fingerprint: "sha256:31943ebd321820fdbf24df2b4b7ac6fc307f08b15ffc81608fdc8c64728aaeaa"
target_path: /Users/hrustalq/Projects/watchdog/apps/web/src/app/header-menu.tsx
timestamp: 2026-11-05T20-56-30Z
slug: apps-web-src-app-header-menu-tsx
---
Method: dual-agent (A and B ran as isolated sub-agents). Run as a ship-feature gate for #117.

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 2 | Open state is only a muted fill; panel unchanged during a slow navigation |
| 2 | Match with the real world | 3 | "Profile" next to "Settings" reads as an account page |
| 3 | User control and freedom | 1 | Only the toggle or leaving closes it |
| 4 | Consistency and standards | 2 | Looks like a dropdown, behaves like an in-flow disclosure |
| 5 | Error prevention | 2 | Sign out 8px from Menu, no confirmation |
| 6 | Recognition over recall | 3 | Spelled-out labels, hidden until opened |
| 7 | Flexibility and efficiency | 1 | Two taps to anything |
| 8 | Aesthetic and minimalist design | 3 | Rarest action has the most visual weight |
| 9 | Error recovery | n/a | No error state in the header |
| 10 | Help and documentation | n/a | A six-link nav shouldn't carry help |
| Total | | 17/32 | Acceptable |

Technical audit: 16/20 (accessibility 2, performance 4, responsive 2, theming 4, integrity 4).

## Design Specificity Verdict

On-system, not distinctive. CLI detector: 0 findings. Browser detector: text-occlusion on Top with the menu open (true positive); dark-glow on body (false positive, the detector's own overlay colour).

## Priority Issues

1. [P1] Text zoom pushes the panel past the left edge from 150%; at 200%, 5 of 6 links have 0px visible and can't be scrolled to (WCAG 1.4.4). Anchor to the header's right edge, cap width to the viewport.
2. [P1] Only the toggle or leaving dismisses it. Close on Escape, on a press outside, and when focus moves outside.
3. [P2] Panel covers 33 of Top's 50px and Top takes focus 66% hidden. Dismissal handles it.
4. [P2] Inverted hierarchy, Sign out 8px from Menu. Move Sign out into the panel below md.
5. [P2] No navigation landmark while closed. Wrap the disclosure in the nav.

## Persona Red Flags

Sam: Escape does nothing, Tab walks out with the panel open, no landmark while closed. Casey: tapping away fails silently, Sign out next to Menu. Alex: two taps per destination, header scrolls away (pre-existing).

## Minor Observations

32px rows follow DESIGN.md's app-wide density and clear WCAG 2.5.8. No chevron, fill dims on hover, forced colors drop the fill. Menu rows use rounded-lg where DESIGN.md names md. Panel stays up during a slow navigation.

## Questions to Consider

In-flow panel instead of an overlay? A lamp on a closed Menu when a Source is failing?
