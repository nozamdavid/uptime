import { describe, expect, it } from 'vitest';
import { frontendConfig, normalizeBaseUrl, resolveFrontendConfig } from './config.js';

describe('frontend configuration', () => {
  it('defaults the API base to the same-origin /api prefix', () => {
    expect(resolveFrontendConfig({})).toEqual({ apiBaseUrl: '/api', reportsBaseUrl: null });
  });

  it('accepts absolute API and report origins', () => {
    expect(
      resolveFrontendConfig({
        VITE_API_BASE_URL: 'https://uptime-api.example.com/api',
        VITE_REPORTS_BASE_URL: 'https://reports.example.com',
      }),
    ).toEqual({
      apiBaseUrl: 'https://uptime-api.example.com/api',
      reportsBaseUrl: 'https://reports.example.com',
    });
  });

  it('strips trailing slashes and trims whitespace', () => {
    expect(normalizeBaseUrl(' https://reports.example.com/// ')).toBe(
      'https://reports.example.com',
    );
    expect(normalizeBaseUrl('   ')).toBeNull();
    expect(normalizeBaseUrl(undefined)).toBeNull();
  });

  it('exposes the runtime configuration without throwing', () => {
    expect(frontendConfig().apiBaseUrl).toBeTruthy();
  });
});
