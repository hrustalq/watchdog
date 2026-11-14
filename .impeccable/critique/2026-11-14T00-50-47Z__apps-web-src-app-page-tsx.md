---
target: Feed row, the "Delivery failing" state
total_score: 33
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 0
target_identity: "file:/Users/hrustalq/Projects/watchdog-246/apps/web/src/app/page.tsx"
target_fingerprint: "sha256:5e79559244641f18788447a3e7a668754a6aab056960d77cac6b4e59b222f896"
target_path: /Users/hrustalq/Projects/watchdog-246/apps/web/src/app/page.tsx
timestamp: 2026-11-14T00-50-47Z
slug: apps-web-src-app-page-tsx
---
Method: single agent (design review and browser evidence from the same session).

Feed row, the meta line, with "Delivery failing" added before the Alerted mark (GitHub issue #246).
Scores are for the row as this change leaves it.

## Design Health Score: 33/40 (Good)

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of status | 4 | A retrying or failed Delivery is on the row, in Alarm Red, without opening the Item |
| 2 | Match with real world | 4 | "Delivery failing" is the glossary's Delivery, in the words the /destinations screen uses |
| 3 | User control | 3 | Read-only by design: the ticket leaves re-sending and cancelling out of scope |
| 4 | Consistency | 3 | Same Alarm Red as a failed Source; the Alerted mark keeps its place and its graphite |
| 5 | Error prevention | 3 | A released hold doesn't mark, so a row can't claim a failure that is only queued |
| 6 | Recognition over recall | 4 | The words say it; no legend to remember |
| 7 | Flexibility | 3 | Text, so it survives forced colours, zoom and a screen reader |
| 8 | Minimalist design | 4 | Three words, one token, no new component |
| 9 | Error recovery | 3 | Unchanged: the row leads to the Item and to /destinations |
| 10 | Help | 2 | No way from the row to the failing Delivery, which the ticket puts out of scope |

## Priority issues and what happened

- [P2] A second red lamp would read as a Rating: the row's lamp is high Severity's, and the Rating
  chips already carry red dots. Fixed by using words, as DESIGN.md's Feed row now says.
- [P3] The words sit after the Rating chips and before the Alerted mark, so the two status marks
  read in the order the user met them: told, then in trouble. Verified in the browser on a row that
  has both (`alarmBeforeBell: true`).
- Rejected: a link from the words to `/destinations`. The ticket puts re-sending and cancelling out
  of scope, and the whole row already opens the Item.

## Deterministic scan

`impeccable` is not installed in this checkout (no CLI on PATH, no dependency, and the previous
record reports the same), so the element rules were replaced by measurements taken in the same
Playwright session as the screenshots: contrast, the AX tree, and forced colours.

Measured in Chromium at 1280x900, signed in, with four rows (a retrying Delivery, a failed one, a
sent one, and one that was alerted and is now failing):

- Rows: "Delivery failing" on the retrying row, on the failed-for-good row and on the alerted one;
  absent on the row whose Delivery sent. The alerted row shows the words before the graphite Bell.
- Contrast of the words: 6.06:1 on Graphite Floor and 5.6:1 on a hovered row in dark; 5.4:1 in
  light, where a hovered row stays white. Alarm Red only; no new token.
- Accessibility tree: the row's snapshot ends `text: Severity 5 of 5 Importance 5 of 5 Delivery
  failing Release notes`, so the state is text, not an image's name.
- Forced colours (`forcedColors: active`): the words render 93x16px in CanvasText
  (`rgb(0, 0, 0)`), twice the size of any lamp, next to the source name.

## Audit: 18/20 (Good)

Accessibility 4 (text in the AX tree, 5.4:1 at worst, no colour-only meaning), Performance 4 (one
`exists` subquery in the page's single query, served by `delivery_item_id_idx`; no query per row),
Responsive 4 (the meta line already wraps, and three words add 93px), Theming 3 (existing
`alarm`/`light-alarm` tokens only), Implementation Integrity 2 (the "failing" predicate now lives
in the Feed's SQL rather than beside `deliveryStatus`, which the Item page reads).
