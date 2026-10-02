import { describe, expect, it } from 'vitest';

import { deriveAggregateStatus } from './status.js';

describe('aggregate monitor status', () => {
  it('reports incomplete regional evidence as unknown', () => {
    expect(
      deriveAggregateStatus(
        ['us-east', 'eu-west'],
        [{ regionId: 'us-east', success: true, status: 'success' }],
      ),
    ).toBe('unknown');
    expect(
      deriveAggregateStatus(
        ['us-east', 'eu-west'],
        [{ regionId: 'us-east', success: false, status: 'http_failure' }],
      ),
    ).toBe('unknown');
  });

  it('derives status after every configured region has reported', () => {
    expect(
      deriveAggregateStatus(
        ['us-east', 'eu-west'],
        [
          { regionId: 'us-east', success: true, status: 'success' },
          { regionId: 'eu-west', success: true, status: 'success' },
        ],
      ),
    ).toBe('up');
    expect(
      deriveAggregateStatus(
        ['us-east', 'eu-west'],
        [
          { regionId: 'us-east', success: true, status: 'success' },
          { regionId: 'eu-west', success: false, status: 'network_failure' },
        ],
      ),
    ).toBe('degraded');
    expect(
      deriveAggregateStatus(
        ['us-east', 'eu-west'],
        [
          { regionId: 'us-east', success: false, status: 'http_failure' },
          { regionId: 'eu-west', success: false, status: 'network_failure' },
        ],
      ),
    ).toBe('down');
  });
});
