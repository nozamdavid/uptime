# Components

One guideline per component. Each names the tokens it uses and what the consumer provides.

| Component | Group | Use |
| --- | --- | --- |
| [Button](Button.md) | Actions | Primary, secondary, quiet and danger actions, and the segmented control |
| [Field](Field.md) | Forms | Label, input with affixes, hint and error |
| [Select](Select.md) | Forms | Custom select trigger and its open menu, single and multiple choice |
| [StatusMark](StatusMark.md) | Status | Up, degraded, down, no data and paused, by shape and word |
| [Badge](Badge.md) | Status | User-coloured monitor labels |
| [UptimeStrip](UptimeStrip.md) | Data | One bar per day, 90-day and 30-day forms |
| [RegionGrid](RegionGrid.md) | Data | The nine regions in a fixed 3 × 3, and the row dots |
| [MonitorRow](MonitorRow.md) | Data | One line of the monitors board |
| [LatencyTrace](LatencyTrace.md) | Data | Response latency per region over time |
| [SideNav](SideNav.md) | Navigation | The admin shell's left rail |
| [Dialog](Dialog.md) | Overlays | Destructive confirmation |

[`reference.css`](reference.css) is the stylesheet the published previews use. Treat it as a reference for spacing, sizes and states, not as a file to import: `apps/web` should express the same rules in its own styles, reading every value from the tokens. It expects each token as a CSS custom property of the same name (`--ink`, `--space-4`) and the families as `--font-display`, `--font-body` and `--font-mono`.
