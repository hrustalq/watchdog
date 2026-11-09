---
target: "Feed screen: Top/Latest control and fallback notice"
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/Users/hrustalq/Projects/watchdog/apps/web/src/app/page.tsx"
target_fingerprint: "sha256:02bfee7b31c715d4255f0b2764ff3e494d698db13db403d44952d6e84bfa86ca"
target_path: /Users/hrustalq/Projects/watchdog/apps/web/src/app/page.tsx
timestamp: 2026-11-05T15-46-56Z
slug: apps-web-src-app-page-tsx
---
Method: dual-agent (design review, detector and browser evidence)

## Design health: 25/40, Acceptable

1 Visibility 2, 2 Real world 3, 3 Control 3, 4 Consistency 3, 5 Error prevention 2, 6 Recognition 3,
7 Flexibility 2, 8 Minimalism 3, 9 Recovery 2, 10 Help 2.

Design specificity: authored, in Glossary language, on a generic pattern that suits the surface.
Detector: 0 findings in the CLI and in the browser overlay on `/` and `/?view=latest`.

## Priority issues

- [P1] The fallback notice promises Ratings that won't arrive: a first model never rates existing
  Items (`classify.ts`). Fix: "Add a model to rate new Items", and drop "yet".
- [P1] In forced colors, Top and Latest look identical. Fix: Highlight on the selected view.
- [P2] "most important first" misstates the rank. Fix: "ranked by Importance and Severity".
- [P2] The back link duplicates the selected view and makes the control jump. Fix: caption slot.
- [P2] The notice box reads as a Feed row. Fix: caption slot.

## Kept, as follow-ups

- [P1] One new Rating shrinks Top to one row, and new unrated Items never show in the default view.
  The issue specifies this.
- [P2] The Item breadcrumb "Feed" links to `/`, so a Latest reader lands on Top.
