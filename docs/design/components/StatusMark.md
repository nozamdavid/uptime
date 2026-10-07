# StatusMark

The status mark is the product's core icon: a shape plus a word, so state reads without colour.

| State | Glyph | Colour | Word |
| --- | --- | --- | --- |
| Up | circle | `up` | Up |
| Degraded | triangle | `degraded` | Degraded |
| Down | square | `down` | Down |
| No data | ring | `unknown`, text `muted` | No data |
| Paused | two bars | `muted` | Paused |

- Use the plain form in tables and region cells. Use the chip form (`ut-status--chip`, on the matching tint) once per page header and for the board's status column.
- The chip may add one fact after a middle dot: how many regions fail ("Degraded · 2 of 9") or for how long ("Down for 14 min").
- Glyph-only (no word) is allowed only where a column header or tooltip names the state, such as region dots.

The consumer provides the state and, optionally, the fact.
