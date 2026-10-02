export function monitorDisplayName(monitor: { name?: string | null; url: string }): string {
  return monitor.name?.trim() || new URL(monitor.url).hostname;
}

export function formatInterval(seconds: number): string {
  return seconds < 60 ? `${seconds}s` : `${seconds / 60} min`;
}
