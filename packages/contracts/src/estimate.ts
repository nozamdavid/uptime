import type { EstimateRequest, EstimateResponse } from './index.js';

const secondsPerDay = 86_400;

export function calculateTargetChecksPerDay(input: EstimateRequest): EstimateResponse {
  return {
    regionCount: input.regionIds.length,
    intervalSeconds: input.intervalSeconds,
    targetChecksPerDay: input.regionIds.length * (secondsPerDay / input.intervalSeconds),
    excludes: ['redirects', 'manual-checks'],
  };
}
