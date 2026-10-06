# SideNav

The side navigation is the admin shell: wordmark, search, sections and workspace, on `sunken`.

- 224px wide, full height, `rule` on its right edge. Collapses into a top bar with a menu button below 900px.
- The search trigger opens the command palette and shows its `⌘K` hint in `ut-kbd`.
- Items are 32px, `ink-soft`, with no edge marks or bars. Hover moves an item to `surface` and `ink`.
- The current item (`aria-current="page"`) fills with `accent-tint` and turns `ink` at 600, the same treatment as a chosen option in a Select. Don't use `surface` for it: in dark it sits too close to `sunken` to see. `ink` and the `muted` count both stay above 4.5:1 on `accent-tint` in both themes.
- Counts are `mono`. The Monitors item shows "N down" in a `down` on `down-tint` chip whenever anything is down; otherwise it shows the total.
- Operator links appear under an "Operator" `label` group only for operators. The workspace group sits last and switches workspace.

The consumer provides the sections, counts, current route and the person's role and workspaces.
