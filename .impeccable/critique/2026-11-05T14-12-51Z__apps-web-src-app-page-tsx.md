---
target: Feed and Item detail for issue 92
total_score: 19
max_score: 36
na_heuristics: 5
p0_count: 0
p1_count: 3
target_identity: "file:/Users/hrustalq/Projects/watchdog/apps/web/src/app/page.tsx"
target_fingerprint: "sha256:48b75bcd6685b3f299a968eebb7b4872d5cabc876664dd8b1ec4192c4aaa3b6c"
target_path: /Users/hrustalq/Projects/watchdog/apps/web/src/app/page.tsx
timestamp: 2026-11-05T14-12-51Z
slug: apps-web-src-app-page-tsx
---
Method: dual-agent (A: design review, B: detector and audit evidence). Run as a ship-feature gate for issue 92.

## Design health: 19/36 (53%, Acceptable), heuristic 5 n/a (read-only display)
1 Status 2: the Feed's Unrated doesn't separate waiting from failed. 2 Real world 2: "Severity 1" reads as SEV-1.
3 Control 3. 4 Consistency 3: Backfill shared the high-Importance fill. 6 Recognition 2: the scale's range was invisible.
7 Flexibility 1: no row shortcuts (pre-existing). 8 Minimalism 3: metadata line noisy on a phone.
9 Recovery 2: the Log names a 401 but gives no route to the fix. 10 Help 1: nothing explains the scale.

## Specificity
Authored for this product. Detector: 0 findings in rating.tsx, page.tsx and items/[id]/page.tsx; overlay reported no anti-patterns.

## Priority issues (all fixed in the same PR)
- P1 Scale direction relied on colour: show /5 visibly.
- P1 "The Log says why." was dead text: link to #log.
- P1 Severity 4-5 was 4.34:1 on a hovered row: 10% tint, now 4.64:1.
- P2 Filled lamps vanished in forced colours: draw them in CanvasText.
- P2 Metadata line: drop Importance's fill; order Rating, Categories, Source, Backfill.
- P2 Screen-reader triage: aria-describedby on the row link; each reading one phrase.

## Left open
- Light theme (not reachable by users) keeps medium Severity near 4.2:1.
- With a failing model every Item says Unrated, and the Feed gives no hint why.
- The Item page has no refresher, so its pipeline note can go stale.
- Pre-existing: raw validation text in Log messages, failure rows look like successes, no row keyboard shortcuts.
