/**
 * Exponential backoff with deterministic jitter, matching the notification
 * retry policy already used by the scheduler.
 */
export function jitteredBackoffSeconds(attempts: number, minimumSeconds = 30): number {
  const exponential = minimumSeconds * 2 ** Math.max(0, attempts - 1);
  return Math.min(3_600, exponential);
}

/** Split an array into bounded chunks for statement parameter limits. */
export function chunk<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
