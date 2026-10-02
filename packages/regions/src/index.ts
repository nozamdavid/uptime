export const continentIds = ['north-america', 'europe', 'asia'] as const;
export type ContinentId = (typeof continentIds)[number];

export const continentLabels = Object.freeze({
  'north-america': 'North America',
  europe: 'Europe',
  asia: 'Asia',
} as const satisfies Readonly<Record<ContinentId, string>>);

export const regionIds = [
  'us-east',
  'us-west',
  'canada-central',
  'eu-west',
  'eu-north',
  'eu-south',
  'asia',
  'asia-east',
  'asia-south',
] as const;
export type RegionId = (typeof regionIds)[number];

export interface RegionDefinition {
  readonly id: RegionId;
  readonly label: string;
  readonly continentId: ContinentId;
  readonly placementRegion: `aws:${string}`;
  readonly approximateAnchor: string;
  readonly workerName: `uptime-probe-${RegionId}`;
  readonly wranglerConfigBasename: `wrangler.${RegionId}.toml`;
  readonly chartSeriesToken: `--region-series-${number}`;
}

export const regions = [
  {
    id: 'us-east',
    label: 'US East (N. Virginia)',
    continentId: 'north-america',
    placementRegion: 'aws:us-east-1',
    approximateAnchor: 'Virginia, USA',
    workerName: 'uptime-probe-us-east',
    wranglerConfigBasename: 'wrangler.us-east.toml',
    chartSeriesToken: '--region-series-1',
  },
  {
    id: 'us-west',
    label: 'US West (Oregon)',
    continentId: 'north-america',
    placementRegion: 'aws:us-west-2',
    approximateAnchor: 'Oregon, USA',
    workerName: 'uptime-probe-us-west',
    wranglerConfigBasename: 'wrangler.us-west.toml',
    chartSeriesToken: '--region-series-2',
  },
  {
    id: 'canada-central',
    label: 'Canada Central (Montréal)',
    continentId: 'north-america',
    placementRegion: 'aws:ca-central-1',
    approximateAnchor: 'Montréal, Canada',
    workerName: 'uptime-probe-canada-central',
    wranglerConfigBasename: 'wrangler.canada-central.toml',
    chartSeriesToken: '--region-series-3',
  },
  {
    id: 'eu-west',
    label: 'Europe West (Ireland)',
    continentId: 'europe',
    placementRegion: 'aws:eu-west-1',
    approximateAnchor: 'Ireland',
    workerName: 'uptime-probe-eu-west',
    wranglerConfigBasename: 'wrangler.eu-west.toml',
    chartSeriesToken: '--region-series-4',
  },
  {
    id: 'eu-north',
    label: 'Europe North (Stockholm)',
    continentId: 'europe',
    placementRegion: 'aws:eu-north-1',
    approximateAnchor: 'Stockholm, Sweden',
    workerName: 'uptime-probe-eu-north',
    wranglerConfigBasename: 'wrangler.eu-north.toml',
    chartSeriesToken: '--region-series-5',
  },
  {
    id: 'eu-south',
    label: 'Europe South (Milan)',
    continentId: 'europe',
    placementRegion: 'aws:eu-south-1',
    approximateAnchor: 'Milan, Italy',
    workerName: 'uptime-probe-eu-south',
    wranglerConfigBasename: 'wrangler.eu-south.toml',
    chartSeriesToken: '--region-series-6',
  },
  {
    id: 'asia',
    label: 'Asia Southeast (Singapore)',
    continentId: 'asia',
    placementRegion: 'aws:ap-southeast-1',
    approximateAnchor: 'Singapore',
    workerName: 'uptime-probe-asia',
    wranglerConfigBasename: 'wrangler.asia.toml',
    chartSeriesToken: '--region-series-7',
  },
  {
    id: 'asia-east',
    label: 'Asia East (Tokyo)',
    continentId: 'asia',
    placementRegion: 'aws:ap-northeast-1',
    approximateAnchor: 'Tokyo, Japan',
    workerName: 'uptime-probe-asia-east',
    wranglerConfigBasename: 'wrangler.asia-east.toml',
    chartSeriesToken: '--region-series-8',
  },
  {
    id: 'asia-south',
    label: 'Asia South (Mumbai)',
    continentId: 'asia',
    placementRegion: 'aws:ap-south-1',
    approximateAnchor: 'Mumbai, India',
    workerName: 'uptime-probe-asia-south',
    wranglerConfigBasename: 'wrangler.asia-south.toml',
    chartSeriesToken: '--region-series-9',
  },
] as const satisfies readonly RegionDefinition[];

export const regionById = Object.freeze(
  Object.fromEntries(regions.map((region) => [region.id, region])),
) as Readonly<Record<RegionId, (typeof regions)[number]>>;

export const regionsByContinent = Object.freeze(
  Object.fromEntries(
    continentIds.map((continentId) => [
      continentId,
      Object.freeze(regions.filter((region) => region.continentId === continentId)),
    ]),
  ),
) as Readonly<Record<ContinentId, readonly (typeof regions)[number][]>>;

const regionIdSet: ReadonlySet<string> = new Set(regionIds);

export function isRegionId(value: string): value is RegionId {
  return regionIdSet.has(value);
}

export function findRegion(value: string): (typeof regions)[number] | undefined {
  return isRegionId(value) ? regionById[value] : undefined;
}

export function parseRegionList(value: string | undefined): RegionId[] {
  if (value === undefined || value.trim() === '') return [...regionIds];
  const parsed = value.split(',').map((entry) => entry.trim());
  if (parsed.some((entry) => entry === '')) {
    throw new Error('REGIONS_LIST must be a comma-separated list without empty entries');
  }
  const invalid = parsed.filter((entry) => !isRegionId(entry));
  if (invalid.length > 0) {
    throw new Error(`REGIONS_LIST contains unknown regions: ${[...new Set(invalid)].join(', ')}`);
  }
  const unique = [...new Set(parsed as RegionId[])];
  if (unique.length !== parsed.length) {
    throw new Error('REGIONS_LIST must not contain duplicate regions');
  }
  return unique;
}

export function regionsFromList(value: string | undefined): RegionDefinition[] {
  return parseRegionList(value).map((regionId) => regionById[regionId]);
}
