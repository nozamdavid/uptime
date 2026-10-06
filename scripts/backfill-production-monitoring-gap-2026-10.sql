-- Operator-authorized assumption of green for wholly missing historical days.
-- These are synthetic uptime summaries, not measured checks or latency data.
-- Existing daily summaries and days with observations are preserved. Keep the
-- current day calculated so subsequent real failures remain visible.
WITH days(day) AS (
  VALUES ('2026-10-02'), ('2026-10-03'), ('2026-10-04')
)
INSERT INTO monitor_daily_uptime (
  monitor_id, day, uptime_percentage, average_response_ms, weight,
  received_count, success_count, response_sum_ms, response_count_ms, source
)
SELECT
  m.id, d.day, 100.0, NULL, 1.0,
  NULL, NULL, 0.0, 0,
  'synthetic:operator-green-backfill:2026-10-05'
FROM monitors AS m
CROSS JOIN days AS d
WHERE m.enabled = 1
  AND m.created_at < strftime('%Y-%m-%dT00:00:00.000Z', d.day, '+1 day')
  AND d.day < date('now')
  AND NOT EXISTS (
    SELECT 1 FROM monitor_daily_uptime AS daily
    WHERE daily.monitor_id = m.id AND daily.day = d.day
  )
  AND NOT EXISTS (
    SELECT 1 FROM observations AS observation
    WHERE observation.monitor_id = m.id
      AND observation.started_at >= d.day || 'T00:00:00.000Z'
      AND observation.started_at < strftime('%Y-%m-%dT00:00:00.000Z', d.day, '+1 day')
  )
ON CONFLICT (monitor_id, day) DO NOTHING;
