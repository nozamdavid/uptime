/** Return the UTC day containing the supplied timestamp. */
export function utcDayWindow(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

export function isSameUtcDay(left: Date, right: Date): boolean {
  return utcDayWindow(left).getTime() === utcDayWindow(right).getTime();
}
