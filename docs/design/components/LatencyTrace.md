# LatencyTrace

The latency trace plots response time per region over a chosen range.

- One line per selected region in `series-1` … `series-9` (registry order), 1.75px, with a dot on the latest point. The first region gets a faint area fill.
- Grid lines are `rule`; axis text is `label`-sized `mono` in `muted`, y-axis in ms, x-axis in UTC with the zone on the last tick.
- Incidents (any region down) are a `down-tint` band behind the lines, explained in the legend with their time span.
- The legend lists region code, colour key and current latency, and toggles a region on click.
- The range control is a [segmented control](Button.md#segmented-control): 1h, 24h, 7d, 30d.

The consumer provides the series (region, points), the incidents and the selected range.
