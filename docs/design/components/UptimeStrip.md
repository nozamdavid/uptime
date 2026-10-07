# UptimeStrip

The uptime strip shows one bar per day, oldest on the left, and is the brand's signature shape.

- Day colour follows the monitor's uptime thresholds: above green is `up`, above light-green is `up-soft`, at or above orange is `degraded`, below is `down`. A day with no checks is `sunken` with a `rule` outline.
- Full form (detail page, status pages): 90 days, 28px tall, with a `label` caption, the overall percentage in `figure` and a date axis.
- Compact form (`ut-strip--compact`, board rows): 30 days, 20px tall, no axis.
- Every bar has a tooltip with the date, uptime percentage and downtime in minutes.

The consumer provides the list of days (date and uptime percentage, or none) and the thresholds.
