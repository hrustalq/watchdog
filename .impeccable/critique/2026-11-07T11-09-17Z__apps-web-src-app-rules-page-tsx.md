---
target: Rules screen Actions
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/Users/hrustalq/Projects/watchdog/apps/web/src/app/rules/page.tsx"
target_fingerprint: "sha256:aba826db7a2fd9ff5f6227d7288d6c01d310a07438e86e3ae1ff8e8713df476e"
target_path: /Users/hrustalq/Projects/watchdog/apps/web/src/app/rules/page.tsx
timestamp: 2026-11-07T11-09-17Z
slug: apps-web-src-app-rules-page-tsx
---
Method: dual-agent (A and B isolated). Rules screen Actions, issue #200.

Design health 26/40 (Acceptable). Audit 16/20 (Good). Detector: 0 in source; overlay 14 on /rules and the form, of which 9 false positives (closed confirmation panel) and line-length genuine.

Priority issues and outcome:
- [P1] Condition values can silently never match: fixed with a 1 to 5 hint and a schema refusal. Category list is a follow-up.
- [P1] Digest demands raw cron: timezone named, schedule shown on the row; presets are a follow-up.
- [P1] Non-delivery looks healthy: fixed with a Caution lamp and full-strength text.
- [P2] Unconfirmed notice far away and unannounced: moved beside Destinations in a status region.
- [P2] Weak way out with no Destinations: outline button when none exist.
