---
target_identity: "file:/Users/hrustalq/Projects/watchdog/apps/web/src/app/destinations/page.tsx"
target_fingerprint: "sha256:8be78fdd8d863290677451267f26eb11697f99181041f22cf9f6f4f08b1e1a17"
target_path: /Users/hrustalq/Projects/watchdog/apps/web/src/app/destinations/page.tsx
timestamp: 2026-11-07T00-17-13Z
slug: apps-web-src-app-destinations-page-tsx
---
# Critique: Destinations screen and its confirm page (#197)

Assessments ran as two isolated sub-agents. Browser overlay skipped, because the screen needs a sign-in the agents didn't have; screenshots from a Playwright walk stood in. Detector: 0 findings. Design heuristics 25/40. Audit 16/20.

## Fixed
- One-time secret now a labelled read-only textarea, reachable and copyable by keyboard, naming the signature header; a reload says it was already shown.
- No green lamp on a row whose last delivery failed.
- Confirm page names the address, refuses a dead link on arrival, announces its result, and has a neutral title.
- Add rows keep their disclosure marker and form one exclusive group; add section moved above the list, as on Sources.
- Field error scrolled into view after a redirect; visible focus border on summaries; long names wrap; screen-reader names on repeated row controls; autocomplete hints.
- A refused webhook URL no longer travels in the query string.

## Not fixed here
- destructive/20 button contrast (3.32:1 on muted) and 32px phone targets: repo-wide and specified by DESIGN.md.
- "Used by" Action names on rows and a "last delivered" reading: belong with #200 and #202.
- Copy button for the secret: the textarea covers it without JavaScript.
