---
target: "Settings screen, a tab per section (#491)"
total_score: 37
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 0
target_identity: "file:/Users/hrustalq/Projects/watchdog/apps/web/src/app/(workspace)/settings/page.tsx"
target_fingerprint: "sha256:122dcf856e729f44fe92e2d7c50189b45ba78040e28ba2b1969a1a95fbf4285d"
target_path: /Users/hrustalq/Projects/watchdog/apps/web/src/app/(workspace)/settings/page.tsx
timestamp: 2026-11-17T18-08-00Z
slug: apps-web-src-app-workspace-settings-page-tsx
---
Method: single agent (design review and browser evidence from the same session). DEGRADED: single-context — the screen needs a signed-in dev server on localhost, which a sub-agent's browser cannot reach, so Assessment A was not isolated from Assessment B. Detector: `impeccable detect --json` on `page.tsx`, `panels.tsx`, `settings-tabs.tsx` and `settings-form.tsx` found nothing.

Settings, as #491 leaves it: the shell's full width, a strip of five tabs (four without the admin's Instance) and each tab a form of its own.

## Design Health Score: 37/40 (Excellent)
1 Visibility 4 · 2 Real world 4 · 3 Control 3 · 4 Consistency 4 · 5 Error prevention 4 · 6 Recognition 4 · 7 Efficiency 4 · 8 Minimalism 3 · 9 Recovery 4 · 10 Help 3

## Design Specificity
Tabs named by what a save affects are a known pattern; the composition is specific because the grouping follows Watchdog's own model (quiet hours and pacing are delivery, the two windows are retention, Source Health is its own setting) and every panel keeps the project's copy. The current tab uses the same Instrument Well the sidebar marks a section with, so the strip reads as part of the same instrument rather than a second navigation system.

## Measured (Playwright, signed in)
- Content column at 1440: 1184px, `max-width: none` — the 42rem (672px) strip is gone.
- Panels: 3 x 368px at 1440, 2 x 352px then a second row at 1024, 1 x 358px at 390. No page overflow at any width.
- Strip at 390: `scrollWidth > clientWidth` with every link on one row (32px), so it scrolls instead of wrapping.
- Keyboard: sidebar, account menu, crumb, then the five tab links in order, then the open panel's fields; `aria-current="page"` on the open tab only.
- After a save with JavaScript on, focus lands on the saved notice; after a refusal it lands on the first field to fix, which holds the posted value.

## Priority issues (and what was done here)
- [P2] The timezone suggestion said "Save settings to keep it.", but that button is now "Save delivery". FIXED.
- [P3] Leaving a tab with typed edits discards them without a word. Every form in the app behaves this way on navigation, and a guard needs script; NOT DONE, a follow-up if the user wants it.
- [P3] At 1024 the third Delivery panel wraps and leaves one empty cell. Stretching a two-field panel to fill it reads worse; accepted.
- [P3] The Workspace tab is mostly empty until #492 brings the rename; the name and Delete Workspace are what #491 asks for.
- [P3] The phone strip's only cue that it scrolls is a clipped last label; that is the conventional cue and reads correctly in the 390px capture.

## Minor
The `role="status"` zone suggestion is a second live region on the Delivery tab, so a screen reader hears the saved notice and the zone offer together; unchanged from before this issue.
