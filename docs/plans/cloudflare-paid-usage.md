# Cloudflare Paid Tier Usage & Limits

Cloudflare usage metering was removed with the Cloudflare-hosted backend. The API and scheduler now run on a VPS with PostgreSQL, so the operator Cloudflare usage and cost panel and the `/api/operator/cloudflare-usage` endpoint no longer exist. Cloudflare only runs the regional probe Workers and the test target Worker; check their usage in the Cloudflare dashboard.
