/**
 * Canonical region ids, mirrored from `@uptime/regions`.
 *
 * This package deliberately declares the union locally so it has no workspace
 * dependency and requires no lockfile change. The union is structurally
 * identical to `RegionId` from `@uptime/regions`, so values are mutually
 * assignable. Keep this list in sync with `packages/regions/src/index.ts` and
 * the CHECK constraints in `migrations/0001_initial.sql`.
 */
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

const regionIdSet: ReadonlySet<string> = new Set(regionIds);

export function isRegionId(value: string): value is RegionId {
  return regionIdSet.has(value);
}
