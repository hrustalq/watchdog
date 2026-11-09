---
target: Telegram add form and link panel on Destinations
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/Users/hrustalq/Projects/watchdog/apps/web/src/app/destinations/page.tsx"
target_fingerprint: "sha256:8fafeb61693fbd5ae3cc83db0e13998a68f7218a81e3e88fa16f427d521b4c68"
target_path: /Users/hrustalq/Projects/watchdog/apps/web/src/app/destinations/page.tsx
timestamp: 2026-11-07T17-58-12Z
slug: apps-web-src-app-destinations-page-tsx
---
Method: dual-agent (A: design review, B: detector and audit). Score is from before the fixes below.

Design health 25/40 (Acceptable). Audit 15/20 (Good). Detector: 0 findings.

Priority issues, all fixed on the branch:
- [P1] The command box clipped the code on a phone: field-sizing-content with rows={2} (60/60 at 375 px).
- [P1] A reload had two silent outcomes: an "is linked" notice, and a line on a waiting row with no live link.
- [P2] The panel's order and copy: deadline, routes, then what to do next, with the group link out of the label.
- [P2] "Get a new link" replacing the live link unannounced: the panel says so, and a new code re-announces.
- [P2] The add form didn't say what comes next: a line above the button, and its own placeholder.

Left as is: 32 px controls (DESIGN.md's density), "Waiting for the bot" (the issue's word), shared border tokens under 3:1 (pre-existing), relinking a confirmed row (follow-up).
