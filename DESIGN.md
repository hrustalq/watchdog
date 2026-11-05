---
name: Watchdog
description: Watches many sources, rates what matters, and shows the signal.
colors:
  background: "oklch(0.1730 0 0)"
  foreground: "oklch(0.9851 0 0)"
  card: "oklch(0.2134 0 0)"
  popover: "oklch(0.2562 0 0)"
  primary: "oklch(0.9219 0 0)"
  primary-foreground: "oklch(0.1730 0 0)"
  secondary: "oklch(0.2850 0 0)"
  muted: "oklch(0.2850 0 0)"
  muted-foreground: "oklch(0.7187 0 0)"
  accent: "oklch(0.3211 0 0)"
  border: "oklch(0.3012 0 0)"
  input: "oklch(0.3211 0 0)"
  ring: "oklch(0.7187 0 0)"
  alarm: "oklch(0.6600 0.2150 27.0000)"
  alarm-foreground: "oklch(0.1448 0 0)"
  caution: "oklch(0.8190 0.1496 84.9468)"
  ok: "oklch(0.7499 0.1506 149.9295)"
  chart-1: "oklch(0.6997 0.1498 249.9296)"
  chart-2: "oklch(0.6796 0.2001 310.2489)"
  light-background: "oklch(1.0000 0 0)"
  light-foreground: "oklch(0.1448 0 0)"
  light-primary: "oklch(0.2050 0 0)"
  light-muted: "oklch(0.9612 0 0)"
  light-muted-foreground: "oklch(0.4495 0 0)"
  light-border: "oklch(0.9158 0 0)"
  light-ring: "oklch(0.5555 0 0)"
  light-alarm: "oklch(0.5500 0.2100 28.0000)"
  light-caution: "oklch(0.5600 0.1200 65.0000)"
  light-ok: "oklch(0.5300 0.1300 150.0000)"
typography:
  headline:
    fontFamily: "Recursive, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.02em"
    fontVariation: "\"MONO\" 0"
  title:
    fontFamily: "Recursive, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-0.01em"
    fontVariation: "\"MONO\" 0"
  reading:
    fontFamily: "Recursive, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
    fontVariation: "\"MONO\" 0"
  body:
    fontFamily: "Recursive, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
    fontVariation: "\"MONO\" 0"
  control:
    fontFamily: "Recursive, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.25
    fontVariation: "\"MONO\" 0"
  label:
    fontFamily: "Recursive, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.35
    letterSpacing: "0.01em"
    fontVariation: "\"MONO\" 0"
  data:
    fontFamily: "Recursive, ui-monospace, SFMono-Regular, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "\"tnum\", \"zero\""
    fontVariation: "\"MONO\" 1"
rounded:
  sm: "0.3rem"
  md: "0.4rem"
  lg: "0.5rem"
  xl: "0.7rem"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "6": "24px"
  "8": "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.lg}"
    height: "32px"
    padding: "0 12px"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.lg}"
    height: "32px"
    padding: "0 12px"
  button-outline-hover:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.lg}"
    height: "32px"
    padding: "0 12px"
  button-ghost-hover:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
  button-destructive:
    textColor: "{colors.alarm}"
    typography: "{typography.control}"
    rounded: "{rounded.lg}"
    height: "32px"
    padding: "0 12px"
---

# Design System: Watchdog

## Overview

**Creative North Star: "The Signal Room"**

Watchdog is an instrument panel for one person keeping watch over many sources. Every surface works like professional equipment: precise, dense, labelled, and readable at a glance. The room is dark and quiet by default. Achromatic surfaces, hairline borders and steady type set a calm baseline, so the few things that light up actually mean something. Color is a reading, not decoration: red means look now, amber means look soon, green means healthy, and everything else is ink on graphite.

The system is built on the project's shadcn/ui theme (`apps/web/src/app/globals.css`, style `base-rhea`, Base UI primitives) and keeps its token names and structure. Dark is the default and the reference theme; light is derived from it and kept for parity. The 2D chrome (panels, feed, inputs, buttons) is flat and tonal. Real depth belongs to one place only: the three.js pipeline scene, where sources, classifiers, extractor rules and actions sit in space and items flow between them.

Density is compact (32px controls, 4px grid) because the job is scanning many items quickly. Type comes from a single variable family, Recursive, whose MONO axis switches between the UI voice and the data voice, so labels and readings always look like the same instrument.

**Key Characteristics:**
- Dark-first, achromatic graphite surfaces with hairline borders.
- Red is reserved for alarms and errors; it never decorates or brands.
- Primary actions are neutral ink, not color.
- One type family (Recursive): sans for interface, mono for data, switched by axis.
- Flat 2D chrome; depth lives only in the 3D pipeline scene and floating overlays.
- Crisp corners (0.5rem), compact controls (32px), 4px rhythm.

## Colors

A graphite instrument panel: achromatic neutrals carry the whole interface, and four signal hues appear only when they report something.

### Primary
- **Panel Ink** (`primary`; light: `light-primary`): The primary action color. Near-white on dark, near-black on light. Used for the one main action in a region (save rule, add source, run test), the selected state of segmented controls, and the selected node outline in the 3D scene. It is ink, not a brand hue, so primary actions never compete with signals.

### Neutral
- **Graphite Floor** (`background`): The app background and the 3D scene's clear color. The darkest plane; everything else sits on it.
- **Raised Graphite** (`card`): Panels, feed rows on hover or expanded, inspector sheets, node slabs in the scene.
- **Overlay Graphite** (`popover`): Menus, popovers, command palette, tooltips; the only surfaces that also get a shadow.
- **Instrument Well** (`secondary` / `muted`): Inset wells, secondary buttons, input fills, code and log blocks, skeletons.
- **Pressed Graphite** (`accent`, `input`): Hover/pressed fill for ghost controls and the input border.
- **Hairline** (`border`): All dividers, panel edges, table rules, and edges between nodes in the scene. 1px only.
- **Readout White** (`foreground`): Primary text and icons.
- **Dimmed Readout** (`muted-foreground`): Metadata, timestamps, secondary labels, placeholder text, low-severity items. Passes 4.5:1 on every dark surface (7.05:1 on card).
- **Focus Grey** (`ring`): Keyboard focus border and the 30% focus halo. Neutral on purpose; focus is never red.

### Signal (severity and health)
- **Alarm Red** (`alarm`; light: `light-alarm`): High severity and critical items, firing alerts, failed sources or actions, errors, invalid fields, destructive confirmations. Text-safe on every surface in both themes (dark ≥4.57:1 on popover, light 5.4:1 on white). Solid fills use `alarm-foreground` (near-black in dark, white in light). `destructive` is set to the same value: there is exactly one red per theme.
- **Caution Amber** (`caution`; light: `light-caution`): Medium severity, degraded or rate-limited sources, items waiting for review.
- **Healthy Green** (`ok`; light: `light-ok`): Source connected, action succeeded, test passed. Shown sparingly, mostly as small status lamps; healthy is the expected state and should not shout.

### Data visualization
- **Chart series** (`chart-1` blue, `chart-2` violet, then `chart-3` green, `chart-4` amber, `chart-5` neutral): Categorical series only (per source, per classifier). Red was moved out of `chart-1`. When a chart encodes severity, use the signal tokens instead of chart tokens.

### Named Rules
**The Red Means Now Rule.** Alarm Red appears only where something needs attention: high severity, a firing alert, a failure, an error, or a destructive confirmation. It is never used for branding, primary buttons, links, focus, selection, decoration, or a chart's default series. If a screen is red with nothing wrong, the screen is wrong.

**The Graphite Baseline Rule.** On a healthy screen the only color is from content (avatars, thumbnails from sources) and small status lamps. A calm screen is the correct reading of a calm world.

**The One Red Rule.** Each theme has one red: `alarm` and `destructive` share a value. Never introduce a second red, orange-red, or pink to make something feel urgent.

## Typography

**Interface Font:** Recursive at MONO 0 (fallback: ui-sans-serif, system-ui)
**Data Font:** Recursive at MONO 1 (fallback: ui-monospace, SFMono-Regular)

**Character:** One variable family with a sans-to-mono axis, so interface text and readings come from the same instrument. The sans is straightforward and sturdy at small sizes. The mono is reserved for real data: logs, extracted fields, rule expressions, scores, IDs and timestamps. Loaded once through `next/font` with `axes: ["MONO"]` and exposed as `--font-recursive`. Tailwind's `font-sans` and `font-mono` switch the axis automatically.

### Hierarchy
- **Headline** (650, 1.5rem, 1.2, -0.02em): Page titles: Feed, Sources, Pipeline, Logs. One per view.
- **Title** (600, 1rem, 1.35, -0.01em): Panel headers, node names, feed item titles, dialog titles.
- **Reading** (400, 1rem, 1.6): Expanded item content and excerpts from sources. Max 70ch.
- **Body** (400, 0.875rem, 1.5): The default for dense interface text: feed rows, table cells, form help, descriptions.
- **Control** (500, 0.875rem, 1.25): Buttons, tabs, menu items, segmented controls.
- **Label** (500, 0.75rem, 1.35, +0.01em, sentence case): Field labels, column headers, metadata lines, badge text, 3D node captions.
- **Data** (400, 0.8125rem, 1.5, MONO 1, tabular + slashed zero): Log lines, extracted key/value pairs, rule and classifier expressions, severity scores, timestamps, IDs, counts.

### Named Rules
**The Mono Is Data Rule.** Monospace (MONO 1) is used only for content that is data: a log line, an extracted value, an expression, a score, a timestamp, an identifier. Never use it for headings, buttons, or to make a screen look technical.

**The Tabular Readings Rule.** Every number that changes or gets compared (counts, scores, durations, timestamps) is tabular so readings don't jitter. The base stylesheet already makes `font-mono`, `code`, `pre`, `kbd` and `samp` tabular with slashed zero; add `tabular-nums` when numbers are set in the sans.

## Layout

No product screens exist yet; this section sets the spatial grammar, and should be refreshed once the first screens ship.

- **Grid and rhythm:** 4px base unit (`--spacing: 0.25rem`). Tight groups use 4–8px, related controls 8–12px, sections 24–32px. More space above a heading than below it.
- **Density:** Compact. Controls are 32px (`h-8`; 24/28/36px for xs/sm/lg). Feed rows and table rows stay single-purpose and scannable; expanded detail opens in place or in an inspector, not in a modal.
- **App shell (provisional):** Sidebar navigation (the shadcn `sidebar` tokens are already defined) plus a main region. The pipeline scene takes the full main region edge to edge, with 2D panels (inspector, toolbar, legend) docked over it on graphite surfaces.
- **Reading measure:** Item content and excerpts cap at 70ch even in wide layouts.
- **Responsive (provisional):** Tailwind's default breakpoints (640 / 768 / 1024 / 1280 / 1536px). The feed must work at phone width. The 3D editor is designed for desktop widths; below `lg` the pipeline is shown as a 2D ordered list of stages with the same data.

## Elevation & Depth

The 2D interface is flat. Surfaces separate by tone (Graphite Floor → Raised Graphite → Overlay Graphite) and by 1px hairlines, not by shadow. Shadows exist only on surfaces that actually float above the work: popovers, menus, dialogs, toasts, and HUD panels docked over the 3D scene. Real spatial depth is the 3D pipeline scene's job.

### Shadow Vocabulary
- **Float** (`shadow-md`; dark `0 1px 8px -1px hsl(231 47% 3% / 0.35), 0 2px 4px -2px hsl(231 47% 3% / 0.35)`): Popovers, menus, tooltips, HUD panels over the scene.
- **Lift** (`shadow-xl`): Dialogs and the command palette.
- Rest of the scale (`shadow-2xs` … `shadow-2xl`) stays in the theme for shadcn components but isn't used on resting surfaces.

### The Pipeline Scene (3D)
Provisional until the first scene ships; refresh this document afterwards.

The pipeline scene is a three.js view (React Three Fiber is the expected binding) with two modes in one scene: **Edit** (place and wire sources, classifiers, extractor rules, actions) and **Live** (watch items flow through the configured pipeline).

- **Space:** Clear color = `background`. Low-FOV perspective or orthographic camera so stages read like a diagram, not a game world. Edit mode shows a faint hairline grid floor in `border`; Live mode fades it out.
- **Nodes:** Matte slabs in `card`, edges in `border`, with stage type identified by a lucide-style glyph and a Label-style caption. Materials are matte (high roughness, no metalness): an instrument, not a toy.
- **Wires:** 1px-weight lines in `border`; when Live, flowing items are small points moving along wires in `muted-foreground`.
- **Signal in 3D:** Items rated medium glow in `caution`; items rated high and failing nodes glow in `alarm` (emissive). These are the only emissive or bloom-like effects in the scene. A healthy pipeline in Live mode is graphite with dim moving points.
- **Selection:** The selected node gets a `primary` (Panel Ink) outline and its settings open in the docked inspector. Never red, never a glow.
- **Text:** All text uses Recursive, either as DOM overlays or SDF text, never bitmap textures. Labels stay screen-aligned and legible at every zoom.
- **Lighting:** One soft key light plus ambient. No colored lights; color in the scene comes only from signal tokens.
- **Motion:** Item flow is the scene's one authored motion. Camera moves ease out exponentially and are user-initiated. With `prefers-reduced-motion`, flow becomes per-wire counts and camera moves cut instead of animate.
- **Fallback:** No WebGL or a narrow viewport → the 2D stage list with the same data and actions.
- **Tokens:** The scene reads colors from the CSS custom properties at runtime (and re-reads them on theme change) instead of hard-coding values.

### Named Rules
**The Flat Chrome Rule.** Resting 2D surfaces never carry a shadow. If something has a shadow, it is floating over the work right now.

**The One Deep Place Rule.** Perspective, lighting and depth happen inside the pipeline scene only. Don't fake 3D in the 2D chrome (tilted cards, parallax, glass panels).

## Shapes

Crisp and engineered. One radius family derived from `--radius: 0.5rem`, identical in both themes.

- **sm** (0.3rem): Badges, severity chips, checkboxes, keyboard hints.
- **md** (0.4rem): Inputs inside dense tables, small toggles, menu items.
- **lg** (0.5rem): Buttons, inputs, cards, panels, popovers: the default.
- **xl** (0.7rem): Dialogs and large sheets only.
- **Borders:** 1px hairlines everywhere. Status is shown by small round lamps (6–8px dots) and tinted chips, never by thick colored edges.
- **3D nodes** use the same language: slabs with softly beveled corners echoing `lg`, never spheres or organic blobs.

## Components

The Button (`apps/web/src/components/ui/button.tsx`, Base UI + cva) and the chips below exist in code. Other components follow this character as they are added from shadcn.

### Buttons
Character: precise and quiet; the action is clear from the label and position, not loud color.
- **Shape:** Crisp corners (0.5rem, `rounded-lg`), 1px transparent border, 32px tall by default.
- **Primary:** Panel Ink fill with graphite text, 0 12px padding, Control type. Hover drops to 80% fill.
- **Outline:** Graphite Floor fill with a hairline border (transparent fill in dark); hover fills with Instrument Well.
- **Secondary:** Instrument Well fill; hover mixes 5% foreground into it.
- **Ghost:** No fill; hover fills with Instrument Well (50% in dark).
- **Destructive:** Alarm Red text on a 10% (dark 20%) red tint, never a solid red slab; hover deepens the tint. Used only to confirm deleting or disabling something.
- **Focus:** Border switches to Focus Grey with a 3px halo at 30%. Pressed state nudges down 1px. Disabled: 50% opacity, no pointer events. Invalid: red border with a red halo.
- **Sizes:** xs 24px, sm 28px, default 32px, lg 36px; matching square icon sizes.

### Rating chips (`apps/web/src/components/rating.tsx`)
- **Severity:** `rounded-sm`, Label type, the word, the level and the scale ("Severity 4/5"), with the level in Data type. High (4–5): Alarm Red text on a 10% red tint with a solid 6px Alarm Red lamp. Medium (3): same pattern in Caution Amber. Low (1–2): Dimmed Readout text, no tint, hollow lamp. The tint stays at 10% because 15% drops Alarm Red below 4.5:1 on a hovered row.
- **Importance:** Same shape and words, with no lamp, no fill and no signal color, because it says what matters and not that something is wrong. High (4–5): Readout White. Otherwise: Dimmed Readout.
- **Unrated:** The word on a dashed hairline, with no number and no lamp, so it can't read as an error or a low score.
- **Rule:** The word, the level and the scale always appear together, and screen readers hear "Severity 4 of 5", so a Rating never relies on color alone. In forced colors a filled lamp is drawn in `CanvasText`, so it doesn't vanish.

### Category chip (`apps/web/src/components/rating.tsx`)
- **Style:** `rounded-sm`, hairline border, Data type at 0.75rem, no fill. Categories are open-ended, so they get no signal or chart color.

### Correction controls (`apps/web/src/app/correct-rating.tsx`, `apps/web/src/app/items/[id]/correct-categories.tsx`)
- **Feed row:** plain chips by default, because a Correction is rare and a row is for scanning. "Correct Ratings" next to Top and Latest turns on editing mode, which is in the URL (`?edit=1`), and "Done" turns it off. In editing mode each chip sits between two 24px ghost buttons, a level down and a level up. A row gets four buttons rather than the whole scale, because each is a tab stop. At either end of the scale the button stays focusable and inert, with only its glyph dimmed, so reaching the end loses neither focus nor the focus ring. An unrated row shows a "Rate" link to the Item instead.
- **Item:** always shows its controls. A rated Item has the whole scale on each axis as 24px buttons, one click to any level, with the current level in Panel Ink. An unrated Item has two selects and "Save Rating", because a Rating has both axes and a guess at the other one would be taught to the Agent as the user's judgement. Each Category chip has its own remove button, and a text box adds one.
- **States:** a form dims to 60% while it saves. A screen reader hears "Saving the Correction" and then the resulting state, such as "Now Severity 4 of 5, Importance 3 of 5". When rows move, the list ignores clicks for 500ms, so a repeat click can't land on a different Item. All of it works without JavaScript.

### Feed row
- **Style:** Flat on Graphite Floor, hairline between rows, Raised Graphite on hover. Layout: Title with the timestamp in Data type right-aligned; then the summary, or the excerpt until there is one, up to two lines; then the Rating chips with their Correction controls, Categories, Source and Backfill. A source glyph before the Title is still to build.
- **States:** Unread (still to build) is shown by weight (Title 600 vs 500), not by color. High-severity rows add the lamp only; the row background never turns red.

### Inputs / Fields (to build)
- **Style:** 32px, `rounded-lg`, Instrument Well or transparent fill, 1px `input` border.
- **Focus:** Same as buttons (Focus Grey border + 30% halo).
- **Error:** Alarm Red border and halo, with an error message in Label type that names the problem and the fix.
- **Expressions:** Classifier and extractor rule editors use Data type (MONO 1).

## Do's and Don'ts

### Do:
- **Do** keep Alarm Red (`alarm` / `destructive`) for high severity, firing alerts, failures, errors and destructive confirmations only.
- **Do** use Panel Ink (`primary`) for the single main action per region and for selection, including in the 3D scene.
- **Do** separate 2D surfaces by tone and 1px hairlines; reserve `shadow-md` / `shadow-xl` for floating overlays.
- **Do** set every data reading (log, extracted value, score, timestamp, ID) in Data type (`font-mono`, MONO 1, tabular).
- **Do** pair every severity color with a word or a lamp shape, so meaning never depends on color alone.
- **Do** keep controls at 32px and the 4px rhythm; dense, but never cramped below 24px hit targets.
- **Do** read 3D scene colors from the CSS custom properties so both themes stay in sync.
- **Do** respect `prefers-reduced-motion` in the scene (flow → counts) and provide the 2D stage-list fallback.

### Don't:
- **Don't** use red for brand, buttons, links, focus rings, selection, decoration, or the first chart series.
- **Don't** load another font family. Recursive covers interface and data; the old Inter, Geist, Roboto, Pretendard and JetBrains Mono references were removed deliberately.
- **Don't** use monospace as a costume on headings, buttons, or marketing-style labels.
- **Don't** put shadows on resting panels, cards or feed rows.
- **Don't** fake depth in the 2D chrome (glass, tilt, parallax); depth lives in the pipeline scene.
- **Don't** use thick colored side borders on rows, cards or alerts; use lamps and tinted chips.
- **Don't** add colored lights, bloom or emissive glow in the scene except for caution and alarm signals.
- **Don't** mix radii: buttons, inputs, cards and panels all use `rounded-lg` (0.5rem).
