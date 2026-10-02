/**
 * Build-time frontend configuration.
 *
 * Cloudflare migration contract:
 *   VITE_API_BASE_URL      Absolute API root including the `/api` suffix, for
 *                          example `https://uptime-api.example.com/api`. All
 *                          authenticated requests are sent with
 *                          `credentials: 'include'`, so the API must answer
 *                          cross-origin preflights with an exact
 *                          `Access-Control-Allow-Origin` and
 *                          `Access-Control-Allow-Credentials: true`.
 *                          Defaults to `/api` so the Vite dev proxy still works.
 *   VITE_REPORTS_BASE_URL  Gateway base URL, for example
 *                          `https://uptime.pages.dev/reports`, with no trailing
 *                          slash. The gateway resolves cohort snapshots under
 *                          `public/monitors/{slug}.json`,
 *                          `public/status-pages/{slug}.json` and
 *                          `public/status-pages.json`.
 *                          When unset the public pages fall back to the
 *                          API public endpoints.
 */

export interface FrontendConfig {
  /** Always ends without a trailing slash; defaults to `/api`. */
  readonly apiBaseUrl: string;
  /** `null` when public snapshot hosting is not configured. */
  readonly reportsBaseUrl: string | null;
}

export function normalizeBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.replace(/\/+$/, '');
}

export function resolveFrontendConfig(source: Record<string, unknown>): FrontendConfig {
  return {
    apiBaseUrl: normalizeBaseUrl(source.VITE_API_BASE_URL) ?? '/api',
    reportsBaseUrl: normalizeBaseUrl(source.VITE_REPORTS_BASE_URL),
  };
}

/**
 * Read configuration from `import.meta.env` at call time so tests can stub the
 * environment with `vi.stubEnv` and so Vite's static replacement is applied to
 * the whole expression.
 *
 * Access the properties directly (`import.meta.env.VITE_*`) rather than casting
 * the object: Vite only performs the build-time string replacement for literal
 * `import.meta.env.NAME` member expressions.
 */
export function frontendConfig(): FrontendConfig {
  return resolveFrontendConfig({
    VITE_API_BASE_URL: import.meta.env.VITE_API_BASE_URL,
    VITE_REPORTS_BASE_URL: import.meta.env.VITE_REPORTS_BASE_URL,
  });
}

export function publicReportsEnabled(): boolean {
  return frontendConfig().reportsBaseUrl !== null;
}
