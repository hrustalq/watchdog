---
target: Model screen unreadable API key state
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/Users/hrustalq/Projects/watchdog/apps/web/src/app/model/page.tsx"
target_fingerprint: "sha256:a211e5354815528a0bed5215ea8b295d64108ad1ea524c3370b45556921bb2eb"
target_path: /Users/hrustalq/Projects/watchdog/apps/web/src/app/model/page.tsx
timestamp: 2026-11-05T22-01-21Z
slug: apps-web-src-app-model-page-tsx
---
Method: dual-agent (A: design review, B: detector and browser). Target: the Model screen's unreadable API key state.

## Design Health Score: 26/40, Acceptable
System status 3, Real-world match 2, Control 3, Consistency 3, Error prevention 2, Recognition 3, Flexibility 2, Minimalism 3, Error recovery 3, Help 2.

## Design specificity
Authored for this product. Alarm line is specific, recovery is generic. Detector: 0 CLI findings; overlay line-length hits are existing hint widths, 3 others are false positives from the closed Remove details.

## Priority issues
1. [P1] The field says (optional) while the alarm says it's needed, and a blank save reports "Model saved". Fix: drop the label in this state, lead the note with the instruction, say the key is still unreadable after a save.
2. [P1] Test connection is the most prominent action, can't help, and its helper is false. Fix: replace with an "Enter the key again" button.
3. [P2] Copy is worded for one audience, one recovery offered. Fix: branch on mode; self-hosted offers restoring the old value.
4. [P2] Consequence understated, and an old "A later call worked" can sit under the alarm. Fix: "new Items stay unrated", hide the failed-call line in this state.
5. [P2] The fix sits under "replaces this model" copy. Fix: change the intro in this state.

## Persona red flags
Jordan takes (optional) literally. Sam hears "API key (optional)", and at 195px the variable name overflows. Alex loses a round trip to Test.

## Minor
Variable name should be mono. ModelForm comment disagrees with blank-save behaviour.

## Questions
The Feed doesn't say why new Items are unrated while the key is unreadable. Is the Model screen enough?
