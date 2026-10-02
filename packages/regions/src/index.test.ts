import { describe, expect, it } from 'vitest';

import {
  continentIds,
  findRegion,
  isRegionId,
  parseRegionList,
  regionById,
  regionIds,
  regions,
  regionsByContinent,
  regionsFromList,
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
  });
});

describe('REGIONS_LIST parsing', () => {
  it('preserves configured order and defaults to every canonical region', () => {
    expect(parseRegionList('asia-east, asia-south')).toEqual(['asia-east', 'asia-south']);
    expect(parseRegionList(undefined)).toEqual(regionIds);
    expect(regionsFromList('eu-west,us-east').map((region) => region.id)).toEqual([
      'eu-west',
      'us-east',
    ]);
  });

  it('rejects unknown, duplicate, and empty entries', () => {
    expect(() => parseRegionList('moon')).toThrow(/unknown regions: moon/);
    expect(() => parseRegionList('us-east,us-east')).toThrow(/duplicate/);
    expect(() => parseRegionList('us-east,,eu-west')).toThrow(/empty entries/);
  });
});
