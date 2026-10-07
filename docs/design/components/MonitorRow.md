# MonitorRow

A monitor row is one line of the board: everything needed to decide whether to open the monitor.

Columns, left to right: status chip · name, badges and URL · nine region dots · 30-day compact strip · 24-hour uptime · p50 latency.

- Rows sit inside `ut-board` (`surface`, `rule` hairlines, `sunken` header with `label` column names). Rows are 56px; the whole row is one link to the detail page.
- Sorting lives in the header row, not in separate buttons. Sortable column names (Status, Monitor, Regions) are buttons: a faint up-down chevron at rest, `ink` on hover, `ink` at 600 with an `accent` arrow when active. Clicking the active column flips the direction. Columns whose data loads per row (30 days, 24 h, p50) are plain labels. On narrow screens the header keeps only the sort buttons.
- Default order is down first, then degraded, then by name, shown as Status ascending. Above the board, a summary line counts each state in `figure`; there are no stat tiles.
- A down row is not tinted as a whole. The chip, the red dots and the red days already say it.
- The URL is `data` in `muted` and truncates with an ellipsis; the full URL is in the title attribute.
- Numbers are right-aligned `data` with units. A monitor with no successful check shows "—".
- Below 900px the row stacks: chip and name on the first line, dots and strip on the second, numbers hidden.

The consumer provides the monitor summary (state, name, URL, badges, per-region state, 30 days, uptime, p50) and the link.
