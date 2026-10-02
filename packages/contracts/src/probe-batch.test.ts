import { describe, expect, it } from 'vitest';

import { probeBatchRequestSchema, probeBatchSize } from './index.js';

const item = {
  checkRunId: 'ec1e26af-4a95-47a1-9400-3ea1caf03000',
  monitorId: '0ceba4d4-dde0-4e7e-99d7-062517cfa3cf',
  windowStartedAt: '2026-08-30T00:00:00.000Z',
  url: 'https://example.com',
  timeoutMs: 1_000,
  method: 'GET' as const,
  maxRedirects: 5 as const,
  maxBodyBytes: 65_536 as const,
};

describe('probe batch contract', () => {
  it('accepts up to five same-region probe items', () => {
    const parsed = probeBatchRequestSchema.parse({
      requestId: 'b46f9f80-7ea6-43c7-a674-4b9a57ac6745',
      issuedAt: '2026-08-30T00:00:01.000Z',
      regionId: 'eu-west',
      items: Array.from({ length: probeBatchSize }, (_, index) => ({
        ...item,
        checkRunId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      })),
    });

    expect(parsed.items).toHaveLength(5);
  });

  it('rejects a sixth probe item', () => {
    expect(
      probeBatchRequestSchema.safeParse({
        requestId: 'b46f9f80-7ea6-43c7-a674-4b9a57ac6745',
        issuedAt: '2026-08-30T00:00:01.000Z',
        regionId: 'eu-west',
        items: Array.from({ length: probeBatchSize + 1 }, (_, index) => ({
          ...item,
          checkRunId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        })),
      }).success,
    ).toBe(false);
  });
});
