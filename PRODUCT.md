# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary user: a solo developer or indie hacker running their own projects. They can't personally watch every place where something relevant to them happens: people talking about their product, competitors moving, opportunities appearing, tools they depend on changing. They want those signals collected, sorted by how much they matter, and pushed to them, instead of checking a dozen sites by hand.

## Product Purpose

Watchdog watches many heterogeneous sources, classifies what comes in, extracts what matters, rates its severity and importance, and acts on it: posting to a unified feed, pushing an alert, or calling out to other systems. Success means the user hears about the things that matter to them, ranked by importance, without monitoring the sources themselves.

What users track is open-ended. Confirmed examples:

- Mentions of and feedback about their product (bug reports, feature requests, discussion).
- Competitor and market moves (launches, pricing, changelogs, trends in their niche).
- Opportunities (leads, people asking for a tool like theirs, jobs, bounties, partnership asks).
- Ecosystem updates (releases, breaking changes, security advisories in dependencies).
- Anything else a user wants to follow: news, videos, trends, markets.

## Positioning

Open decision. What sets Watchdog apart from neighboring monitoring, alerting, and social-listening tools has not been decided. Don't invent a differentiating claim; ask before stating one.

## Operating Context

The pipeline, as the user defined it (in the original architecture diagram):

1. **Watch source.** Supported or planned source types: websites, GitHub repos and issues, RSS feeds, YouTube, Instagram feeds, X (Twitter), Telegram groups, forums, a webhook inbox, mail, and arbitrary APIs. Sources can also feed items straight to the feed.
2. **Classifier.** Sorts incoming items.
3. **Extractor rule.** Pulls the relevant data out of classified items.
4. **Agent.** Works with the classifier and the extractor. Its confirmed role is judging **severity and importance**.
5. **Action.** Fires on matched items.
6. **Feed.** The unified stream of processed items inside Watchdog.
7. **Logger.** Every stage (source, classifier, extractor, action) writes to a log, so any item's path through the pipeline can be traced.

## Capabilities and Constraints

- Actions in scope: post to the in-app feed; push an alert to an external channel (e.g. Telegram, Slack, Discord, email); call a webhook or external API.
- Not in scope as a confirmed capability: the agent drafting replies or follow-ups for approval.
- Terminology from the user's model: *watch source*, *classifier* (the user's diagram says "classificator"), *extractor rule*, *agent*, *action*, *feed*, *logger*. Use these names in the UI and in code.
- Technical baseline (existing codebase): Next.js 16 (App Router), React 19 with the React Compiler, Tailwind CSS 4, shadcn (`base-rhea` style on Base UI), lucide icons. Next.js 16 differs from older versions; check `node_modules/next/dist/docs/` before writing code.
- Open decisions: positioning; hosting model (hosted vs. self-hosted); pricing; whether the product is single-user or supports teams; how users author classifiers and extractor rules; which sources and alert channels ship first.

## Brand Commitments

Name: **Watchdog** (the user calls it "project watchdog"). No logo, voice guide, or other brand assets exist yet.

## Evidence on Hand

- Architecture diagram from the user (the source of the pipeline above; not committed to the repo).
- No users, testimonials, case studies, usage metrics, integrations list, or pricing exist. Future work must not make these up.

## Product Principles

1. **Importance over volume.** The point is the signal, not the stream. Severity and importance ratings decide what reaches the user and how loudly.
2. **Source-agnostic.** A tweet, a GitHub issue, an RSS item, and an email go through the same pipeline and land in one feed.
3. **Every decision is traceable.** The logger records every stage, so the user can always see why something was classified, extracted, rated, or acted on.
4. **Act, don't just collect.** Matched items go somewhere useful: the feed, an alert, or another system.
5. **Built for one person's attention.** Defaults assume a solo developer with limited time, not a staffed operations team.
