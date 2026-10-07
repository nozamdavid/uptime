import { describe, expect, it } from 'vitest';
import { configuredMonitorBatch, evaluateCapacity } from './capacity.js';

describe('scheduler grant capacity', () => {
  it.each([
    [200, 1, true],
    [200, 2, true],
    [144, 3, true],
    [48, 9, true],
    [201, 1, false],
    [145, 3, false],
    [49, 9, false],
  ])('validates %i monitors across %i regions', (monitors, regions, safe) => {
    expect(evaluateCapacity({ monitors, regions }).safe).toBe(safe);
  });
  it('uses exact integer period bounds for a lower configured batch', () => {
    const batch = configuredMonitorBatch({ MONITOR_BATCH: '7' });
    expect(evaluateCapacity({ monitors: 28, regions: 1 }, batch).safe).toBe(true);
    expect(evaluateCapacity({ monitors: 29, regions: 1 }, batch).safe).toBe(false);
    expect(
      evaluateCapacity({ monitors: 28, regions: 1 }, batch).effectiveCaps.monitorsPerPeriod,
    ).toBe(28);
    expect(configuredMonitorBatch({ COORDINATOR_MONITOR_BATCH: '100' })).toBe(50);
  });
  it('reports actual load and fleet dispatch bottlenecks separately', () => {
    const result = evaluateCapacity(
      { monitors: 3, regions: 3 },
      50,
      { monitors: 201, regionalTasks: 450 },
      21,
    );
    expect(result.safe).toBe(false);
    expect(result.actualUtilization!.monitorClaims).toBeGreaterThan(1);
    expect(result.warnings).toHaveLength(2);
  });
});
