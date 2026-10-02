/**
 * WebCrypto-only crypto helpers shared by Workers.
 *
 * No `node:crypto` import so this module is safe in the Workers runtime.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function nowIso(date: Date = new Date()): string {
  return date.toISOString();
}

/** RFC 4122 v4 UUID generated from `crypto.getRandomValues`. */
export function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
    .slice(6, 8)
    .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

/** URL-safe random token with at least 128 bits of entropy. */
export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const data = typeof value === 'string' ? textEncoder.encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}

export async function hmacSha256Base64Url(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

/** Session cookie tokens are hashed with the server secret before storage. */
export function hashSessionToken(token: string, secret: string): Promise<string> {
  return hmacSha256Base64Url(secret, token);
}

/** Constant-time-ish comparison for short tokens once lengths match. */
export function timingSafeStringEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

const passwordHashAlgorithm = 'pbkdf2-sha256';
// workerd rejects PBKDF2 operations above 100,000 iterations under its default
// per-request crypto limits. Keep generated and accepted hashes within the
// runtime limit so a hash produced by the migration CLI is actually usable by
// the deployed Worker.
const passwordHashIterations = 100_000;
const passwordHashMaxIterations = 100_000;
const passwordSaltBytes = 16;
const passwordKeyBytes = 32;

/**
 * Workers cannot run argon2. New Cloudflare admin passwords use a PBKDF2-SHA256
 * PHC-like string: `pbkdf2-sha256$<iterations>$<salt-b64url>$<hash-b64url>`.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(passwordSaltBytes);
  crypto.getRandomValues(salt);
  const key = await derivePasswordKey(password, salt, passwordHashIterations);
  return `${passwordHashAlgorithm}$${passwordHashIterations}$${base64UrlEncode(
    salt,
  )}$${base64UrlEncode(key)}`;
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  const parts = hash.split('$');
  if (parts.length !== 4 || parts[0] !== passwordHashAlgorithm) return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > passwordHashMaxIterations) {
    return false;
  }
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = base64UrlDecode(parts[2]!);
    expected = base64UrlDecode(parts[3]!);
  } catch {
    return false;
  }
  if (salt.byteLength !== passwordSaltBytes || expected.byteLength !== passwordKeyBytes)
    return false;
  const key = await derivePasswordKey(password, salt, iterations);
  return timingSafeStringEqual(base64UrlEncode(key), base64UrlEncode(expected));
}

async function derivePasswordKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    keyMaterial,
    passwordKeyBytes * 8,
  );
  return new Uint8Array(bits);
}

export { base64UrlEncode, base64UrlDecode, textDecoder };
