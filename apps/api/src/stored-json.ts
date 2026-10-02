export type DecodedStoredJson = { ok: true; value: unknown } | { ok: false };

export function decodeStoredJson(value: unknown): DecodedStoredJson {
  if (typeof value !== 'string') return { ok: true, value };
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}
