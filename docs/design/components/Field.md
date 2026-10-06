# Field

A field is a label, a 36px control and an optional hint or error, stacked in that order.

## Anatomy

- **Label** (`ut-field__label`, 14px at 600) is always visible. Never rely on placeholder text. Mark optional fields with a `muted` "Optional" after the label instead of marking required ones.
- **Control** is a text input (`ut-input`), an input group with affixes (`ut-input-group`), or a [Select](Select.md).
- **Hint** (`ut-field__hint`, 13px, `muted`) explains limits before the person makes a mistake: "Between 1 and 30 seconds."
- **Error** (`ut-field__error`, `down`, with a small square glyph) replaces the hint and says how to fix it: "Private addresses can't be checked. Use a public hostname."

## Inputs read as slots

Text inputs are things you type into, so they sit into the page: `surface` ground, `rule-strong` border, `shadow-inset`, `radius-control`, 14px text (16px on coarse pointers so phones don't zoom). Buttons and select triggers are things you press, so they sit on the page with `shadow-control`. Keep that difference: it is how a person tells a dropdown from a text box at a glance.

- Hover darkens the border to `ink-soft`.
- Focus turns the border `accent`, thickens it to 2px with a 1px `accent` ring, and adds a 3px `focus-halo`. The solid edge carries the contrast; the halo only softens it.
- Error keeps a `down` border; on focus the ring and halo switch to `down` and `down-halo`.
- Disabled: `sunken` ground, `rule` border, no shadow, `muted` text.
- URLs, durations and numbers use `ut-input--mono`.

## Affixes

An input group puts fixed text or an icon inside the control's edge, so the person types only the part that varies.

- Prefix (`ut-affix--prefix`): a scheme or base, such as `https://`, on `paper` with a `rule` divider.
- Suffix (`ut-affix--suffix`): the unit, such as `ms`, `s` or `min`. Every numeric input with a unit gets one; never put the unit in the value.
- Icon (`ut-affix--icon`): a 16px stroked icon such as search, on the control's own ground.

The consumer provides the label, value, placeholder, hint, error, affixes, and wires `for`/`id`, `aria-describedby` and `aria-invalid`.
