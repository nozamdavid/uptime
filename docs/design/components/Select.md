# Select

A select is a trigger that looks like a pressable control and opens a menu of options styled by us, never the browser's native list.

## Trigger

- Same box as a secondary button: `surface`, `rule-strong` border, `shadow-control`, `radius-control`, `control-md` tall (`control-sm` with `ut-select--sm`).
- Inside, left to right: optional lead (status glyph, badge swatch or region code), the value (truncates with an ellipsis), an optional count chip, and an up-down chevron in `muted`.
- Empty shows a `muted` placeholder that names the choice: "Choose a notification service".
- Filter selects in toolbars carry their name as a `muted` prefix so no separate label is needed: "Region **All regions**", "Sort **Status**".
- Multi-select shows the first choice and a count chip in `accent` on `accent-tint`: "EU-W, EU-N **+2**", or "All regions" when everything is chosen.
- Open (`aria-expanded="true"`): `accent` border, ring and `focus-halo`, same as a focused input; the chevron turns `accent`.

## Menu

- Opens 4px below the trigger, at least as wide as it, at most 360px wide and 340px tall, then scrolls. `surface`, `rule` border, `radius-md`, `shadow-overlay`, 4px inner padding.
- Appears with a 120ms fade and 4px drop; no animation with reduced motion. Flips above the trigger when there is no room below.
- **Options** are `option` tall (32px; 44px on coarse pointers), `radius-sm`, 8px side padding, `ink-soft` text. Hover or keyboard highlight moves an option to `sunken` and `ink`.
- **Single choice:** the chosen option sits on `accent-tint` with an `accent` check at the right. Choosing closes the menu.
- **Multiple choice:** each option leads with a 16px checkbox (`accent` fill and `on-accent` check when chosen). Choosing does not close the menu. A sticky footer shows "N selected" and a quiet "Clear" button.
- Leading content matches the trigger's: region codes in a fixed mono column, status glyphs, badge swatches. Right-aligned `option__meta` in `mono` holds a count or a latency ("38 ms").
- Group long lists under `muted` 12px group labels (Americas, Europe, Asia-Pacific for regions), separated by a `rule`.
- Lists longer than eight options get a sticky search field at the top. No match shows "No regions match "tokyo"." in `muted`.
- Disabled options stay visible at 45% with the reason in the meta slot ("Plan limit").

## Behaviour

- Build it as a button with `aria-haspopup="listbox"` and `aria-expanded`, plus a `role="listbox"` menu with `role="option"` and `aria-selected`. Use `aria-multiselectable` for multiple choice. The highlighted option is tracked with `aria-activedescendant`.
- Keyboard: Enter, Space or Down opens; Up and Down move; Home and End jump; typing jumps to the first match; Enter chooses; Escape or Tab closes and returns focus to the trigger.
- Clicking outside closes the menu without changing the value.
- Do not style a native `<select>` element's open list; it cannot be made to match. A native select is acceptable only as the no-JavaScript fallback.

The consumer provides the options (value, label, optional lead, meta, group, disabled reason), the value or values, the placeholder and the change handler.
