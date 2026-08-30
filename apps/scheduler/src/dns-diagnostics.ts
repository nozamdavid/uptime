/** The daily policy is UTC-only, so host time zones cannot create duplicate snapshots. */
export function utcDayWindow(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

export function isSameUtcDay(left: Date, right: Date): boolean {
  return utcDayWindow(left).getTime() === utcDayWindow(right).getTime();
}
