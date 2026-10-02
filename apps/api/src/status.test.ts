import { describe, expect, it } from 'vitest';

import { deriveAggregateStatus, percentile } from './status.js';

describe('aggregate monitor status', () => {
  const regions = ['us-east', 'eu-west', 'asia'] as const;

  it('treats a Worker-reported timeout as down while excluding missing regions', () => {
    expect(deriveAggregateStatus(regions, [])).toBe('unknown');
    expect(
      deriveAggregateStatus(regions, [
        { regionId: 'us-east', success: false, status: 'network_failure' },
      ]),
    ).toBe('down');
    expect(
      deriveAggregateStatus(regions, [{ regionId: 'us-east', success: true, status: 'success' }]),
    ).toBe('up');
    expect(
      deriveAggregateStatus(regions, [
        { regionId: 'us-east', success: true, status: 'success' },
        { regionId: 'eu-west', success: false, status: 'http_failure' },
      ]),
    ).toBe('degraded');
  });

  it('returns up, degraded and down under the stated rules', () => {
    expect(
      deriveAggregateStatus(
        ['us-east'],
        [{ regionId: 'us-east', success: true, status: 'success' }],
      ),
    ).toBe('up');
    expect(
      deriveAggregateStatus(
        ['us-east'],
        [{ regionId: 'us-east', success: false, status: 'network_failure' }],
      ),
    ).toBe('down');
    expect(
      deriveAggregateStatus(regions, [
        { regionId: 'us-east', success: false, status: 'http_failure' },
        { regionId: 'eu-west', success: false, status: 'network_failure' },
        { regionId: 'asia', success: false, status: 'http_failure' },
      ]),
    ).toBe('down');
  });

  it('uses only returned Worker evidence at larger region counts', () => {
    expect(
      deriveAggregateStatus(
        ['us-east', 'us-west'],
        [{ regionId: 'us-east', success: false, status: 'http_failure' }],
      ),
    ).toBe('down');
    expect(
      deriveAggregateStatus(
        ['us-east', 'us-west', 'canada-central', 'eu-west'],
        [
          { regionId: 'us-east', success: false, status: 'http_failure' },
          { regionId: 'us-west', success: false, status: 'network_failure' },
          { regionId: 'canada-central', success: false, status: 'http_failure' },
          { regionId: 'eu-west', success: true, status: 'success' },
        ],
      ),
    ).toBe('degraded');
    expect(
      deriveAggregateStatus(
        ['us-east', 'us-west', 'canada-central', 'eu-west', 'eu-north', 'eu-south'],
        [
          { regionId: 'us-east', success: false, status: 'http_failure' },
          { regionId: 'us-west', success: false, status: 'network_failure' },
          { regionId: 'canada-central', success: false, status: 'http_failure' },
          { regionId: 'eu-west', success: true, status: 'success' },
          { regionId: 'eu-north', success: true, status: 'success' },
          { regionId: 'eu-south', success: true, status: 'success' },
        ],
      ),
    ).toBe('degraded');
    expect(
      deriveAggregateStatus(
        [
          'us-east',
          'us-west',
          'canada-central',
          'eu-west',
          'eu-north',
          'eu-south',
          'asia',
          'asia-east',
          'asia-south',
        ],
        [
          { regionId: 'us-east', success: false, status: 'http_failure' },
          { regionId: 'us-west', success: false, status: 'network_failure' },
          { regionId: 'canada-central', success: false, status: 'http_failure' },
          { regionId: 'eu-west', success: false, status: 'http_failure' },
          { regionId: 'eu-north', success: false, status: 'network_failure' },
          { regionId: 'eu-south', success: true, status: 'success' },
          { regionId: 'asia', success: true, status: 'success' },
          { regionId: 'asia-east', success: true, status: 'success' },
          { regionId: 'asia-south', success: true, status: 'success' },
        ],
      ),
    ).toBe('degraded');
  });
});

describe('percentiles', () => {
  it('uses deterministic nearest-rank percentile selection', () => {
    expect(percentile([], 95)).toBeNull();
    expect(percentile([40, 10, 30, 20], 50)).toBe(20);
    expect(percentile([40, 10, 30, 20], 95)).toBe(40);
  });
});
