# Admin layout

The admin is rebuilt around one question: *what is broken, and where?* Every screen answers it before anything else.

## Shell

- A fixed **side navigation** ([`SideNav`](components/SideNav.md), 224px, `sunken`) replaces the top bar. It holds the wordmark, the workspace switcher, the search trigger with its `⌘K` hint, then the sections: Monitors, Status pages, Notifications, Settings. Operators also see Operator.
- Each section shows a count in `data`. Monitors shows the number of monitors that are down in a `down` on `down-tint` chip, so the problem is visible from any screen.
- The main column sits on `paper` with a `space-8` gutter and a 1200px maximum width. Below 900px the navigation collapses into a top bar with a menu button.

## Monitors (the board)

1. **Summary line** at the top, in `body` with `figure` numbers: "37 up · 2 degraded · 1 down". It replaces stat tiles.
2. **Filter row**: search, region, badge and sort selects in one line of 32px controls, with "Add monitor" as the single primary button on the right.
3. **The board**: one [`MonitorRow`](components/MonitorRow.md) per monitor, sorted with down first, then degraded, then by name. Each row shows the status glyph, name and URL, badges, nine region dots, a 30-day [`UptimeStrip`](components/UptimeStrip.md), 24-hour uptime and p50 latency.
4. Down rows keep their position at the top; they are not coloured as a whole. The status chip and the red region dots are enough.

## Monitor detail

1. **Header**: status chip, monitor name in `display-lg`, URL in `data`, and the actions "Edit", "Pause" and "Share" as secondary buttons. The public link, when sharing is on, sits under the URL.
2. **Now**: the [`RegionGrid`](components/RegionGrid.md), a 3 × 3 panel of the nine regions with their status and last latency. This is where "where" gets answered.
3. **History**: the 90-day `UptimeStrip` with the overall percentage, then the [`LatencyTrace`](components/LatencyTrace.md) with a range control (1h, 24h, 7d, 30d) and a region legend.
4. **Evidence**: the request table (time, region, HTTP code, latency, error) and DNS diagnostics, each a `surface` panel with a `sunken` header.
5. **Danger zone** at the bottom after `space-12`: "Delete history" and "Delete monitor", each through a [`Dialog`](components/Dialog.md) that names what will be removed.

## Monitor form

- One column, 640px wide, grouped into sections with `heading` titles: Target, Regions, Schedule, Notifications, Public sharing, Network diagnostics, Uptime thresholds.
- Regions are nine checkable tiles in the same 3 × 3 order as the region grid, so the form and the detail page match.
- Save and Cancel stick to the bottom of the viewport on a `surface` bar with a `rule` top border.

## Status pages and notifications

- Status pages list as rows with title, monitor count, public link in `data` and last publish time. The editor uses two columns: groups on the left, available monitors on the right.
- Notification services list provider, name, last delivery and a "Send test notification" quiet button. Delivery history uses the same row pattern as the board, with `up` and `down` glyphs for delivered and failed.

## Empty, loading and error

- Empty: one sentence naming what will appear, one sentence on how to add it, and the primary button.
- Loading: `sunken` skeleton bars in the exact shape of the content; no spinners on pages.
- Error: a `down-tint` inline message in the panel that failed, saying what failed and what to try, with a "Retry" quiet button. The rest of the page stays usable.
