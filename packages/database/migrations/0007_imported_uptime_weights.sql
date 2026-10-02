UPDATE "monitor_daily_uptime" AS "daily"
SET
  "weight" = (
    86400.0 / "monitor"."interval_seconds" * greatest(
      (SELECT count(*) FROM "monitor_regions" AS "region" WHERE "region"."monitor_id" = "monitor"."id"),
      1
    )
  ),
  "updated_at" = now()
FROM "monitors" AS "monitor"
WHERE "daily"."monitor_id" = "monitor"."id"
  AND "daily"."source" = 'status.bsky.app:zwOvMT8x16'
  AND "daily"."received_count" IS NULL;
