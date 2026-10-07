# Uptime design system

This folder is the source of truth for how the Uptime admin looks, reads and behaves. Read it before any UI work in `apps/web`.

| File | What it covers |
| --- | --- |
| `README.md` | Principles, voice, colour, type, regions, spacing, states, iconography |
| [`admin-layout.md`](admin-layout.md) | Screen anatomy: shell, monitors board, monitor detail, form, status pages, notifications |
| [`tokens.json`](tokens.json) | Every colour (light and dark), type style, spacing step, radius and shadow, each with a usage note |
| [`components/`](components/) | One guideline per component, plus [`reference.css`](components/reference.css), the reference implementation used by the previews |

A browsable version with live component previews is published at <https://claude.ai/artifact/2dosjxEbr2UVjmh9ddHeVK>. It is visible only to people it has been shared with.

## Rules for agents

- Use tokens, never literal colours, font sizes, spacing or radii. Token names in this folder map to CSS custom properties (`ink` → `var(--ink)`, `space-4` → `var(--space-4)`).
- Match the component guidelines in `components/` when you build or change a component. If a screen needs something not covered here, follow the closest component and say so in your change summary.
- Follow the voice rules for every string you add or change.

## Keeping the copies in sync

Edit this folder first, then republish the artifact from it. Never edit the artifact alone: changes made only there are lost the next time it is republished from the repo.

---

Uptime is a quiet instrument. It checks every monitor once a minute from nine regions and tells one person, fast, what is broken and where. The admin is a working surface for that person: dense, calm when everything is up, and impossible to misread when something is down. Colour is reserved for state. Everything else is ink on graph paper.

Nine regions, every minute.

## Principles

- **State first, decoration never.** The only saturated colours on a resting screen are `up`, `degraded` and `down`. If nothing is broken, the screen should look almost monochrome.
- **Shape carries state, colour confirms it.** Up is a circle, degraded a triangle, down a square, no data a ring. A person who cannot tell green from red still reads the board.
- **Numbers are evidence.** Latency, uptime and timestamps are set in `mono` with tabular figures and always carry a unit (`142 ms`, `99.98%`, `14:03 UTC`).
- **One brand hue.** `accent` marks what you can act on and where you are: links, quiet buttons, the selected navigation item, focus. It never means a status.
- **Borders, not shadows.** Panels are separated by `rule` hairlines on `paper`. Only things that float above the page (dialogs, open menus, the command palette) take `shadow-overlay`. The one exception is controls: things you press take `shadow-control`, things you type into take `shadow-inset`.

## Voice

Write as a calm operator talking to another operator. Short, literal sentences. Name things the way the person sees them: *monitor*, *region*, *status page*, *notification*. Not *probe*, *cohort*, *lease* or *job*.

- Sentence case everywhere, including buttons and page titles: "Add monitor", "Status pages".
- Buttons say what happens: "Save monitor", "Delete history", "Send test notification". The toast echoes it: "Monitor saved."
- Errors say what to do: "Select at least one region before saving." Not "Invalid configuration".
- Empty states name what will appear and how to add the first one: "No status pages yet. Group monitors into a public page your users can bookmark."
- "We" only on the public side. The admin addresses "you" sparingly and mostly not at all.
- No emoji. No exclamation marks. Times are UTC unless the person chooses otherwise, and the label says which.

## Colour

- Page ground is `paper`. Panels, tables and inputs are `surface`. The side navigation, table headers and hovered rows are `sunken`.
- Body text is `ink`; secondary cells `ink-soft`; hints, URLs and axis labels `muted`.
- Primary buttons are filled with `ink` and lettered in `paper`. There is at most one primary button per view.
- Status pairs: `up` on `up-tint`, `degraded` on `degraded-tint`, `down` on `down-tint`. Use the tint only for a chip or the down count in navigation, never for a whole row or panel.
- `up-soft` is the "mostly up" uptime day. It is a mark, never text.
- `unknown` draws the no-data ring and empty strip days. The words next to it are `muted`.
- Charts use `series-1` to `series-9`, one per region, in the order of the region registry. They never reuse status colours for meaning.
- Badges are user-coloured labels. The user's colour fills only the 8px swatch; the badge text is always `ink` on `surface`, so any colour the user picks stays legible.

## Type

- `display` (native system sans: `system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`) is for page and panel titles: `display-lg` (32px/36px) once per screen, `display-md` (22px/28px) for panels and dialogs.
- `body` (native system sans: `system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`) carries all interface text: `heading` (16px/24px) for monitor names and form sections, `body` (16px/24px) by default, `body-sm` (14px/20px) for hints and supporting copy.
- `mono` (system monospace: `ui-monospace, 'SF Mono', Menlo, monospace`) is reserved for numeric and tabular evidence: `figure` (20px/24px) for headline numbers, `data` (13px/20px) for URLs, latency and timestamps, and short region codes. Labels use `label` (12px/16px) with normal letter spacing.
- Never set a sentence in `label`. Never set a number that will be compared in anything but `mono`.

## Regions

The nine probe regions are shown by short code in `label`, in registry order:

| Region | Code | Placement |
| --- | --- | --- |
| us-east | `US-E` | aws:us-east-1 |
| us-west | `US-W` | aws:us-west-2 |
| canada-central | `CA-C` | aws:ca-central-1 |
| eu-west | `EU-W` | aws:eu-west-1 |
| eu-north | `EU-N` | aws:eu-north-1 |
| eu-south | `EU-S` | aws:eu-south-1 |
| asia | `AS-SE` | aws:ap-southeast-1 |
| asia-east | `AS-NE` | aws:ap-northeast-1 |
| asia-south | `AS-S` | aws:ap-south-1 |

Show the full name in a tooltip or the region grid, never only the colour.

## Spacing, radius and layout

- Spacing is a 4px grid: `space-1` between uptime days, `space-2` inside controls, `space-3` / `space-4` for row padding, `space-6` between panels, `space-8` as the desktop page gutter.
- Radii stay small and square-ish: `radius-xs` for strip days and swatches, `radius-sm` for badges, navigation items and menu options, `radius-control` for buttons, inputs and select triggers, `radius-md` for panels, dialogs and open menus. `radius-full` is for status chips only.
- Controls are `control-md` (36px) tall, `control-sm` (30px) in rows and toolbars, and `control-touch` (44px) on coarse pointers. Rows in the monitor board are 56px.
- Never show a browser-default control. Buttons, inputs, selects and their open menus follow [Button](components/Button.md), [Field](components/Field.md) and [Select](components/Select.md).
- See [`admin-layout.md`](admin-layout.md) for the screen anatomy.

## States and motion

- Focus: a solid 2px `focus` ring offset by 2px on buttons, links and rows. Inputs and open selects instead turn their own edge `accent` at 2px and add a 3px `focus-halo`. Never remove focus.
- Hover: rows, quiet buttons and menu options move to `sunken`; secondary buttons, inputs and select triggers darken their border to `ink-soft`.
- Press: buttons move down 1px and lose `shadow-control`.
- Disabled: 45% opacity and a `not-allowed` cursor, with the reason in a hint next to it.
- Motion is functional: 120ms for hover and press, 220ms for dialogs and panels. Open menus fade in over 120ms with a 4px drop. A monitor changing state may pulse its glyph once. Nothing loops except a button's spinner while its request is in flight. Respect `prefers-reduced-motion` by removing transitions.

## Iconography

There is no logo yet: the name is set as a wordmark in `display` at 600. The status glyphs (circle, triangle, square, ring, pause bars) are drawn in CSS and are the product's primary icons. For other icons use a single stroked set at 1.5px, 16px grid, coloured `ink-soft` or `muted`; no filled or multicolour icons and no emoji.
