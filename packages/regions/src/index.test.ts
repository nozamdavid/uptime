import { describe, expect, it } from 'vitest';

import {
  continentIds,
  endpointEnvNameByRegion,
  findRegion,
  isRegionId,
  regionById,
  regionIds,
  regions,
  regionsByContinent,
} from './index.js';

describe('canonical region registry', () => {
  it('preserves the stable nine-region order', () => {
    expect(regionIds).toEqual([
      'us-east',
      'us-west',
      'canada-central',
      'eu-west',
      'eu-north',
      'eu-south',
      'asia',
      'asia-east',
      'asia-south',
    ]);
    expect(regions.map(({ id }) => id)).toEqual(regionIds);
  });

  it('keeps every identity and deployment field unique', () => {
    for (const key of [
      'id',
      'label',
      'placementRegion',
      'approximateAnchor',
      'endpointEnvName',
      'workerName',
      'wranglerConfigBasename',
      'chartSeriesToken',
    ] as const) {
      expect(new Set(regions.map((region) => region[key])).size, key).toBe(regions.length);
    }
  });

  it('defines exactly three geographically distinct regions per continent', () => {
    expect(continentIds).toEqual(['north-america', 'europe', 'asia']);
    for (const continentId of continentIds) {
      expect(regionsByContinent[continentId]).toHaveLength(3);
    }
  });

  it('preserves existing IDs and placement hints byte-for-byte', () => {
    expect(regionById['us-east'].placementRegion).toBe('aws:us-east-1');
    expect(regionById['eu-west'].placementRegion).toBe('aws:eu-west-1');
    expect(regionById.asia.placementRegion).toBe('aws:ap-southeast-1');
  });

  it('provides safe lookup helpers', () => {
    expect(isRegionId('eu-north')).toBe(true);
    expect(isRegionId('unknown')).toBe(false);
    expect(findRegion('asia-east')).toBe(regionById['asia-east']);
    expect(findRegion('unknown')).toBeUndefined();
    expect(endpointEnvNameByRegion['canada-central']).toBe('PROBE_CANADA_CENTRAL_URL');
  });
});
