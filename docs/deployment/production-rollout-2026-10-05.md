# Production rollout, 2026-10-05

The user authorized the production rollout and the minimal guarded correction
of the pre-existing malformed tenant slot registry. Existing dirty source changes
are preserved. No credentials are read or rotated.

## Identity evidence and repair

Cloudflare D1 inventory and live hosted API version
`50aefd01-2e1e-4369-8ace-706e692af247` and coordinator version
`11cc350a-988a-49a9-a126-0e31c6106f5d` agree with both local configs:
`TENANT_DB_000` through `009` refer to the matching `uptime-tenant-NNN` names.
The exact physical IDs are recorded in the adjacent reconciliation SQL.
The old registry has blank `000`, and `001` through `009` each refer to the
preceding physical database. Physical `009` is absent from the registry.

The existing active workspace is `a8965287-71af-4afd-8786-c3fb33c54a74`, owned by
`did:plc:lmkzmvv6sdxntwtyxpg7fqqq` (@noz.am), with a valid owner membership.
Physical `000` has this same singleton workspace identity and a blank database
ID. Physical `001` through `009` have no workspace metadata. Bounded EXISTS
queries found no monitor, page, service, badge, region, check, observation,
diagnostic, or delivery content in any of these ten databases.

The live registry has unique binding/workspace constraints, but no unique
database-ID constraint. The repair uses one guarded UPDATE for all ten IDs,
preserving assignment, lifecycle status, schema version, workspace, and membership.
It requires the exact old snapshot, owner membership, a unique unexpired workspace
lease, and allocation holds on all nine unused bindings. Only the blank physical
`000` metadata database ID is filled, retaining all other metadata fields.
The adoption helper's strict identity validation is unchanged.

The exact physical `000` metadata mutation, issued only after revalidation under
the control lease and nine allocation holds, was:

```sql
UPDATE workspace_metadata
SET database_id = '6af68e2a-f8a9-4d80-b04f-c42f35b1897b'
WHERE id = 1
  AND workspace_id = 'a8965287-71af-4afd-8786-c3fb33c54a74'
  AND database_id = '' AND plan = 'free'
  AND (SELECT count(*) FROM workspace_metadata) = 1
  AND NOT EXISTS(SELECT 1 FROM monitors LIMIT 1)
  AND NOT EXISTS(SELECT 1 FROM status_pages LIMIT 1)
  AND NOT EXISTS(SELECT 1 FROM notification_services LIMIT 1)
  AND NOT EXISTS(SELECT 1 FROM check_runs LIMIT 1)
  AND NOT EXISTS(SELECT 1 FROM observations LIMIT 1);
```

The repair completed: physical `000` metadata UPDATE changed exactly one row;
the guarded registry statement wrote all ten slot rows. Both were read back and
matched the configured identities. All nine unused bindings were held through
`tenant_slot_controls(admission_enabled=0)` under lease
`slot-identity-repair:20f90bd2-b6d2-4440-b6b3-3bcff6dbbb88` (16 minutes).
The controls table was empty beforehand; these temporary holds will be removed
only after verifying the corrected mapping. The lease is released by its token.

Full bounded table checks under the holds found three infrastructure job rows
(`coordinator`, `retention`, `reports`) and one completed empty cohort index in
physical `000`. All ten databases contain the migration-seeded
`report_cache_revisions('monitor_daily_uptime',0)` singleton. These rows are
retained. Every other user-content table was empty; no history scans were used.

`bash scripts/tests/production-slot-identity-repair.sh` passed seven actual SQLite
checks: successful update, conflicting ID, concurrent assignment, lost hold,
expired lease, replaced lease, and changed owner membership. The current
provisioner already validates IDs; no provisioner refactor was made.

## Rollout

Cloudflare Pages deployment metadata confirms project `uptime`, custom domain
`uptime.noz.am`, and production branch `main` (prior deployment
`2f25a9b1-7c64-4347-9230-2f0c1802a0ce`). Wrangler 4.127.1 explicitly rejects
`pages deploy --config`. The supported command discovers `wrangler.toml` from
its working directory; deployment will use an artifact copy of
`deploy/cloudflare/hosted/pages.wrangler.toml` in a temporary directory and an
explicit absolute dist path. This preserves all four configured service/R2
bindings and the repository branch guard.

The nine temporary holds were removed (exactly nine rows); the prior empty
controls table was restored. The repair lease was cleared by its matching token.
Adoption dry-run passed with the corrected `000` identity.

Control migration `0004_workspace_product_limits.sql` and all three pending
tenant migrations (`0013_retire_report_latency_changefeed.sql`,
`0014_simplify_observation_indexes.sql`, `0015_workspace_product_limits.sql`)
succeeded on physical `001` through `009` only. Main retains migrations
`0001` through `0012`; old `000` was not migrated.

These versions were deployed and verified at 100% live traffic before adoption:

| Worker | Version |
| --- | --- |
| uptime-api | `1b88d077-8540-44bd-afaf-66414c4d03f4` |
| uptime-hosted-api | `a7c7998a-5997-412b-9701-46a1c0e6b39d` |
| uptime-hosted-coordinator | `cf3439f5-742d-42d0-a614-4ab42a63057b` |

The hosted API deployment output retains `INTEREST_CHECK_ONLY=true` and
`OPERATOR_DIDS=did:plc:lmkzmvv6sdxntwtyxpg7fqqq`, plus the main import binding
and both legacy service bindings. The hosted coordinator retains its minute
cron and existing queue producer/consumer.

Adoption succeeded and read-back verified the single main identity marker
`(1,a8965287-71af-4afd-8786-c3fb33c54a74,17c009df-5b56-44cc-9776-73e0f1775b0f)`.
The same active workspace now has `PRODUCTION_IMPORTED_DB` assigned.
`TENANT_DB_000` is `deleting` with NULL workspace; its metadata is retained.
The @noz.am owner membership is unchanged, both lease fields are NULL, and the
controls table is restored to its original empty state.

The web production build succeeded with `VITE_API_BASE_URL=/api` and
`VITE_REPORTS_BASE_URL=/reports`; the hosted advanced-mode `_worker.js` was copied
to dist. Build warnings were dependency annotation stripping and a large bundle.
No runtime source changes were introduced by this rollout.

The existing main check runner `uptime-coordinator` remains at
`3417ea33-c97f-49b0-90c3-89c0a76b087b` (100%, deployed 2026-10-03).
It was not deployed by this task.

Reporter version `f82c0f68-744b-4587-af5e-0924ac48a96e` is live at 100%.
Deployment output confirms `* * * * *` cron and `uptime-monitor-refresh` Workflow.
Pages production deployment is `36076eb1-e955-4c1e-aed0-15ee994b1686`, branch
`main`, preview URL `https://36076eb1.uptime-2l5.pages.dev`, custom domain
`https://uptime.noz.am`. Downloading the live Pages config verifies all bindings:
`API=uptime-hosted-api`, `IMPORTED_API=uptime-api`,
`IMPORTED_REPORTER=uptime-reporter`, `IMPORTED_REPORTS=uptime-reports`.

## Final verification

At `2026-10-04T22:56:50.620Z` (2026-10-05 in Europe/Madrid):

- Main retains 107 monitors, all enabled, and 107 healthy notification states.
- Latest notification state advanced to `22:55:08.012Z`; indexed per-monitor
  latest check queries returned `22:50:00.000Z` for the sampled 300-second
  monitors. EXPLAIN confirms `check_runs_monitor_time_idx`, with no history scan.
- Cohort is complete, generation `1791154568019`, generated at
  `22:56:08.019Z`, latest observation `22:55:40.836Z`, advancing after deployment.
- Main migrations remain `0001` through `0012`; retained physical `000` remains
  `0001` through `0013_free_workspace`. Old metadata timestamps and other fields
  are unchanged.
- `/`, OAuth metadata, public bsky API, public status index/page, public appview
  monitor report, and public bsky report scoped to the operator workspace return
  200. The public bsky API and report both contain the existing 106 page monitors.
- Public report with malformed workspace returns 400. Private report and
  `/api/monitors` scoped to the operator workspace return 401 without a session.
- Hosted API `/health` returns 200 and `{"status":"ok"}`. Pages `/api/health`
  is an authenticated application route and returns 401; it is not the Worker
  health endpoint.
- OAuth metadata client ID is `https://uptime.noz.am/oauth/client-metadata.json`
  and callback is `https://uptime.noz.am/api/auth/atproto/callback`.
- T3 preview tab `tab_8` renders the current interest UI: “COMING SOON”,
  “Simple uptime monitoring”, the handle input, “I'm interested!”, @noz.am and
  Operator links. No login, signup, notification, or test monitor was created.

Limitations: authenticated owner UI was not exercised with a real session.
The preview reports a pre-existing CSP restriction blocking the external Google
Fonts stylesheet; the interest UI renders with fallback fonts. Some public
monitor snapshots report unknown status despite healthy persisted states;
freshness varies across the pre-existing fleet. These are not ownership failures.

The new guard tests, shell syntax check, audit Markdown format check, web build,
and `git diff --check` pass. Previously completed production preparation checks
were not unnecessarily repeated. The only new source files from this task are
this audit, the adjacent reconciliation SQL, and
`scripts/tests/production-slot-identity-repair.sh`; all pre-existing source edits
are preserved. The two audit artifacts are force-added because `docs/**` is
ignored by the repository.
