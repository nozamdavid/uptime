# RegionGrid

The region grid answers "where": the nine probe regions in a fixed 3 × 3, each with its last result.

- Order is the region registry, row by row: US-E, US-W, CA-C / EU-W, EU-N, EU-S / AS-SE, AS-NE, AS-S. Never reorder by status; people learn the positions.
- Each cell: code in `label`, status glyph, last latency in `figure`, and a `muted` line with the full region name and either the check time or the failure ("Timeout", "HTTP 503").
- A failing figure takes the state colour. A region the monitor does not use shows the ring glyph and "not selected".
- The board-row form (`ut-dots`) is the same nine positions as 8px glyphs, with an `aria-label` that counts each state.

The consumer provides, per region, the state, last latency or error, and check time.
