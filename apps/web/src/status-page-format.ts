export function formatPercentage(value: number | null) {
  return value === null ? '—' : `${Number(value.toFixed(3))}%`;
}

export function formatLatency(value: number | null) {
  return value === null ? '—' : `${Number(value.toFixed(2))}ms`;
}
