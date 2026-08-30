import { describe, expect, it } from 'vitest';
import {
  expectedChecksPerDay,
  expectedDnsSnapshotsPerDay,
  isValidTimeout,
} from './monitor-form.logic.js';

describe('monitor form calculations', () => {
  it('counts every selected regional target check', () => {
    expect(expectedChecksPerDay(['us-east', 'eu-west', 'asia'], 300)).toBe(864);
    expect(
      expectedChecksPerDay(
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
        60,
      ),
    ).toBe(12_960);
  });

  it('rejects a timeout equal to its check interval', () => {
    expect(isValidTimeout(60_000, 60)).toBe(false);
    expect(isValidTimeout(30_000, 60)).toBe(true);
  });

  it('keeps DNS snapshots off by default and counts one daily snapshot per region when enabled', () => {
    expect(expectedDnsSnapshotsPerDay(['us-east', 'eu-west'], false)).toBe(0);
    expect(expectedDnsSnapshotsPerDay(['us-east', 'eu-west'], true)).toBe(2);
    expect(expectedChecksPerDay(['us-east', 'eu-west'], 300)).toBe(576);
  });
});
