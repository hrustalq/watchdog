# Page formats

Match what the Knowledge base already does. When a page in `docs/` differs from these templates, follow the page: these templates describe the house style as it stood when this skill was written.

## Contents

1. Frontmatter and relations
2. Glossary entries
3. ADR pages
4. Topic page changes
5. Discovery session record
6. Related pages section

## 1. Frontmatter and relations

```yaml
---
knowledge-id: <uuid>            # existing pages: never remove it; new pages: add it after the first push
tags: [<project>, <section>, <topic>]
relations:
  - { type: DESCRIBES, target: component:rule-model }
  - { type: DEPENDS_ON, target: component:agent }
---
```

- **Relation types:** `DESCRIBES`, `DEPENDS_ON`, `IMPLEMENTS`, `RELATED_TO`, `OWNED_BY`, `SUPERSEDES`, `CONTRADICTS`.
- **Entity keys** are `prefix:name`:
  - `service:`, `domain:` for systems
  - `component:`, `db:` for parts
  - `op:`, `channel:` for interfaces
  - `module:`, `file:` for code
  - `concept:` for anything else

  Reuse the keys other pages already use, and grep `docs/` for `target:` to see them. A new key is fine when the page introduces a new thing.
- **A superseding ADR** carries `{ type: SUPERSEDES, target: <same entity as the old ADR> }`.

## 2. Glossary entries

Each entry sits under the right section heading of the glossary page (Ownership, Intake, Processing, Output, Billing…, or a new section if none fits):

```markdown
**Term**: One or two sentences on what it *is*, not what it does or how it's built.
_Avoid_: Synonym one, synonym two
```

- **Be opinionated.** When several words compete, pick one, and list the rest under _Avoid_.
- **Project terms only.** Only add terms specific to this project. General programming concepts don't belong.
- **Planned terms.** A term planned but not built yet gets "Planned, not in the MVP:" at the start of its definition.

## 3. ADR pages

File: `<decisions-section>/adr-NNNN-<slug>.md`, numbered after the highest existing ADR.

```markdown
---
tags: [adr, <area>, <project>]
relations:
  - { type: DESCRIBES, target: <entity the decision governs> }
---

# ADR NNNN: <The decision, stated as a claim>

Status: accepted (YYYY-MM-DD)

<1–3 short paragraphs: the context, what was decided, and why.>

## Considered Options

- **<Alternative>**: rejected because …

## Consequences

- <Non-obvious effects downstream.>

## Related pages

- [Decisions](https://<host>/documents/<decisions-index-id>)
- [<Topic page it affects>](https://<host>/documents/<id>)
```

- **Optional sections.** Leave out *Considered Options* or *Consequences* when they add nothing. A one-paragraph ADR is fine.
- **Status values:** `proposed`, `accepted`, or `superseded by ADR NNNN (date)`.
- **Index row.** Add the ADR to the right "By area" table on the Decisions index page: `| NNNN | <decision> | accepted |`.

## 4. Topic page changes

Topic pages describe the **current design**. Change the sentences that are now wrong, rather than appending a log of changes. Mention the ADR that explains a choice in brackets, e.g. "(ADR 0014)", and add it to the page's Related pages. To point at where something was decided without an ADR, name the session and question: "(Alert Destinations session Q4)". If a page starts covering two topics, split it under its section rather than growing it.

## 5. Discovery session record

File: `<discovery-section>/<topic-slug>-session-YYYY-MM-DD.md`

```markdown
---
tags: [qa, discovery, <topic>, <project>]
relations:
  - { type: DESCRIBES, target: concept:discovery }
  - { type: RELATED_TO, target: <main entity of the topic> }
---

# <Topic> session (YYYY-MM-DD)

<One paragraph: what was grilled, what it started from, and where the results now live. "Agreed" in the tables means the user accepted the recommendation.>

## <Area, e.g. Domain>

| # | Question | Answer | Result |
| --- | --- | --- | --- |
| Q1 | <short question> | <answer, in the user's sense, condensed> | <glossary term / ADR NNNN / page name> |

## Still open after this session

- <question>: <why it's open>

## Related pages

- …
```

Add a row to the Discovery index: `| <Topic> session | YYYY-MM-DD | <one-line outcome> |`.

## 6. Related pages section

Every page ends with:

```markdown
## Related pages

- [<Page title>](https://<host>/documents/<documentId>)
```

Link the section index, the topic pages it affects, and the ADRs behind it. Keep it to what a reader would really follow next, usually 3–7 links.
