import { HttpErrorLike } from './http.js';

/** Decode a JSON column that may already be a parsed value (D1/migration rows). */
export function decodeStoredJson(value: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof value !== 'string') return { ok: true, value };
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}

export interface StoredJsonLog {
  warn: (bindings: Record<string, unknown>, message: string) => void;
}

export function base64UrlEncodeJson(value: unknown): string {
  const text = JSON.stringify(value);
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function base64UrlDecodeJson(value: string): unknown {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    // Invalid base64 is an invalid cursor, not an unhandled 500.
    throw invalidCursor();
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function invalidCursor(): HttpErrorLike {
  return new HttpErrorLike(400, 'invalid_cursor', 'Cursor is invalid');
}
