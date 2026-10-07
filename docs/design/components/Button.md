# Button

Buttons trigger one action and say exactly what it does. They are the only resting content with depth: a 1px `shadow-control` underneath, and an inner top `control-highlight` on filled buttons. Pressing one moves it down 1px and removes the shadow, so a click feels physical.

## Variants

- **Primary** (`ut-btn--primary`): `ink` fill, `paper` text, highlight and shadow. At most one per view: "Add monitor", "Save monitor", "Publish status page". Hover lightens the fill to `ink-soft`.
- **Secondary** (`ut-btn--secondary`): `surface`, `rule-strong` border, `shadow-control`. Page actions next to a title: "Edit", "Pause", "Share". Hover moves the ground to `paper` and the border to `ink-soft`; pressed moves it to `sunken`.
- **Quiet** (`ut-btn--quiet`): `accent` text, no border or shadow. Low-weight actions inside panels and rows: "Send test notification", "Retry". Hover adds a `sunken` ground.
- **Danger** (`ut-btn--danger`): `down` fill, `on-down` text. Only inside a confirming [Dialog](Dialog.md), never directly on a page.

## Sizes and shapes

- Default height is `control-md` (36px), 14px text at 500, 14px side padding, `radius-control`.
- Small (`ut-btn--sm`) is `control-sm` (30px), 13px text. Use it in rows, panel headers and toolbars.
- Icon-only (`ut-btn--icon`) is square at either size and needs an `aria-label` and a tooltip.
- On coarse pointers every button grows to `control-touch` (44px).

## Content

- Label in sentence case, verb first. An optional 16px stroked icon goes before the label; a keyboard hint (`ut-kbd`) goes after it ("Search ⌘K").
- While an action runs, keep the label, set `aria-busy="true"` and `disabled`, and put a `ut-spinner` before the label: "Saving monitor". The spinner is the one looping animation allowed, and only while the request is in flight.
- A disabled button keeps a visible hint next to it that says why.

## Segmented control

One choice from two to five options that change a view immediately, such as the latency range (1h, 24h, 7d, 30d). The track is `sunken` with `shadow-inset`; the chosen segment is `surface` with `shadow-control`, like a key pressed into a slot. Use `role="radiogroup"` with `aria-checked`, or buttons with `aria-pressed`. For more than five options, use a [Select](Select.md).

The consumer provides the label, optional icon, the handler and the busy state.
