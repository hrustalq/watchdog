---
target: Model screen
total_score: 21
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/Users/hrustalq/Projects/watchdog/apps/web/src/app/model/page.tsx"
target_fingerprint: "sha256:034a6d35e53ff8d9c2d34e1560178ed81fc387162e18ee30441b4a0ca1a0a7b1"
target_path: /Users/hrustalq/Projects/watchdog/apps/web/src/app/model/page.tsx
timestamp: 2026-11-04T22-48-34Z
slug: apps-web-src-app-model-page-tsx
---
Method: dual-agent (A: design review agent, B: detector and browser agent)

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 2 | No "last worked" reading |
| 2 | Match with the real world | 2 | One idea has several names: base URL, address, host |
| 3 | User control | 3 | No way to clear a key on the same address, short of removing the model |
| 4 | Consistency | 3 | Close sibling of Sources |
| 5 | Error prevention | 2 | "API key (optional)" invites a failure on hosted providers |
| 6 | Recognition over recall | 2 | Base URL examples vanish when that field errors |
| 7 | Flexibility | 1 | No test before saving |
| 8 | Minimalist design | 2 | The form is always open |
| 9 | Error recovery | 2 | Focus handling is good, but the base URL message is wrong |
| 10 | Help | 2 | Good inline hints, no pointer for the structured output flag |
| Total | | 21/40 | Acceptable |

## Design Specificity Verdict

Half authored. The status card is Watchdog's own; the form could sit in any bring-your-own-LLM settings page. CLI detector: 0 findings. Browser overlay: 6 findings on /model, 2 false positives from a closed details element, 4 low-value line-length.

## Priority Issues

- [P1] The base URL error says https:// when http:// is valid, and removes the examples. Fix: correct the words and keep the examples beside the error.
- [P1] Key messages: "stays with its old address" is false, since the key is deleted; "below" can be over a phone screen away; after a refusal "Enter the key again" sits next to "Leave blank to keep". Fix: reword, and link to the field.
- [P1] Remove model button fails AA contrast: 3.30 dark, 4.11 light. Fix: solid Alarm Red with its foreground, as DESIGN.md prescribes.
- [P2] The form dominates, and field order separates the base URL from its provider. Fix: reorder. Collapsing the form is a follow-up.
- [P2] Price hints name a Usage screen that doesn't exist yet. Fix: reword.
- [P2] Checkbox 16px against a 24px floor with a 1.76 focus ring; header links have no nav; Sign out 4px above Settings on a phone. Fix: label row target, visible outline, nav landmark, wider gap.

## Persona Red Flags

- Jordan: "structured output" gives no way to find out the answer; "version path" is opaque.
- Sam: weak focus ring on the checkbox, Remove summary and breadcrumb; no nav landmark in the header.
- Casey: checkbox target, and Sign out right above Settings.

## Minor Observations

- Breadcrumb link is 20px tall, and the summary's focus ring is under 3:1. Both are shared across screens: follow-up.
- Select text is inset further than input text.
- The form doesn't know the mode, so hosted users are told about local models.

## Questions to Consider

- Should a healthy model's screen be an instrument reading, with Change tucked away?
- Why can't Test run on what's in the form, before a bad URL replaces a working model?
