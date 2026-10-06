/** Per-isolate request cache. Callers must check authorization before every lookup. */
export class MonitorRequestCache {
  private readonly entries = new Map<string, { expiresAt: number; value: unknown }>();

  async get<T>(key: string, load: () => Promise<T>, now = Date.now()): Promise<T> {
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > now) return structuredClone(cached.value) as T;
    this.entries.delete(key);
    const value = await load();
    // Bound memory without extending the lifetime of any cached request.
    if (this.entries.size >= 256) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { expiresAt: now + 60_000, value: structuredClone(value) });
    return value;
  }
}

export const monitorRequestCache = new MonitorRequestCache();
